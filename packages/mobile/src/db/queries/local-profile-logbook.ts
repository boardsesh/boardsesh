import { getLocalUserId, type OfflineDatabase } from '@boardsesh/offline-sync';

export const LOCAL_PROFILE_LOGBOOK_PAGE_SIZE = 30;

export type LocalProfileLogbookEntry = {
  uuid: string;
  climbUuid: string;
  boardType: string;
  climbName: string | null;
  setterUsername: string | null;
  angle: number;
  isMirror: boolean;
  status: string;
  attemptCount: number;
  difficulty: number | null;
  comment: string;
  climbedAt: string;
};

export type LocalProfileLogbookPage = {
  entries: LocalProfileLogbookEntry[];
  hasMore: boolean;
};

export type LocalProfileStats = {
  sends: number;
  flashes: number;
  attempts: number;
};

type LocalProfileLogbookRow = {
  uuid: string;
  climb_uuid: string;
  board_type: string;
  climb_name: string | null;
  setter_username: string | null;
  angle: number;
  is_mirror: number | null;
  status: string;
  attempt_count: number | null;
  difficulty: number | null;
  comment: string | null;
  climbed_at: string | null;
  created_at: string | null;
};

type LocalProfileStatsRow = {
  sends: number;
  flashes: number;
  attempts: number;
};

async function requireLocalProfileOwner(db: OfflineDatabase): Promise<string> {
  const ownerId = await getLocalUserId(db);
  if (!ownerId?.startsWith('local:')) {
    throw new Error('Local profile owner is not initialized');
  }
  return ownerId;
}

/** Reads one owner-scoped page from SQLite without a network fallback. */
export async function getLocalProfileLogbookPage(
  db: OfflineDatabase,
  offset: number,
  pageSize = LOCAL_PROFILE_LOGBOOK_PAGE_SIZE,
): Promise<LocalProfileLogbookPage> {
  const ownerId = await requireLocalProfileOwner(db);
  const rows = await db.getAllAsync<LocalProfileLogbookRow>(
    `SELECT t.uuid, t.climb_uuid, t.board_type, c.name AS climb_name,
            c.setter_username, t.angle, t.is_mirror, t.status, t.attempt_count,
            COALESCE(t.difficulty, ROUND(s.display_difficulty)) AS difficulty,
            t.comment, t.climbed_at, t.created_at
       FROM boardsesh_ticks t
       LEFT JOIN board_climbs c
         ON c.uuid = t.climb_uuid AND c.board_type = t.board_type
       LEFT JOIN board_climb_stats s
         ON s.climb_uuid = t.climb_uuid
        AND s.board_type = t.board_type
        AND s.angle = t.angle
      WHERE t.user_id = ?
      ORDER BY COALESCE(t.climbed_at, t.created_at) DESC, t.uuid DESC
      LIMIT ? OFFSET ?`,
    [ownerId, pageSize + 1, offset],
  );

  return {
    entries: rows.slice(0, pageSize).map((row) => ({
      uuid: row.uuid,
      climbUuid: row.climb_uuid,
      boardType: row.board_type,
      climbName: row.climb_name,
      setterUsername: row.setter_username,
      angle: row.angle,
      isMirror: row.is_mirror === 1,
      status: row.status,
      attemptCount: row.attempt_count ?? 1,
      difficulty: row.difficulty,
      comment: row.comment ?? '',
      climbedAt: row.climbed_at ?? row.created_at ?? new Date(0).toISOString(),
    })),
    hasMore: rows.length > pageSize,
  };
}

/** Compact totals for the local You header, aggregated inside SQLite. */
export async function getLocalProfileStats(db: OfflineDatabase): Promise<LocalProfileStats> {
  const ownerId = await requireLocalProfileOwner(db);
  const row = await db.getFirstAsync<LocalProfileStatsRow>(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('send', 'flash')) AS sends,
       COUNT(*) FILTER (WHERE status = 'flash') AS flashes,
       COALESCE(SUM(attempt_count), 0) AS attempts
     FROM boardsesh_ticks
     WHERE user_id = ?`,
    [ownerId],
  );
  return {
    sends: row?.sends ?? 0,
    flashes: row?.flashes ?? 0,
    attempts: row?.attempts ?? 0,
  };
}
