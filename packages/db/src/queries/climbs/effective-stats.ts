import { alias } from 'drizzle-orm/pg-core';
import { sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { getBoardCapabilities } from '@boardsesh/board-config';
import { boardClimbs, boardClimbStats } from '../../schema/index';
import type { BoardRouteParams, ClimbSearchParams } from './types';

/**
 * Cross-angle stats resolution (issue #5405).
 *
 * `board_climb_stats` is keyed `(board_type, climb_uuid, angle)`, and search has
 * always read it at the BROWSED angle. On a board whose climbs are bound to the
 * one angle they were set at that reads as "the list only contains climbs set at
 * this angle": on Woods, browsing 30° finds a row for 653 of 5,392 climbs, and
 * the other 88% sank below every one of them (the `ascents` sort ranks a row with
 * zero ascents above no row at all) and rendered a blank grade when reached.
 *
 * The fix resolves an EFFECTIVE stats row per climb:
 *
 *   1. the row at the browsed angle, when there is one;
 *   2. otherwise the row at the climb's own set angle (`board_climbs.angle`).
 *
 * It is a strict superset of the old behaviour — identical whenever tier 1 hits —
 * so a Kilter list's ranked head does not move and only its blank tail fills in.
 *
 * A climb with a NULL set angle and no row at the browsed angle still resolves to
 * nothing. That is 41% of the Kilter homewall catalogue and 6% of MoonBoard 2016;
 * a third tier ("the climb's most-ascended row, any angle") would close it, and
 * `climbStatsEffectiveAngleSql` in packages/backend already implements exactly that
 * for the feed and notifications. It needs a correlated subquery per candidate row
 * rather than two primary-key joins, so it stays out until the EXPLAIN numbers say
 * it can afford to come in. `hydrate-climbs.ts` (playlists) resolves cross-angle by
 * that most-ascended rule instead of by the set angle — the two deliberately
 * disagree about what "the climb's other angle" means, because a playlist has no
 * browsed angle to prefer.
 */

/**
 * The second `board_climb_stats` join: the row at the climb's OWN set angle.
 *
 * Aliased because the browsed-angle join already occupies the unaliased table, and
 * every consumer has to be able to name both in one statement.
 */
export const boardClimbStatsAtSetAngle = alias(boardClimbStats, 'stats_set_angle');

/**
 * Whether this search resolves stats cross-angle.
 *
 * Two ways in: the board's climbs are angle-bound by nature (Woods, MoonBoard), or
 * the caller opted in for a board where they are not. Deriving it in exactly one
 * place is what keeps `searchClimbs` and `countClimbs` from disagreeing about which
 * universe they are describing — the same drift `filters.isOnlyDrafts` exists to
 * prevent.
 *
 * Both arguments are `Pick`ed down to the two fields actually read, so the climb
 * detail path — which has a board but no search input at all — can ask the same
 * question with `resolveCrossAngleStats(params, {})` instead of fabricating a
 * search it never ran.
 */
export function resolveCrossAngleStats(
  params: Pick<BoardRouteParams, 'board_name'>,
  searchParams: Pick<ClimbSearchParams, 'crossAngleStats'>,
): boolean {
  return getBoardCapabilities(params.board_name).angleBoundClimbs || searchParams.crossAngleStats === true;
}

/**
 * The probe that decides which row is the effective one.
 *
 * `climb_uuid` is part of the stats primary key and therefore NOT NULL in any
 * matched row, so "is it null" is exactly "did the browsed-angle join miss". This
 * is the same probe the stats-presence order key uses in `runStandardSearch`.
 */
const browsedAngleRowExists = sql`${boardClimbStats.climbUuid} IS NOT NULL`;

/**
 * The stats columns search reads. Keyed by drizzle property name rather than by
 * `PgColumn`, because the aliased table's twin has to be looked up by the same key
 * — `column.name` is the snake_case DB name and would not index the alias object.
 */
export type StatsColumnKey =
  | 'ascensionistCount'
  | 'displayDifficulty'
  | 'difficultyAverage'
  | 'qualityAverage'
  | 'benchmarkDifficulty';

/**
 * Reads one stats column from the effective row.
 *
 * **CASE on row presence, never `COALESCE(browsed.col, setAngle.col)`.** Two
 * consumers read more than one stats column in a single expression —
 * `difficulty_error` subtracts `display_difficulty` from `difficulty_average`, and
 * the `gradeAccuracy` filter compares the same pair — and a per-column COALESCE
 * would let one of them come from the browsed-angle row and the other from the
 * set-angle row whenever the browsed row has a NULL in it. Every column routed
 * through here shares the identical probe above, so a multi-column expression is
 * guaranteed to describe one real row. Do not "simplify" this to a COALESCE.
 *
 * With `crossAngle` false this renders to the bare column reference, so the
 * non-cross-angle SQL stays byte-identical to what shipped before #5405.
 */
export function effectiveStatsColumn(columnKey: StatsColumnKey, crossAngle: boolean): SQL {
  const browsedColumn: PgColumn = boardClimbStats[columnKey];
  if (!crossAngle) return sql`${browsedColumn}`;
  const setAngleColumn: PgColumn = boardClimbStatsAtSetAngle[columnKey];
  return sql`CASE WHEN ${browsedAngleRowExists} THEN ${browsedColumn} ELSE ${setAngleColumn} END`;
}

/**
 * The angle the effective row came from, or NULL when the climb has no stats row
 * at either angle — which is the genuine "project" case the client renders as a
 * blank grade.
 *
 * Without cross-angle this is just the browsed-angle row's angle, which is what
 * search selected before.
 */
export function resolvedStatsAngleSql(crossAngle: boolean): SQL<number | null> {
  if (!crossAngle) return sql<number | null>`${boardClimbStats.angle}`;
  return sql<
    number | null
  >`CASE WHEN ${browsedAngleRowExists} THEN ${boardClimbStats.angle} ELSE ${boardClimbStatsAtSetAngle.angle} END`;
}

/**
 * The angle the Boardsesh grade should be read at, so the grade and the community
 * difficulty beside it describe the same climb at the same angle. Falls back to the
 * browsed angle for a climb with no stats anywhere, which is what it got before.
 *
 * `hydrate-climbs.ts` made the same call for playlists: pin the grades join to the
 * angle the stats came from, not to the angle the user is standing in front of.
 */
export function gradeJoinAngleSql(browsedAngle: number, crossAngle: boolean): SQL<number> {
  if (!crossAngle) return sql<number>`${browsedAngle}`;
  return sql<number>`COALESCE(${boardClimbStats.angle}, ${boardClimbStatsAtSetAngle.angle}, ${browsedAngle})`;
}

/**
 * Join predicates for the set-angle stats row, from a query whose FROM is
 * `board_climbs`.
 *
 * No guard is needed for `board_climbs.angle IS NULL`: SQL equality against NULL is
 * never true, so the join simply misses, which is the right answer for a climb that
 * never recorded a set angle.
 */
export function setAngleStatsJoinConditions(boardName: string): SQL[] {
  return [
    sql`${boardClimbStatsAtSetAngle.climbUuid} = ${boardClimbs.uuid}`,
    sql`${boardClimbStatsAtSetAngle.boardType} = ${boardName}`,
    sql`${boardClimbStatsAtSetAngle.angle} = ${boardClimbs.angle}`,
  ];
}
