import 'server-only';

import { cache } from 'react';
import { sql as drizzleSql } from 'drizzle-orm';
import { buildBoardRenderUrl } from '@/app/components/board-renderer/util';
import { boardToRouteParams, resolveBoardBySlug } from '@/app/lib/board-slug-utils';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
// All queries in this module are reads driving public OG image generation.
// Route them through the replica seam — falls back to primary when
// READ_REPLICA_URL is unset, so this is safe before a replica exists.
import { dbzRead as dbz, executeRows, getReadPool, rowsFromResult } from '@/app/lib/db/db';
import { formatBoardDisplayName } from '@/app/lib/string-utils';
import type { BoardDetails, BoardName, ParsedBoardRouteParameters } from '@/app/lib/types';
import { parseBoardRouteParamsWithSlugs } from '@/app/lib/url-utils.server';
import { buildOgVersionToken } from './og';

export type ProfileOgSummary = {
  displayName: string;
  avatarUrl: string | null;
  fallbackImageUrl: string | null;
  version: string;
};

export const getProfileOgSummary = cache(async (userId: string): Promise<ProfileOgSummary | null> => {
  const rawSql = getReadPool();
  const rows = rowsFromResult<{
    name: string | null;
    image: string | null;
    display_name: string | null;
    avatar_url: string | null;
    version_at: string | Date | null;
  }>(
    await rawSql`
    SELECT
      u.name,
      u.image,
      p.display_name,
      p.avatar_url,
      GREATEST(
        COALESCE(u.updated_at, to_timestamp(0)),
        COALESCE(p.updated_at, to_timestamp(0)),
        COALESCE((SELECT MAX(bt.updated_at) FROM boardsesh_ticks bt WHERE bt.user_id = ${userId}), to_timestamp(0))
      ) AS version_at
    FROM users u
    LEFT JOIN user_profiles p ON p.user_id = u.id
    WHERE u.id = ${userId}
    LIMIT 1
  `,
  );

  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    displayName: row.display_name || row.name || 'Crusher',
    avatarUrl: row.avatar_url || null,
    fallbackImageUrl: row.image || null,
    version: buildOgVersionToken(row.version_at),
  };
});

export type SetterOgSummary = {
  displayName: string;
  avatarUrl: string | null;
  version: string;
};

export const getSetterOgSummary = cache(async (username: string): Promise<SetterOgSummary> => {
  const result = await executeRows<{
    name: string | null;
    display_name: string | null;
    avatar_url: string | null;
    version_at: string | Date | null;
  }>(
    dbz,
    drizzleSql`
    SELECT
      profile.name,
      profile.display_name,
      profile.avatar_url,
      GREATEST(
        COALESCE(profile.user_updated_at, to_timestamp(0)),
        COALESCE(profile.profile_updated_at, to_timestamp(0)),
        COALESCE(
          (
            SELECT MAX(bt.updated_at)
            FROM boardsesh_ticks bt
            JOIN board_climbs bc ON bc.uuid = bt.climb_uuid AND bc.board_type = bt.board_type
            WHERE bc.setter_username = ${username}
          ),
          to_timestamp(0)
        ),
        COALESCE(
          (
            SELECT MAX(c.created_at::timestamp)
            FROM board_climbs c
            WHERE c.setter_username = ${username}
          ),
          to_timestamp(0)
        )
      ) AS version_at
    FROM (SELECT 1) AS seed
    LEFT JOIN (
      SELECT
        u.name,
        u.updated_at AS user_updated_at,
        p.display_name,
        p.avatar_url,
        p.updated_at AS profile_updated_at
      FROM user_board_mappings ubm
      JOIN users u ON u.id = ubm.user_id
      LEFT JOIN user_profiles p ON p.user_id = ubm.user_id
      WHERE ubm.board_username = ${username}
      LIMIT 1
    ) AS profile ON true
  `,
  );

  const row = result[0];

  return {
    displayName: row?.display_name || row?.name || username,
    avatarUrl: row?.avatar_url || null,
    version: buildOgVersionToken(row?.version_at),
  };
});

export type SessionOgGradeRow = {
  difficulty: number;
  count: number;
};

export type SessionOgSummary = {
  sessionType: 'party' | 'inferred' | null;
  sessionName: string;
  leaderName: string | null;
  participantNames: string[];
  participantCount: number;
  totalSends: number;
  gradeRows: SessionOgGradeRow[];
  boardLabel: string | null;
  boardAngle: number | null;
  boardPreviewPath: string | null;
  version: string;
  found: boolean;
};

type SessionBoardSeed = {
  boardPath: string | null;
  boardSlug: string | null;
  boardAngle: number | null;
  boardType: string | null;
  layoutId: number | null;
  sizeId: number | null;
  setIds: string | null;
};

function extractPathname(value: string): string {
  if (/^https?:\/\//i.test(value)) {
    try {
      return new URL(value).pathname;
    } catch {
      return value;
    }
  }

  return value;
}

function parseSetIdString(value: string | null): number[] {
  return (value ?? '')
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((part) => !Number.isNaN(part));
}

function formatBoardLabel(boardDetails: BoardDetails): string {
  const parts: string[] = [formatBoardDisplayName(boardDetails.board_name)];

  if (boardDetails.layout_name) {
    const layoutName = boardDetails.layout_name
      .replace(new RegExp(`^${boardDetails.board_name}\\s*(board)?\\s*`, 'i'), '')
      .trim();

    if (layoutName) {
      parts.push(layoutName);
    }
  }

  if (boardDetails.size_name) {
    const sizeMatch = boardDetails.size_name.match(/(\d+)\s*x\s*(\d+)/i);
    if (sizeMatch) {
      parts.push(`${sizeMatch[1]}x${sizeMatch[2]}`);
    } else {
      parts.push(boardDetails.size_name);
    }
  } else if (boardDetails.size_description) {
    parts.push(boardDetails.size_description);
  }

  return parts.join(' ');
}

async function resolveSessionBoardInfo(seed: SessionBoardSeed): Promise<{
  boardLabel: string;
  boardAngle: number | null;
  boardPreviewPath: string;
} | null> {
  const rawBoardPath = seed.boardPath?.trim();
  if (!rawBoardPath) {
    return null;
  }

  try {
    let parsedParams: ParsedBoardRouteParameters | null = null;
    let boardAngle = seed.boardAngle != null ? Number(seed.boardAngle) : null;

    if (seed.boardType && seed.layoutId != null && seed.sizeId != null) {
      const parsedSetIds = parseSetIdString(seed.setIds);
      if (parsedSetIds.length > 0) {
        parsedParams = {
          board_name: seed.boardType as BoardName,
          layout_id: Number(seed.layoutId),
          size_id: Number(seed.sizeId),
          set_ids: parsedSetIds,
          angle: boardAngle ?? 0,
        };
      }
    }

    const pathname = extractPathname(rawBoardPath);

    if (!parsedParams && pathname.startsWith('/b/')) {
      const parts = pathname.split('/').filter(Boolean);
      const boardSlug = seed.boardSlug?.trim() || parts[1] || '';
      const pathAngle = parts[2] ? Number(parts[2]) : Number.NaN;

      if (!Number.isNaN(pathAngle)) {
        boardAngle = pathAngle;
      }

      if (boardSlug) {
        const board = await resolveBoardBySlug(boardSlug);
        if (board) {
          if (boardAngle == null || Number.isNaN(boardAngle)) {
            boardAngle = board.angle;
          }
          parsedParams = boardToRouteParams(board, boardAngle ?? board.angle);
        }
      }
    }

    if (!parsedParams) {
      const parts = pathname.split('/').filter(Boolean);
      if (parts.length >= 4) {
        const maybeAngle = parts[4] ? Number(parts[4]) : Number.NaN;
        if (!Number.isNaN(maybeAngle)) {
          boardAngle = maybeAngle;
        }

        parsedParams = await parseBoardRouteParamsWithSlugs({
          board_name: parts[0],
          layout_id: parts[1],
          size_id: parts[2],
          set_ids: parts[3],
          angle: String(boardAngle ?? 0),
        });
      }
    }

    if (!parsedParams) {
      return null;
    }

    const boardDetails = getBoardDetailsForBoard(parsedParams);
    return {
      boardLabel: formatBoardLabel(boardDetails),
      boardAngle: boardAngle != null && !Number.isNaN(boardAngle) ? boardAngle : null,
      boardPreviewPath: buildBoardRenderUrl(boardDetails, '', {
        thumbnail: true,
        includeBackground: true,
        format: 'png',
      }),
    };
  } catch {
    return null;
  }
}

export const getSessionOgSummary = cache(async (sessionId: string): Promise<SessionOgSummary> => {
  let sessionType: 'party' | 'inferred' | null = null;
  let sessionRow:
    | {
        name: string | null;
        leader_name: string | null;
        version_at: string | Date | null;
        board_path: string | null;
        board_slug: string | null;
        board_angle: number | null;
        board_type: string | null;
        layout_id: number | null;
        size_id: number | null;
        set_ids: string | null;
      }
    | undefined;

  const partySessionResult = await executeRows<{
    name: string | null;
    leader_name: string | null;
    version_at: string | Date | null;
    board_path: string | null;
    board_slug: string | null;
    board_angle: number | null;
    board_type: string | null;
    layout_id: number | null;
    size_id: number | null;
    set_ids: string | null;
  }>(
    dbz,
    drizzleSql`
    SELECT
      bs.name,
      COALESCE(
        NULLIF(TRIM(live_leader.username), ''),
        NULLIF(TRIM(creator_profile.display_name), ''),
        NULLIF(TRIM(creator_user.name), '')
      ) AS leader_name,
      bs.board_path,
      ub.slug AS board_slug,
      ub.angle AS board_angle,
      ub.board_type,
      ub.layout_id,
      ub.size_id,
      ub.set_ids,
      GREATEST(
        COALESCE(bs.last_activity, to_timestamp(0)),
        COALESCE((SELECT MAX(bt.updated_at) FROM boardsesh_ticks bt WHERE bt.session_id = ${sessionId}), to_timestamp(0)),
        COALESCE((SELECT MAX(bsc.connected_at) FROM board_session_clients bsc WHERE bsc.session_id = ${sessionId}), to_timestamp(0))
      ) AS version_at
    FROM board_sessions bs
    LEFT JOIN LATERAL (
      SELECT bsc.username
      FROM board_session_clients bsc
      WHERE bsc.session_id = bs.id
        AND bsc.is_leader = true
        AND bsc.username IS NOT NULL
      ORDER BY bsc.connected_at DESC
      LIMIT 1
    ) AS live_leader ON true
    LEFT JOIN users creator_user ON creator_user.id = bs.created_by_user_id
    LEFT JOIN user_profiles creator_profile ON creator_profile.user_id = bs.created_by_user_id
    LEFT JOIN user_boards ub ON ub.id = bs.board_id
    WHERE bs.id = ${sessionId}
    LIMIT 1
  `,
  );

  if (partySessionResult[0]) {
    sessionType = 'party';
    sessionRow = partySessionResult[0];
  } else {
    const inferredSessionResult = await executeRows<{
      name: string | null;
      leader_name: string | null;
      version_at: string | Date | null;
      board_path: string | null;
      board_slug: string | null;
      board_angle: number | null;
      board_type: string | null;
      layout_id: number | null;
      size_id: number | null;
      set_ids: string | null;
    }>(
      dbz,
      drizzleSql`
      SELECT
        s.name,
        COALESCE(
          NULLIF(TRIM(up.display_name), ''),
          NULLIF(TRIM(u.name), '')
        ) AS leader_name,
        NULL::text AS board_path,
        NULL::text AS board_slug,
        NULL::bigint AS board_angle,
        NULL::text AS board_type,
        NULL::bigint AS layout_id,
        NULL::bigint AS size_id,
        NULL::text AS set_ids,
        GREATEST(
          COALESCE(s.last_tick_at, to_timestamp(0)),
          COALESCE(s.created_at, to_timestamp(0)),
          COALESCE((SELECT MAX(bt.updated_at) FROM boardsesh_ticks bt WHERE bt.inferred_session_id = ${sessionId}), to_timestamp(0))
        ) AS version_at
      FROM inferred_sessions s
      LEFT JOIN users u ON u.id = s.user_id
      LEFT JOIN user_profiles up ON up.user_id = s.user_id
      WHERE s.id = ${sessionId}
      LIMIT 1
    `,
    );

    if (inferredSessionResult[0]) {
      sessionType = 'inferred';
      sessionRow = inferredSessionResult[0];
    }
  }

  if (!sessionType || !sessionRow) {
    return {
      sessionType: null,
      sessionName: 'Climbing Session',
      leaderName: null,
      participantNames: [],
      participantCount: 0,
      totalSends: 0,
      gradeRows: [],
      boardLabel: null,
      boardAngle: null,
      boardPreviewPath: null,
      version: buildOgVersionToken(null),
      found: false,
    };
  }

  const tickWhereClause =
    sessionType === 'party'
      ? drizzleSql`bt.session_id = ${sessionId}`
      : drizzleSql`bt.inferred_session_id = ${sessionId}`;

  const [participantCountResult, participantResult, totalSendsResult, gradeResult, boardInfo] = await Promise.all([
    executeRows<{
      participant_count: number;
    }>(
      dbz,
      drizzleSql`
      SELECT COUNT(DISTINCT bt.user_id)::int as participant_count
      FROM boardsesh_ticks bt
      WHERE ${tickWhereClause}
    `,
    ),
    executeRows<{
      display_name: string;
    }>(
      dbz,
      drizzleSql`
      SELECT DISTINCT
        COALESCE(up.display_name, u.name, 'Climber') as display_name
      FROM boardsesh_ticks bt
      JOIN users u ON u.id = bt.user_id
      LEFT JOIN user_profiles up ON up.user_id = bt.user_id
      WHERE ${tickWhereClause}
      LIMIT 6
    `,
    ),
    executeRows<{
      total_sends: number;
    }>(
      dbz,
      drizzleSql`
      SELECT COUNT(*)::int as total_sends
      FROM boardsesh_ticks bt
      WHERE ${tickWhereClause}
        AND bt.status IN ('flash', 'send')
    `,
    ),
    executeRows<{
      difficulty: number;
      cnt: number;
    }>(
      dbz,
      drizzleSql`
      SELECT
        COALESCE(bt.difficulty, ROUND(bcs.display_difficulty)::int) as difficulty,
        COUNT(*) as cnt
      FROM boardsesh_ticks bt
      LEFT JOIN board_climb_stats bcs
        ON bcs.climb_uuid = bt.climb_uuid
        AND bcs.board_type = bt.board_type
        AND bcs.angle = bt.angle
      WHERE ${tickWhereClause}
        AND bt.status IN ('flash', 'send')
        AND COALESCE(bt.difficulty, ROUND(bcs.display_difficulty)::int) IS NOT NULL
      GROUP BY COALESCE(bt.difficulty, ROUND(bcs.display_difficulty)::int)
      ORDER BY COALESCE(bt.difficulty, ROUND(bcs.display_difficulty)::int)
    `,
    ),
    resolveSessionBoardInfo({
      boardPath: sessionRow.board_path,
      boardSlug: sessionRow.board_slug,
      boardAngle: sessionRow.board_angle != null ? Number(sessionRow.board_angle) : null,
      boardType: sessionRow.board_type,
      layoutId: sessionRow.layout_id != null ? Number(sessionRow.layout_id) : null,
      sizeId: sessionRow.size_id != null ? Number(sessionRow.size_id) : null,
      setIds: sessionRow.set_ids,
    }),
  ]);

  const gradeRows = gradeResult.map((row) => ({
    difficulty: Number(row.difficulty),
    count: Number(row.cnt),
  }));

  return {
    sessionType,
    sessionName: sessionRow.name || 'Climbing Session',
    leaderName: sessionRow.leader_name || null,
    participantNames: participantResult.map((row) => row.display_name),
    participantCount: Number(participantCountResult[0]?.participant_count || 0),
    totalSends: Number(totalSendsResult[0]?.total_sends || 0),
    gradeRows,
    boardLabel: boardInfo?.boardLabel || null,
    boardAngle: boardInfo?.boardAngle ?? null,
    boardPreviewPath: boardInfo?.boardPreviewPath || null,
    version: buildOgVersionToken(sessionRow.version_at),
    found: true,
  };
});

export type PlaylistOgSummary = {
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  isPublic: boolean;
  boardType: string;
  climbCount: number;
  version: string;
};

export const getPlaylistOgSummary = cache(async (playlistUuid: string): Promise<PlaylistOgSummary | null> => {
  const rawSql = getReadPool();
  const rows = rowsFromResult<{
    name: string | null;
    description: string | null;
    color: string | null;
    icon: string | null;
    is_public: boolean;
    board_type: string;
    climb_count: number;
    version_at: string | Date | null;
  }>(
    await rawSql`
    SELECT
      p.name,
      p.description,
      p.color,
      p.icon,
      p.is_public,
      p.board_type,
      p.updated_at AS version_at,
      COALESCE((SELECT COUNT(*)::int FROM playlist_climbs pc WHERE pc.playlist_id = p.id), 0) as climb_count
    FROM playlists p
    WHERE p.uuid = ${playlistUuid}
    LIMIT 1
  `,
  );

  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    name: row.name || 'Playlist',
    description: row.description,
    color: row.color,
    icon: row.icon,
    isPublic: row.is_public,
    boardType: row.board_type,
    climbCount: Number(row.climb_count),
    version: buildOgVersionToken(row.version_at),
  };
});
