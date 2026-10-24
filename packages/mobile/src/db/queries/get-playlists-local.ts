import {
  canServeLocalUserData,
  getLocalUserId,
  isScopeDownloadComplete,
  parseOfflineBoardKey,
  type OfflineDatabase,
  type SqlValue,
  type OfflineBoardScope,
} from '@boardsesh/offline-sync';
import { isSizeScopedBoard } from '@boardsesh/board-config';
import { PLAYLIST_SORT_DEFAULT_ORDER } from '@boardsesh/climb-filters';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';
import type {
  Playlist,
  GetAllUserPlaylistsInput,
  GetAllUserPlaylistsQueryResponse,
  GetUserPlaylistsInput,
  GetUserPlaylistsQueryResponse,
  GetPlaylistQueryResponse,
  GetPlaylistsForClimbInput,
  GetPlaylistsForClimbQueryResponse,
  GetPlaylistsForClimbsInput,
  GetPlaylistsForClimbsQueryResponse,
  GetPlaylistClimbsInput,
  GetPlaylistClimbsQueryResponse,
  PlaylistSettersInput,
  GetPlaylistSettersQueryResponse,
} from '@boardsesh/graphql/operations/playlists';
import {
  buildJoinAndWhere,
  isOfflineSearchSupported,
  mapRowToClimb,
  MY_GRADE_SUBQUERY,
  parseCompatibleSizeIds,
  parseSetIds,
  RANDOM_ORDER_EXPR,
  sortColumnSql,
  type LocalClimbRow,
} from './search-climbs-local';
import { canReadFollowedAuthors, followedAuthorsLocalCondition } from './followed-authors-local';

type PlaylistRow = {
  uuid: string;
  board_type: string;
  layout_id: number | null;
  name: string;
  description: string | null;
  is_public: number | null;
  color: string | null;
  icon: string | null;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  climb_count: number;
};

type SqlFragment = { sql: string; binds: SqlValue[] };
type ActiveBoard = { boardName: string; layoutId?: number; sizeId?: number; setIds?: string; angle?: number };
export type PlaylistLocalUnavailableReason = 'user_data_unavailable' | 'board_not_downloaded' | 'filter_unsupported';

/** A declined gate is null, never a made-up empty playlist/library. */
async function withOwner<Response>(
  db: OfflineDatabase,
  viewerId: string,
  read: () => Promise<Response | null>,
): Promise<Response | null> {
  if (!(await canServeLocalUserData(db, viewerId)) || (await getLocalUserId(db)) !== viewerId) return null;
  const response = await read();
  return (await canServeLocalUserData(db, viewerId)) && (await getLocalUserId(db)) === viewerId ? response : null;
}

function mapPlaylist(row: PlaylistRow): Playlist {
  return {
    // SQLite stores UUIDs, not the server's numeric IDs. Every playlist write
    // accepts the UUID; using it here also keeps picker and detail IDs aligned.
    id: row.uuid,
    uuid: row.uuid,
    boardType: row.board_type,
    layoutId: row.layout_id,
    name: row.name,
    description: row.description ?? undefined,
    isPublic: row.is_public === 1,
    color: row.color ?? undefined,
    icon: row.icon ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessedAt: row.last_accessed_at,
    climbCount: Number(row.climb_count),
    // Only owned playlists sync. Pins and follower aggregates do not sync;
    // these offline defaults are replaced by the next network answer.
    userRole: 'owner',
    followerCount: 0,
    isFollowedByMe: false,
    isPinnedByMe: false,
  };
}

const PLAYLIST_SELECT = `SELECT p.*, (SELECT COUNT(*) FROM playlist_climbs pc WHERE pc.playlist_uuid = p.uuid) AS climb_count FROM playlists p`;
// The server's numeric ID is not mirrored. UUID is the stable offline tie-break.
const PLAYLIST_ORDER = 'ORDER BY COALESCE(p.last_accessed_at, p.updated_at) DESC, p.uuid DESC';

function playlistScope(input: { boardType?: string; layoutId?: number }): SqlFragment {
  const clauses: string[] = [];
  const binds: SqlValue[] = [];
  if (input.boardType) {
    clauses.push('p.board_type = ?');
    binds.push(input.boardType);
  }
  if (input.layoutId != null) {
    clauses.push('(p.layout_id = ? OR p.layout_id IS NULL)');
    binds.push(input.layoutId);
  }
  return { sql: clauses.length ? clauses.join(' AND ') : '1 = 1', binds };
}

export async function getAllUserPlaylistsLocal(
  db: OfflineDatabase,
  input: GetAllUserPlaylistsInput,
  viewerId: string,
): Promise<GetAllUserPlaylistsQueryResponse | null> {
  return withOwner(db, viewerId, async () => {
    const scope = playlistScope(input);
    const page = input.page ?? 0;
    const pageSize = input.pageSize ?? 20;
    const count = await db.getFirstAsync<{ total: number }>(
      `SELECT COUNT(*) AS total FROM playlists p WHERE ${scope.sql}`,
      scope.binds,
    );
    const rows = await db.getAllAsync<PlaylistRow>(
      `${PLAYLIST_SELECT} WHERE ${scope.sql} ${PLAYLIST_ORDER} LIMIT ? OFFSET ?`,
      [...scope.binds, pageSize + 1, page * pageSize],
    );
    return {
      allUserPlaylists: {
        playlists: rows.slice(0, pageSize).map(mapPlaylist),
        totalCount: Number(count?.total ?? 0),
        hasMore: rows.length > pageSize,
      },
    };
  });
}

export async function getUserPlaylistsLocal(
  db: OfflineDatabase,
  input: GetUserPlaylistsInput,
  viewerId: string,
): Promise<GetUserPlaylistsQueryResponse | null> {
  return withOwner(db, viewerId, async () => {
    const scope = playlistScope(input);
    const rows = await db.getAllAsync<PlaylistRow>(
      `${PLAYLIST_SELECT} WHERE ${scope.sql} ${PLAYLIST_ORDER}`,
      scope.binds,
    );
    return { userPlaylists: rows.map(mapPlaylist) };
  });
}

export async function getPlaylistLocal(
  db: OfflineDatabase,
  playlistId: string,
  viewerId: string,
): Promise<GetPlaylistQueryResponse | null> {
  return withOwner(db, viewerId, async () => {
    const row = await db.getFirstAsync<PlaylistRow>(`${PLAYLIST_SELECT} WHERE p.uuid = ?`, [playlistId]);
    // A public playlist that isn't owned/synced must ask the server, rather
    // than becoming an authoritative "not found" in the query cache.
    return row ? { playlist: mapPlaylist(row) } : null;
  });
}

export async function getPlaylistsForClimbsLocal(
  db: OfflineDatabase,
  input: GetPlaylistsForClimbsInput,
  viewerId: string,
): Promise<GetPlaylistsForClimbsQueryResponse | null> {
  return withOwner(db, viewerId, async () => {
    const memberships = new Map<string, string[]>();
    const climbUuids = [...new Set(input.climbUuids)];
    const scope = playlistScope(input);
    for (let start = 0; start < climbUuids.length; start += 400) {
      const chunk = climbUuids.slice(start, start + 400);
      const rows = await db.getAllAsync<{ climb_uuid: string; playlist_uuid: string }>(
        `SELECT pc.climb_uuid, pc.playlist_uuid FROM playlist_climbs pc JOIN playlists p ON p.uuid = pc.playlist_uuid
         WHERE ${scope.sql} AND pc.climb_uuid IN (${chunk.map(() => '?').join(', ')}) ORDER BY pc.climb_uuid, pc.playlist_uuid`,
        [...scope.binds, ...chunk],
      );
      for (const row of rows) {
        const existing = memberships.get(row.climb_uuid);
        if (existing) existing.push(row.playlist_uuid);
        else memberships.set(row.climb_uuid, [row.playlist_uuid]);
      }
    }
    return { playlistsForClimbs: [...memberships].map(([climbUuid, playlistUuids]) => ({ climbUuid, playlistUuids })) };
  });
}

export async function getPlaylistsForClimbLocal(
  db: OfflineDatabase,
  input: GetPlaylistsForClimbInput,
  viewerId: string,
): Promise<GetPlaylistsForClimbQueryResponse | null> {
  const response = await getPlaylistsForClimbsLocal(db, { ...input, climbUuids: [input.climbUuid] }, viewerId);
  return response ? { playlistsForClimb: response.playlistsForClimbs[0]?.playlistUuids ?? [] } : null;
}

function activeBoardOf(input: GetPlaylistClimbsInput): ActiveBoard | null {
  const boardName = input.boardName ?? input.activeBoardName;
  if (!boardName) return null;
  return input.boardName
    ? { boardName, layoutId: input.layoutId, sizeId: input.sizeId, setIds: input.setIds, angle: input.angle }
    : {
        boardName,
        layoutId: input.activeLayoutId,
        sizeId: input.activeSizeId,
        setIds: input.activeSetIds,
        angle: input.activeAngle,
      };
}

function filterInputs(input: GetPlaylistClimbsInput) {
  const board = activeBoardOf(input);
  const completeBoard = board?.layoutId != null && board.angle != null ? board : null;
  const {
    hideAttempted,
    hideCompleted,
    showOnlyAttempted,
    showOnlyCompleted,
    minUserRating,
    onlyRatedByMe,
    onlyFavorited,
    onlyFollowedAuthors,
    onlyWithBetaVideos,
    onlyTallClimbs,
    onlyWideClimbs,
    holdsFilter,
    zoneBox,
    onlyActiveBoard,
    sortBy: _sortBy,
    sortOrder: _sortOrder,
    sortSeed: _sortSeed,
    ...allRows
  } = input.view ?? {};
  const base: ClimbSearchInput = {
    boardName: completeBoard?.boardName ?? 'kilter',
    layoutId: completeBoard?.layoutId ?? 0,
    sizeId: completeBoard?.sizeId ?? 0,
    setIds: completeBoard?.setIds ?? '',
    angle: completeBoard?.angle ?? 0,
  };
  const personalGrades =
    !!completeBoard &&
    !!allRows.useMyGrades &&
    (!!allRows.minGrade || !!allRows.maxGrade || input.view?.sortBy === 'difficulty');
  const globalInput: ClimbSearchInput = { ...base, ...allRows, useMyGrades: personalGrades };
  const activeInput: ClimbSearchInput = {
    ...base,
    hideAttempted,
    hideCompleted,
    showOnlyAttempted,
    showOnlyCompleted,
    minUserRating,
    onlyRatedByMe,
    onlyFavorited,
    onlyFollowedAuthors,
    onlyWithBetaVideos,
    onlyTallClimbs,
    onlyWideClimbs,
    holdsFilter,
    zoneBox,
  };
  const activeFilter = Object.entries(activeInput).some(
    ([key, field]) =>
      !(key in base) && (field !== null && typeof field === 'object' ? Object.keys(field).length > 0 : !!field),
  );
  return {
    board: completeBoard,
    globalInput,
    activeInput,
    personalGrades,
    needsActiveBoard: !!onlyActiveBoard || activeFilter,
  };
}

/** Playlist geometry deliberately accepts NULL required sets, unlike catalogue search. */
function boardScope(board: ActiveBoard): SqlFragment {
  const clauses = ['c.board_type = ?'];
  const binds: SqlValue[] = [board.boardName];
  if (board.layoutId != null) {
    clauses.push('c.layout_id = ?');
    binds.push(board.layoutId);
  }
  if (board.sizeId != null && isSizeScopedBoard(board.boardName)) {
    clauses.push('EXISTS (SELECT 1 FROM json_each(c.compatible_size_ids) WHERE value = ?)');
    binds.push(board.sizeId);
  }
  const setIds = parseSetIds(board.setIds);
  if (setIds.length) {
    clauses.push(
      `(c.required_set_ids IS NULL OR NOT EXISTS (SELECT 1 FROM json_each(c.required_set_ids) WHERE value NOT IN (${setIds.map(() => '?').join(', ')})))`,
    );
    binds.push(...setIds);
  }
  return { sql: clauses.join(' AND '), binds };
}

type CoverageRow = {
  uuid: string | null;
  board_type: string | null;
  layout_id: number | null;
  compatible_size_ids: string | null;
};

async function completePlaylistCoverage(db: OfflineDatabase, playlistId: string, viewerId: string): Promise<boolean> {
  const rows = await db.getAllAsync<CoverageRow>(
    `SELECT c.uuid, c.board_type, c.layout_id, c.compatible_size_ids FROM playlist_climbs pc
     LEFT JOIN board_climbs c ON c.uuid = pc.climb_uuid WHERE pc.playlist_uuid = ?
       AND (c.uuid IS NULL OR COALESCE(c.is_draft, 0) = 0 OR c.user_id = ?)`,
    [playlistId, viewerId],
  );
  if (!rows.length) return true;
  if (rows.some((row) => !row.uuid || !row.board_type || row.layout_id == null)) return false;
  // Read settings once and probe each downloaded scope once, rather than one
  // asynchronous scope probe per climb in a long playlist.
  const { getSetting } = await import('../../settings/hooks');
  const scopes: OfflineBoardScope[] = [];
  for (const scopeKey of getSetting('syncEnabledBoards')) {
    const scope = parseOfflineBoardKey(scopeKey);
    if (scope && (await isScopeDownloadComplete(db, scopeKey))) scopes.push(scope);
  }
  return rows.every((row) =>
    scopes.some(
      (scope) =>
        scope.boardType === row.board_type &&
        scope.layoutId === row.layout_id &&
        (!isSizeScopedBoard(scope.boardType) ||
          (parseCompatibleSizeIds(row.compatible_size_ids) ?? []).includes(scope.sizeId)),
    ),
  );
}

export async function getPlaylistReadUnavailableReason(
  db: OfflineDatabase,
  input: GetPlaylistClimbsInput,
  viewerId: string,
): Promise<PlaylistLocalUnavailableReason | null> {
  if (!(await canServeLocalUserData(db, viewerId))) return 'user_data_unavailable';
  if (!(await db.getFirstAsync('SELECT uuid FROM playlists WHERE uuid = ?', [input.playlistId])))
    return 'user_data_unavailable';
  const filters = filterInputs(input);
  if (filters.board && !isOfflineSearchSupported(filters.activeInput)) return 'filter_unsupported';
  if (filters.board && filters.activeInput.onlyFollowedAuthors && !(await canReadFollowedAuthors(db)))
    return 'user_data_unavailable';
  return (await completePlaylistCoverage(db, input.playlistId, viewerId)) ? null : 'board_not_downloaded';
}

export async function canServePlaylistClimbsLocal(
  db: OfflineDatabase,
  input: GetPlaylistClimbsInput,
  viewerId: string,
): Promise<boolean> {
  return (await getPlaylistReadUnavailableReason(db, input, viewerId)) === null;
}

export async function canServePlaylistSettersLocal(
  db: OfflineDatabase,
  input: PlaylistSettersInput,
  viewerId: string,
): Promise<boolean> {
  return (
    !!input.playlistId && (await canServePlaylistClimbsLocal(db, { ...input, playlistId: input.playlistId }, viewerId))
  );
}

function playlistBase(input: GetPlaylistClimbsInput, viewerId: string): SqlFragment {
  const preferred: SqlFragment =
    input.boardName && input.angle != null
      ? { sql: '?', binds: [input.angle] }
      : input.activeBoardName != null && input.activeAngle != null
        ? {
            sql: 'CASE WHEN c.board_type = ? THEN ? ELSE pc.angle END',
            binds: [input.activeBoardName, input.activeAngle],
          }
        : { sql: 'pc.angle', binds: [] };
  const scope = input.boardName
    ? boardScope({ boardName: input.boardName, layoutId: input.layoutId, sizeId: input.sizeId, setIds: input.setIds })
    : { sql: '1 = 1', binds: [] };
  return {
    sql: `WITH playlist_members AS (
      SELECT c.*, pc.position, pc.added_at AS playlist_added_at, pc.angle AS playlist_angle,
        ${preferred.sql} AS preferred_angle
      FROM playlist_climbs pc JOIN board_climbs c ON c.uuid = pc.climb_uuid
      WHERE pc.playlist_uuid = ? AND (COALESCE(c.is_draft, 0) = 0 OR c.user_id = ?) AND ${scope.sql}
    )`,
    binds: [...preferred.binds, input.playlistId, viewerId, ...scope.binds],
  };
}

const PLAYLIST_STATS_JOIN = `LEFT JOIN board_climb_stats s
  ON s.climb_uuid = c.uuid AND s.board_type = c.board_type AND s.angle = COALESCE(
    (SELECT c.preferred_angle WHERE EXISTS (SELECT 1 FROM board_climb_stats preferred
      WHERE preferred.board_type = c.board_type AND preferred.climb_uuid = c.uuid AND preferred.angle = c.preferred_angle)),
    (SELECT fallback.angle FROM board_climb_stats fallback WHERE fallback.board_type = c.board_type AND fallback.climb_uuid = c.uuid
      ORDER BY fallback.ascensionist_count DESC NULLS LAST, fallback.angle ASC LIMIT 1))`;

type PlaylistClimbRow = LocalClimbRow & { board_type: string; layout_id: number; preferred_angle: number | null };

export async function getPlaylistClimbsLocal(
  db: OfflineDatabase,
  input: GetPlaylistClimbsInput,
  viewerId: string,
): Promise<GetPlaylistClimbsQueryResponse | null> {
  return withOwner(db, viewerId, async () => {
    if (!(await canServePlaylistClimbsLocal(db, input, viewerId))) return null;
    const filters = filterInputs(input);
    const allRows = buildJoinAndWhere(filters.globalInput, viewerId, undefined, 'playlist');
    const followed =
      filters.board && filters.activeInput.onlyFollowedAuthors ? await followedAuthorsLocalCondition(db) : undefined;
    const active = buildJoinAndWhere(filters.activeInput, viewerId, followed, 'playlist');
    const conditions: string[] = [];
    const filterBinds: SqlValue[] = [...allRows.whereBinds];
    if (allRows.whereSql) conditions.push(allRows.whereSql);
    if (filters.needsActiveBoard) {
      if (!filters.board) conditions.push('0 = 1');
      else {
        const scope = boardScope(filters.board);
        conditions.push(scope.sql);
        filterBinds.push(...scope.binds);
        if (active.whereSql) {
          conditions.push(active.whereSql);
          filterBinds.push(...active.whereBinds);
        }
      }
    }
    const whereSql = conditions.length ? conditions.join(' AND ') : '1 = 1';
    const base = playlistBase(input, viewerId);
    const sortBy = input.view?.sortBy ?? 'position';
    // The server hands resolved angles to hydration only when the view reads
    // stats/grades. A name-only view still uses plain hydration's grade angle.
    const resolvesViewAngles =
      !!input.view &&
      (sortBy === 'difficulty' ||
        sortBy === 'quality' ||
        sortBy === 'ascents' ||
        !!input.view.minAscents ||
        !!input.view.minRating ||
        !!input.view.onlyBenchmarks ||
        !!input.view.projectsOnly ||
        !!input.view.minGrade ||
        !!input.view.maxGrade ||
        Number.isFinite(parseFloat(input.view.gradeAccuracy ?? '')));
    const joinSql = `FROM playlist_members c ${PLAYLIST_STATS_JOIN}
      LEFT JOIN board_climb_grades g ON g.climb_uuid = c.uuid AND g.board_type = c.board_type
        AND g.angle = ${resolvesViewAngles ? 'COALESCE(s.angle, c.preferred_angle)' : 's.angle'}`;
    const count = await db.getFirstAsync<{ total: number }>(
      `${base.sql} SELECT COUNT(*) AS total ${joinSql} WHERE ${whereSql}`,
      [...base.binds, ...filterBinds],
    );
    const page = input.page ?? 0;
    const pageSize = input.pageSize ?? 20;
    const unfiltered =
      conditions.length && page === 0
        ? await db.getFirstAsync<{ total: number }>(
            `${base.sql} SELECT COUNT(*) AS total FROM playlist_members c`,
            base.binds,
          )
        : null;
    const direction = (input.view?.sortOrder ?? PLAYLIST_SORT_DEFAULT_ORDER[sortBy]) === 'desc' ? 'DESC' : 'ASC';
    const ownOrder = (order: string) => `c.position ${order}, c.playlist_added_at ${order}, c.uuid ${order}`;
    let orderSql: string;
    const orderBinds: SqlValue[] = [];
    if (sortBy === 'position') orderSql = ownOrder(direction);
    else if (sortBy === 'added') orderSql = `c.playlist_added_at ${direction}, c.uuid ${direction}`;
    else if (sortBy === 'random') {
      const seed = Number(input.view?.sortSeed);
      orderSql = `${RANDOM_ORDER_EXPR} ASC, c.uuid ASC`;
      orderBinds.push(input.view?.sortSeed && Number.isFinite(seed) ? Math.trunc(seed) : 1);
    } else
      orderSql = `${sortColumnSql(sortBy, false, filters.globalInput.gradeSource, filters.personalGrades)} ${direction}, ${ownOrder('ASC')}`;
    const gradeBinds: SqlValue[] = filters.personalGrades
      ? [filters.globalInput.boardName, filters.globalInput.angle, viewerId]
      : [];
    const rows = await db.getAllAsync<PlaylistClimbRow>(
      `${base.sql} SELECT c.*, s.ascensionist_count, s.display_difficulty, s.difficulty_average, s.quality_average,
        s.benchmark_difficulty, s.angle AS stats_angle, COALESCE(g.universal_grade, g.local_grade) AS boardsesh_difficulty,
        g.confidence AS boardsesh_confidence, 0 AS user_ascents, 0 AS user_attempts,
        ${filters.personalGrades ? MY_GRADE_SUBQUERY : 'NULL'} AS my_difficulty
       ${joinSql} WHERE ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`,
      [...base.binds, ...gradeBinds, ...filterBinds, ...orderBinds, pageSize + 1, page * pageSize],
    );
    return {
      playlistClimbs: {
        climbs: rows.slice(0, pageSize).map((row) => {
          const climb = mapRowToClimb(
            row,
            row.board_type,
            row.layout_id,
            (input.boardName ? input.angle : undefined) ?? row.stats_angle ?? row.preferred_angle ?? 40,
            filters.personalGrades,
          );
          return { ...climb, description: climb.description ?? '' };
        }),
        totalCount: Number(count?.total ?? 0),
        unfilteredCount: unfiltered ? Number(unfiltered.total) : null,
        hasMore: rows.length > pageSize,
      },
    };
  });
}

export async function getPlaylistSettersLocal(
  db: OfflineDatabase,
  input: PlaylistSettersInput,
  viewerId: string,
): Promise<GetPlaylistSettersQueryResponse | null> {
  return withOwner(db, viewerId, async () => {
    if (!input.playlistId || !(await canServePlaylistSettersLocal(db, input, viewerId))) return null;
    const base = playlistBase({ ...input, playlistId: input.playlistId }, viewerId);
    const search = input.search ? ` AND c.setter_username LIKE ? ESCAPE '\\'` : '';
    const rows = await db.getAllAsync<{ username: string; climbCount: number }>(
      `${base.sql} SELECT c.setter_username AS username, COUNT(*) AS climbCount FROM playlist_members c
       WHERE c.setter_username IS NOT NULL AND c.setter_username <> ''${search}
       GROUP BY c.setter_username ORDER BY climbCount DESC, c.setter_username ASC LIMIT 200`,
      [...base.binds, ...(input.search ? [`${input.search.replace(/[\\%_]/g, '\\$&')}%`] : [])],
    );
    return { playlistSetters: rows };
  });
}
