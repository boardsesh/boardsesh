import 'server-only';
import type { BoardName, ParsedBoardRouteParameters } from '@/app/lib/types';
import { cache } from 'react';
import { parseBoardPath, parseNamedBoardPath, toBoardName } from '@boardsesh/board-config';
import { BOARD_TYPES } from '@boardsesh/profile-stats';
import { BOULDER_GRADES } from '@/app/lib/board-data';
import { buildBoardRenderUrl } from '@/app/components/board-renderer/util';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import { detectLocale } from '@/app/lib/i18n/detect-locale';
import { parseBoardRouteParamsWithSlugs } from '@/app/lib/url-utils.server';
import { executeGraphQLInternal } from '@/app/lib/graphql/server-cached-client';
import { formatBoardDisplayName } from '@/app/lib/string-utils';
import { buildOgVersionToken } from './og';

// Public previews use the same anonymous backend authorization as public reads.
// React cache deduplicates only within this request; no authorization survives it.
export type ProfileOgSummary = {
  displayName: string;
  avatarUrl: string | null;
  fallbackImageUrl: string | null;
  /**
   * Board this climber has logged the most ticks on, or null when they have
   * none. Drives the search-first page title ("Marco's Kilter Sessions") — a
   * bare "Marco | Boardsesh" matches nothing anyone types into Google.
   */
  topBoardType: string | null;
  version: string;
  gradeRows: Array<{ difficulty: number; cnt: number }>;
};

export const getProfileOgSummary = cache(async (userId: string): Promise<ProfileOgSummary | null> => {
  const { publicProfile } = await executeGraphQLInternal<{
    publicProfile: {
      displayName: string | null;
      avatarUrl: string | null;
      isPrivate: boolean;
    } | null;
  }>(
    `query ProfilePreview($userId: ID!) {
    publicProfile(userId: $userId) { displayName avatarUrl isPrivate }
  }`,
    { userId },
  );
  if (!publicProfile || publicProfile.isPrivate) return null;
  const ticksByBoard = await Promise.all(
    BOARD_TYPES.map(async (boardType) => {
      const response = await executeGraphQLInternal<{
        userTicks: Array<{
          climbUuid: string;
          difficulty: number | null;
          status: string;
          climbedAt: string;
        }>;
      }>(
        `query ProfilePreviewTicks($userId: ID!, $boardType: String!) {
      userTicks(userId: $userId, boardType: $boardType) { climbUuid difficulty status climbedAt }
    }`,
        { userId, boardType },
      );
      return { boardType, ticks: response.userTicks };
    }),
  );
  const grades = new Map<number, Set<string>>();
  let latest: string | null = null;
  for (const { boardType, ticks } of ticksByBoard) {
    for (const tick of ticks) {
      if (!latest || tick.climbedAt > latest) latest = tick.climbedAt;
      if (tick.difficulty === null || !['send', 'flash'].includes(tick.status)) continue;
      const climbs = grades.get(tick.difficulty) ?? new Set<string>();
      climbs.add(`${boardType}:${tick.climbUuid}`);
      grades.set(tick.difficulty, climbs);
    }
  }
  ticksByBoard.sort((first, second) => second.ticks.length - first.ticks.length);
  return {
    displayName: publicProfile.displayName || 'Crusher',
    avatarUrl: publicProfile.avatarUrl,
    fallbackImageUrl: null,
    topBoardType: ticksByBoard[0]?.ticks.length ? ticksByBoard[0].boardType : null,
    version: buildOgVersionToken(latest),
    gradeRows: [...grades].map(([difficulty, climbs]) => ({ difficulty, cnt: climbs.size })),
  };
});

export type SetterOgSummary = {
  displayName: string;
  avatarUrl: string | null;
  version: string;
};

export const getSetterOgSummary = cache(async (username: string): Promise<SetterOgSummary | null> => {
  const { setterProfile } = await executeGraphQLInternal<{
    setterProfile: {
      climbCount: number;
      linkedUserDisplayName: string | null;
      linkedUserAvatarUrl: string | null;
    } | null;
  }>(
    `query SetterPreview($input: SetterProfileInput!) {
    setterProfile(input: $input) { climbCount linkedUserDisplayName linkedUserAvatarUrl }
  }`,
    { input: { username } },
  );
  if (!setterProfile?.climbCount) return null;
  return {
    displayName: setterProfile.linkedUserDisplayName || username,
    avatarUrl: setterProfile.linkedUserAvatarUrl,
    version: buildOgVersionToken(null),
  };
});

export type SessionOgGradeRow = {
  difficulty: number;
  count: number;
};

export type SessionOgSummary = {
  sessionType: 'party' | null;
  sessionName: string;
  leaderName: string | null;
  participantNames: string[];
  participantCount: number;
  totalSends: number;
  gradeRows: SessionOgGradeRow[];
  boardType: BoardName | null;
  boardLabel: string | null;
  boardAngle: number | null;
  boardPreviewPath: string | null;
  version: string;
  found: boolean;
};

async function resolvePublicSessionBoard(boardPath: string | null | undefined): Promise<{
  boardType: BoardName;
  boardLabel: string;
  boardAngle: number | null;
  boardPreviewPath: string;
} | null> {
  if (!boardPath?.trim()) return null;
  try {
    const pathname = /^https?:\/\//i.test(boardPath) ? new URL(boardPath).pathname : boardPath;
    const namedPath = parseNamedBoardPath(pathname);
    let parsedParams: ParsedBoardRouteParameters;
    let boardAngle: number | null;
    if (namedPath) {
      // Resolve the current slug anonymously, even when the page viewer is signed in.
      // A masked board stays generic; never reuse a session's previous saved board.
      const { boardBySlug } = await executeGraphQLInternal<{
        boardBySlug: {
          boardType: string;
          layoutId: number;
          sizeId: number;
          setIds: string;
          angle: number;
          isPublic: boolean;
        } | null;
      }>(
        `query SessionPreviewBoard($slug: String!) {
          boardBySlug(slug: $slug) { boardType layoutId sizeId setIds angle isPublic }
        }`,
        { slug: namedPath.slug },
      );
      const boardType = toBoardName(boardBySlug?.boardType);
      if (!boardBySlug?.isPublic || !boardType) return null;
      const setIds = boardBySlug.setIds.split(',').map(Number);
      if (setIds.length === 0 || setIds.some((setId) => !Number.isFinite(setId))) return null;
      boardAngle = namedPath.angle ?? boardBySlug.angle;
      parsedParams = {
        board_name: boardType,
        layout_id: boardBySlug.layoutId,
        size_id: boardBySlug.sizeId,
        set_ids: setIds,
        angle: boardAngle,
      };
    } else {
      const positionalPath = parseBoardPath(pathname);
      const { strippedPath } = detectLocale(pathname.startsWith('/') ? pathname : `/${pathname}`);
      const segments = strippedPath.split('/').filter(Boolean);
      if (segments.length < 4) return null;
      boardAngle = positionalPath?.angle ?? (segments[4] ? Number(segments[4]) : null);
      if (boardAngle !== null && !Number.isFinite(boardAngle)) return null;
      parsedParams = await parseBoardRouteParamsWithSlugs({
        board_name: positionalPath?.boardName ?? segments[0],
        layout_id: positionalPath ? String(positionalPath.layoutId) : segments[1],
        size_id: positionalPath ? String(positionalPath.sizeId) : segments[2],
        set_ids: positionalPath?.setIds ?? segments[3],
        angle: String(boardAngle ?? 0),
      });
    }
    const boardDetails = getBoardDetailsForBoard(parsedParams);
    const layoutName = boardDetails.layout_name
      ?.replace(new RegExp(`^${boardDetails.board_name}\\s*(board)?\\s*`, 'i'), '')
      .trim();
    const sizeMatch = boardDetails.size_name?.match(/(\d+)\s*x\s*(\d+)/i);
    const sizeLabel = sizeMatch
      ? `${sizeMatch[1]}x${sizeMatch[2]}`
      : boardDetails.size_name || boardDetails.size_description;
    return {
      boardType: boardDetails.board_name,
      boardLabel: [formatBoardDisplayName(boardDetails.board_name), layoutName, sizeLabel].filter(Boolean).join(' '),
      boardAngle,
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
  const empty: SessionOgSummary = {
    sessionType: null,
    sessionName: 'Climbing Session',
    leaderName: null,
    participantNames: [],
    participantCount: 0,
    totalSends: 0,
    gradeRows: [],
    boardType: null,
    boardLabel: null,
    boardAngle: null,
    boardPreviewPath: null,
    version: buildOgVersionToken(null),
    found: false,
  };
  const { sessionDetail, session } = await executeGraphQLInternal<{
    sessionDetail: {
      sessionName: string | null;
      totalSends: number;
      lastTickAt: string;
      boardTypes: string[];
      gradeDistribution: Array<{ grade: string; flash: number; send: number }>;
      participants: Array<{ displayName: string | null }>;
    } | null;
    session: {
      name: string | null;
      boardPath: string;
      startedAt: string | null;
      users: Array<{ userId: string | null; username: string; isLeader: boolean }>;
    } | null;
  }>(
    `query SessionPreview($sessionId: ID!) {
    sessionDetail(sessionId: $sessionId) {
      sessionName totalSends lastTickAt boardTypes
      gradeDistribution { grade flash send }
      participants { displayName }
    }
    session(sessionId: $sessionId) { name boardPath startedAt users { userId username isLeader } }
  }`,
    { sessionId },
  );
  if (!sessionDetail && !session) return empty;
  const currentBoard = await resolvePublicSessionBoard(session?.boardPath);
  const participantNames = sessionDetail
    ? sessionDetail.participants.flatMap((participant) => (participant.displayName ? [participant.displayName] : []))
    : (session?.users ?? []).flatMap((participant) => (participant.userId ? [participant.username] : []));
  const gradeRows = (sessionDetail?.gradeDistribution ?? []).flatMap((row) => {
    const grade = BOULDER_GRADES.find(
      (candidate) =>
        candidate.difficulty_name.toLowerCase() === row.grade.toLowerCase() ||
        candidate.font_grade.toLowerCase() === row.grade.split('/')[0].toLowerCase(),
    );
    return grade && row.flash + row.send > 0 ? [{ difficulty: grade.difficulty_id, count: row.flash + row.send }] : [];
  });
  return {
    ...empty,
    sessionType: 'party',
    found: true,
    sessionName: sessionDetail?.sessionName || session?.name || empty.sessionName,
    leaderName: session?.users.find((participant) => participant.userId && participant.isLeader)?.username ?? null,
    participantNames,
    participantCount: Math.max(sessionDetail?.participants.length ?? 0, session?.users.length ?? 0),
    totalSends: sessionDetail?.totalSends ?? 0,
    gradeRows,
    boardType: currentBoard?.boardType ?? null,
    boardLabel:
      currentBoard?.boardLabel ??
      (session?.boardPath ? null : sessionDetail?.boardTypes.map(formatBoardDisplayName).join(', ') || null),
    boardAngle: currentBoard?.boardAngle ?? null,
    boardPreviewPath: currentBoard?.boardPreviewPath ?? null,
    version: buildOgVersionToken(sessionDetail?.lastTickAt ?? session?.startedAt ?? null),
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
  const { playlist } = await executeGraphQLInternal<{
    playlist: (Omit<PlaylistOgSummary, 'version'> & { updatedAt: string }) | null;
  }>(
    `
    query PlaylistPreview($playlistId: ID!) {
      playlist(playlistId: $playlistId) { name description color icon isPublic boardType climbCount updatedAt }
    }`,
    { playlistId: playlistUuid },
  );
  if (!playlist) return null;
  return { ...playlist, version: buildOgVersionToken(playlist.updatedAt) };
});
