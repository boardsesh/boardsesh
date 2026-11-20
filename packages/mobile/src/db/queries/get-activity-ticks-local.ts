import { canServeLocalUserData, getLocalUserId, type SqlExecutor } from '@boardsesh/offline-sync';
import type { ProjectTickEntry, WeekActivityEntry } from '@boardsesh/profile-stats';

/**
 * One tick for Home's own-climbing cards: This week (#7690) and Back to your
 * projects (#7691), with what each needs to name and open its climb.
 */
export type ActivityTick = WeekActivityEntry &
  ProjectTickEntry & {
    climbUuid: string;
    angle: number;
    /** Null when the board's catalogue is not on this phone. */
    climbName: string | null;
    layoutId: number | null;
  };

type WeekActivityRow = {
  climb_uuid: string;
  board_type: string;
  angle: number;
  status: ActivityTick['status'];
  attempt_count: number | null;
  climbed_at: string;
  difficulty: number | null;
  climb_name: string | null;
  layout_id: number | null;
};

/**
 * Every tick the signed-in climber logged, on every board, for Home's This week
 * card (#7690) and projects shelf (#7691), which share this one read. Local, so
 * both draw on a cold start and with no signal, where the You tab's network
 * stats show a skeleton.
 *
 * Follows the auth-scoping contract in docs/data/offline-reads.md, as
 * `readTickRowsLocal` does: it serves only when `canServeLocalUserData` says the
 * rows are complete and belong to this climber, filters to the owner stamp (or a
 * legacy row with no owner), and declines with `null` rather than claiming an
 * empty logbook. Aurora twins collapse on the same natural key.
 *
 * The grade is the climber's own, else the climb's consensus at that angle when
 * the board's catalogue is on the phone. A tick with neither still counts as a
 * session and a send; it just cannot be the week's hardest or a record.
 */
export async function readActivityTicksLocal(db: SqlExecutor, viewerId: string): Promise<ActivityTick[] | null> {
  if (!(await canServeLocalUserData(db, viewerId))) return null;
  const ownerUserId = await getLocalUserId(db);
  // Recheck after the asynchronous gate: a sign-out in between must not let the
  // next owner's rows answer.
  if (ownerUserId !== viewerId) return null;
  const rows = await db.getAllAsync<WeekActivityRow>(
    `SELECT t.climb_uuid, t.board_type, t.angle, t.status, t.attempt_count, t.climbed_at,
       COALESCE(t.difficulty, CAST(ROUND(s.display_difficulty) AS INTEGER)) AS difficulty,
       c.name AS climb_name, c.layout_id
     FROM boardsesh_ticks t
     LEFT JOIN board_climb_stats s
       ON s.board_type = t.board_type AND s.climb_uuid = t.climb_uuid AND s.angle = t.angle
     LEFT JOIN board_climbs c ON c.uuid = t.climb_uuid AND c.board_type = t.board_type
     WHERE (t.user_id = ? OR t.user_id IS NULL)
       AND t.status IN ('flash', 'send', 'attempt')
       AND t.board_type IS NOT NULL AND t.climb_uuid IS NOT NULL
       AND t.angle IS NOT NULL AND t.climbed_at IS NOT NULL
     GROUP BY t.board_type, t.climb_uuid, t.angle, t.climbed_at, t.is_mirror, t.status, t.attempt_count,
       t.quality, t.difficulty, t.is_benchmark, t.comment`,
    [ownerUserId],
  );
  // Do not publish a batch read across a wipe or a re-stamp.
  if (!(await canServeLocalUserData(db, viewerId))) return null;
  return rows.map((row) => ({
    climbUuid: row.climb_uuid,
    boardType: row.board_type,
    angle: row.angle,
    status: row.status,
    attemptCount: row.attempt_count,
    climbedAt: row.climbed_at,
    difficulty: row.difficulty,
    climbName: row.climb_name,
    layoutId: row.layout_id,
  }));
}
