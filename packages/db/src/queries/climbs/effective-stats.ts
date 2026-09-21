import { alias } from 'drizzle-orm/pg-core';
import { sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { getBoardCapabilities } from '@boardsesh/board-config';
import { boardClimbs, boardClimbStats } from '../../schema/index';
import { hasNameQuery, type BoardRouteParams, type ClimbSearchParams } from './types';

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
 * **Opt-in on every board, and a restriction by default on Woods (issue #5642).**
 * #5413 turned cross-angle on unconditionally for Woods, and at 30° that flooded
 * the head of the list with climbs set at 20° and 40°, ranked on sends made at an
 * angle the climber is not standing at. On an angle-bound board a climb set at 40°
 * is a different problem, not the same one at another steepness. So:
 *
 *   - cross-angle is on only when the search asks (`crossAngleStats === true`),
 *     or when an angle-bound board is searched by name — somebody typing a
 *     climb's name wants that climb whatever angle it was set at;
 *   - an angle-bound search without it keeps only the climbs that belong to the
 *     browsed angle: set there, with no set angle recorded, or with a stats row
 *     there (`resolveBrowsedAngleRestriction`, `browsedAngleRestrictionSql`);
 *   - the climb DETAIL read stays cross-angle on an angle-bound board
 *     (`resolveDetailCrossAngleStats`), so a climb opened at another angle — from
 *     a by-name search, an opted-in list, a playlist — shows its set-angle grade
 *     instead of a blank one.
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
 * Two ways in: the caller opted in (`crossAngleStats === true`, on any board), or
 * the board's climbs are angle-bound (Woods) and the search is a by-name lookup —
 * the same `hasNameQuery` test that lets a name search reach a community-hidden
 * climb. Omitted means OFF on every board, deliberately: the mobile count preview
 * and the web SSR page leave the field out, and they must describe the same list
 * the default mobile search does, which sends `false`.
 *
 * Deriving it in exactly one place is what keeps `searchClimbs` and `countClimbs`
 * from disagreeing about which universe they are describing — the same drift
 * `filters.isOnlyDrafts` exists to prevent. Both pass this and
 * `resolveBrowsedAngleRestriction` straight into `createClimbFilters`.
 *
 * Both arguments are `Pick`ed down to the fields actually read. The climb detail
 * path has a board but no search input at all, and asks
 * `resolveDetailCrossAngleStats` instead of fabricating a search it never ran.
 */
export function resolveCrossAngleStats(
  params: Pick<BoardRouteParams, 'board_name'>,
  searchParams: Pick<ClimbSearchParams, 'crossAngleStats' | 'name'>,
): boolean {
  if (searchParams.crossAngleStats === true) return true;
  return getBoardCapabilities(params.board_name).angleBoundClimbs && hasNameQuery(searchParams);
}

/**
 * Whether this search keeps only the climbs that belong to the browsed angle
 * (issue #5642).
 *
 * True on an angle-bound board whenever the search is NOT cross-angle. The two
 * are complements there: an opted-in search wants every angle, and so does a
 * by-name search, which is why this reads `resolveCrossAngleStats` rather than
 * re-deriving the name rule. Off an angle-bound board it is always false — a
 * Kilter climb has stats at every angle it has been climbed at, so "belongs to
 * this angle" is not a question its catalogue can answer.
 *
 * One exemption is made later, in `createClimbFilters`: a user's own drafts list
 * shows every draft whatever angle it was saved at. Telling a drafts query apart
 * needs the userId (`filters.isOnlyDrafts`), so the builder applies it and
 * exposes the outcome as `filters.isBrowsedAngleRestricted`.
 */
export function resolveBrowsedAngleRestriction(
  params: Pick<BoardRouteParams, 'board_name'>,
  searchParams: Pick<ClimbSearchParams, 'crossAngleStats' | 'name'>,
): boolean {
  return getBoardCapabilities(params.board_name).angleBoundClimbs && !resolveCrossAngleStats(params, searchParams);
}

/**
 * Whether the climb DETAIL read resolves stats cross-angle.
 *
 * Capability-driven, never search-driven. A Woods climb opened at an angle it was
 * not set at — from a by-name search, an opted-in list, a playlist, a shared link
 * — must show its set-angle grade rather than a blank one, and the detail read
 * has no search input to opt in with anyway. The offline mirror is
 * `isDetailCrossAngleStats` in packages/mobile/src/db/queries/search-climbs-local.ts.
 */
export function resolveDetailCrossAngleStats(params: Pick<BoardRouteParams, 'board_name'>): boolean {
  return getBoardCapabilities(params.board_name).angleBoundClimbs;
}

/**
 * The probe that decides which row is the effective one.
 *
 * `climb_uuid` is part of the stats primary key and therefore NOT NULL in any
 * matched row, so "is it null" is exactly "did the browsed-angle join miss". This
 * is the same probe the stats-presence order key uses in `runStandardSearch`.
 */
const browsedAngleRowExists = sql`${boardClimbStats.climbUuid} IS NOT NULL`;

// The offline mirror of this probe lives in
// packages/mobile/src/db/queries/search-climbs-local.ts (`effectiveStatsSql`) and
// must agree, or a downloaded board ranks and grades its list differently from the
// network. It is hand-written SQL there rather than shared code because that path
// speaks SQLite, so a change to the predicate above has to be made twice on
// purpose — the same contract `hiddenClimbCondition` carries in
// ./create-climb-filters. The browsed-angle restriction below carries it too.

/**
 * The browsed-angle restriction (issue #5642): a climb belongs to the angle being
 * browsed when it was set there, when it has no set angle recorded at all (it
 * cannot belong anywhere else, so hiding it would lose it outright), or when it
 * has a stats row there — somebody climbed it at this angle, and the list reads
 * that row.
 *
 * The third arm is the browsed-angle row-presence probe above, on the UNALIASED
 * stats table, so every query that applies this must have joined
 * `board_climb_stats` at the browsed angle. All three do: `runStatsDrivenSearch`
 * drives off it with an INNER JOIN (the probe is always true there, so the
 * stats-driven pages are untouched and only the fallback's stats-less tail is
 * trimmed — which keeps the fallback a prefix-compatible continuation), and
 * `runStandardSearch` and `countClimbs` LEFT JOIN it through
 * `filters.getClimbStatsJoinConditions()`. That requirement is why it reaches
 * `createClimbFilters` as an explicit opt-in: see the builder's `options` doc.
 *
 * Offline mirror: `buildJoinAndWhere` in
 * packages/mobile/src/db/queries/search-climbs-local.ts, same three arms.
 */
export function browsedAngleRestrictionSql(browsedAngle: number): SQL {
  return sql`(${boardClimbs.angle} = ${browsedAngle} OR ${boardClimbs.angle} IS NULL OR ${browsedAngleRowExists})`;
}

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
