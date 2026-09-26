import type { OfflineDatabase } from '@boardsesh/offline-sync';
import type { ClimbStatsHistoryEntry } from '@boardsesh/graphql/operations';

type StatsRow = {
  angle: number;
  ascensionist_count: number | null;
  quality_average: number | null;
  difficulty_average: number | null;
  display_difficulty: number | null;
  updated_at: string | null;
};

// A synced stats row always carries updated_at; this only keeps the non-null
// `createdAt` contract for a row that somehow lacks one. Every consumer keeps
// the newest entry per angle, and the local answer has one entry per angle, so
// the value never decides anything.
const UNKNOWN_SNAPSHOT_TIME = '1970-01-01T00:00:00.000Z';

/**
 * The play drawer's per-angle community stats (the "grade by angle" bars, the
 * angle picker's grade / stars / sends), answered from the synced
 * `board_climb_stats` table in the shape the `climbStatsHistory` GraphQL op
 * returns.
 *
 * Every consumer reduces the list to the newest entry per angle, so the current
 * stats row IS that answer: one entry per angle with at least one ascent, with
 * the row's `updated_at` standing in for the snapshot time. That is the answer
 * the server gives once it reads current stats instead of twelve months of
 * weekly snapshots, and it is fresher than the snapshot table.
 */
export async function getClimbStatsHistoryLocal(
  db: OfflineDatabase,
  input: { boardName: string; climbUuid: string },
): Promise<ClimbStatsHistoryEntry[]> {
  const rows = await db.getAllAsync<StatsRow>(
    `SELECT angle, ascensionist_count, quality_average, difficulty_average, display_difficulty, updated_at
     FROM board_climb_stats
     WHERE board_type = ? AND climb_uuid = ? AND ascensionist_count > 0
     ORDER BY angle ASC`,
    [input.boardName, input.climbUuid],
  );
  return rows.map((row) => ({
    angle: row.angle,
    ascensionistCount: row.ascensionist_count,
    qualityAverage: row.quality_average,
    difficultyAverage: row.difficulty_average,
    displayDifficulty: row.display_difficulty,
    createdAt: row.updated_at ?? UNKNOWN_SNAPSHOT_TIME,
  }));
}
