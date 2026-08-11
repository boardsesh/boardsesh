import { eq, sql, type SQL } from 'drizzle-orm';
import { boardClimbs, boardClimbStats } from '@boardsesh/db/schema';

/**
 * Angle resolution for joins from `board_climbs` to `board_climb_stats`.
 *
 * `board_climbs.angle` is nullable while `board_climb_stats.angle` is NOT NULL
 * and part of the stats primary key, so a plain
 * `eq(boardClimbStats.angle, boardClimbs.angle)` join silently drops every
 * stats row (and therefore the grade) for an angle-agnostic climb. MoonBoard
 * problems are set at whatever angle the wall happens to be at, so they are the
 * ones that end up with a NULL climb angle.
 *
 * The fallback picks the most-ascended stats row for the climb, with the lower
 * angle winning ties so repeated reads are deterministic. `COALESCE`
 * short-circuits: a climb with a non-null angle never evaluates the subquery,
 * so Kilter/Tension behaviour and query plans are unchanged.
 */
export const climbStatsEffectiveAngleSql: SQL<number | null> = sql<number | null>`COALESCE(${boardClimbs.angle}, (
  SELECT s.angle FROM board_climb_stats s
  WHERE s.board_type = ${boardClimbs.boardType}
    AND s.climb_uuid = ${boardClimbs.uuid}
  ORDER BY s.ascensionist_count DESC NULLS LAST, s.angle ASC
  LIMIT 1
))`;
// The inner copy of `board_climb_stats` is written as a bare `FROM
// board_climb_stats s` rather than an interpolated table reference so the
// correlation stays alias-stable even where the outer query already joins the
// unaliased table.

/** `board_climb_stats.angle` matches the climb's own angle, or the fallback above. */
export function climbStatsAngleMatch(): SQL {
  return eq(boardClimbStats.angle, climbStatsEffectiveAngleSql);
}

/**
 * Full join predicate set for `leftJoin(boardClimbStats, and(...climbStatsJoinConditions()))`
 * from a query whose `from` is `boardClimbs`.
 */
export function climbStatsJoinConditions(): SQL[] {
  return [
    eq(boardClimbStats.boardType, boardClimbs.boardType),
    eq(boardClimbStats.climbUuid, boardClimbs.uuid),
    climbStatsAngleMatch(),
  ];
}

/**
 * Angle to report alongside a grade resolved through the join above, so the
 * displayed angle agrees with the difficulty that was actually read.
 */
export const resolvedClimbAngleSql = sql<number | null>`COALESCE(${boardClimbs.angle}, ${boardClimbStats.angle})`;
