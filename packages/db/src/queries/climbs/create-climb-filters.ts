import { type SQL, desc, eq, gt, isNotNull, sql, like, notLike, inArray, isNull, or, and } from 'drizzle-orm';
import { QueryBuilder, alias } from 'drizzle-orm/pg-core';
import { getMoonBoardGeometryByLayoutId, woodsHoldIdsInZone } from '@boardsesh/board-config';
import { getTallWideScope } from '@boardsesh/board-constants/product-sizes';
import { BOULDER_GRADES } from '@boardsesh/board-constants/boulder-grade-mapping';
import { climbNameLikePattern } from '@boardsesh/climb-filters';
import {
  boardClimbs,
  boardClimbStats,
  boardClimbGrades,
  boardseshTicks,
  boardClimbHolds,
  boardPlacements,
  boardHoles,
  boardBetaLinks,
} from '../../schema/index';
import { hasNameQuery, type BoardRouteParams, type ClimbSearchParams } from './types';
import { followedAuthorCondition } from './followed-authors';
import { climbHoldPlacementMatchSql } from './placement-match';
import {
  browsedAngleRestrictionSql,
  effectiveStatsColumn,
  setAngleStatsJoinConditions,
  gradeJoinAngleSql,
  type StatsColumnKey,
} from './effective-stats';

// ---------------------------------------------------------------------------
// Personal grades (#4796 / #4828) — the ONE definition of the rule.
//
//   personal grade  := difficulty of the LATEST tick for
//                      (user, board_type, climb_uuid, angle) whose difficulty is
//                      NOT NULL, ordered by (climbed_at DESC, uuid DESC)
//   effective grade := COALESCE(clamped personal grade, ROUND(display_difficulty))
//
// Every read that filters, sorts, or projects a personal grade builds it from
// the helpers below rather than re-deriving it, because the failure mode is a
// row that READS V10 while a V9-V11 filter hides it — the exact defect the
// Boardsesh-grade toggle shipped once already (rows displayed one grade while
// filter and sort still keyed display_difficulty).
//
// One join serves all three. `buildPersonalGradeJoinTarget` returns a
// `DISTINCT ON (climb_uuid)` subquery of the climber's latest graded tick per
// climb, joined once under the alias `my_grade`; filter, ORDER BY and the
// projected `myDifficulty` then all read `COALESCE("my_grade"."difficulty",
// ROUND(display_difficulty))`. Three separate expressions would be three places
// to drift.
//
// Three rules the helpers encode, none of them negotiable:
//  - LATEST, never MAX. A stiff grade from one bad day must not stick.
//  - `difficulty IS NOT NULL`, never a falsy check — 0 is a real difficulty id.
//  - the tie-break is `uuid`, never the `id` bigserial. boardsesh_ticks has
//    both, but only `uuid` ever reaches the client, and the client half
//    (pickLatestGradedTick in @boardsesh/logbook) orders by (climbed_at, uuid).
//    Ordering on `id` here would let server and client disagree about which
//    grade is current whenever two ticks share a climbed_at.
// ---------------------------------------------------------------------------

/**
 * The difficulty-id bounds of the boulder scale, derived from the table rather
 * than hardcoded so a future extension of `BOULDER_GRADES` moves them for free.
 * The write side bounds the same way (packages/backend/src/validation/schemas/ticks.ts),
 * so a clamp only ever has work to do for a row that predates that validation
 * or arrived through an import.
 */
export const PERSONAL_GRADE_MIN_ID = BOULDER_GRADES[0].difficulty_id;
export const PERSONAL_GRADE_MAX_ID = BOULDER_GRADES[BOULDER_GRADES.length - 1].difficulty_id;

/** Alias the personal-grade subquery is joined under, in every query that joins it. */
export const PERSONAL_GRADE_ALIAS = 'my_grade';

/** The column that alias exposes. */
const PERSONAL_GRADE_COLUMN = 'difficulty';

/**
 * `"my_grade"."difficulty"` — the joined personal grade, ALWAYS table-qualified.
 *
 * Written with `sql.identifier` rather than by interpolating the subquery's
 * `.as('difficulty')` field: drizzle drops the subquery alias when an aliased
 * field is interpolated into a `sql` template, so that form renders a bare
 * `"difficulty"` that only resolves by luck (nothing else in the join tree
 * happens to expose that name). One renamed column elsewhere and the filter
 * would silently key on the wrong thing.
 */
export function personalGradeColumnSql(): SQL {
  return sql`${sql.identifier(PERSONAL_GRADE_ALIAS)}.${sql.identifier(PERSONAL_GRADE_COLUMN)}`;
}

/** Clamp a difficulty expression onto the boulder scale. */
export function clampToBoulderScaleSql(difficultyExpr: SQL): SQL {
  return sql`LEAST(GREATEST(${difficultyExpr}, ${PERSONAL_GRADE_MIN_ID}), ${PERSONAL_GRADE_MAX_ID})`;
}

/** Who the personal grade belongs to, and which board+angle it was given at. */
export type PersonalGradeScope = {
  boardType: string;
  angle: number;
  userId: string;
};

/**
 * The climber's whole grade book for this board+angle, as ONE subquery: their
 * latest graded tick per climb, already clamped.
 *
 * `DISTINCT ON (climb_uuid) … ORDER BY climb_uuid, climbed_at DESC, uuid DESC`
 * is the direct spelling of "latest per climb", and it is the shape that keeps
 * this feature cheap. Two shapes were measured and rejected:
 *
 *  - a per-row `LEFT JOIN LATERAL … LIMIT 1` probes boardsesh_ticks once per
 *    surviving candidate climb, so it costs whatever the filter leaves behind;
 *  - `EXISTS … OR NOT EXISTS …` inside the WHERE never unnests. Postgres only
 *    pulls up sublinks that are AND-ed at the top of the qual; a sublink under
 *    an `OR` is never converted to a semi/anti join.
 *
 * Measured on the dev DB (kilter/40, 84,243 candidate climbs, a climber with
 * 595 graded ticks) over a V1-V11 band, both shapes returning the identical
 * 82,141 rows (EXCEPT empty in both directions):
 *
 *   list   crowd-only baseline    735 ms /  38,441 shared buffers
 *   list   the OR-sublink shape  1225 ms / 288,502 shared buffers
 *   list   this shape             823 ms /  38,458 shared buffers
 *   count  the OR-sublink shape  1030 ms / 288,500 shared buffers
 *   count  this shape             642 ms /  38,456 shared buffers
 *
 * Joined once, this scales with the CLIMBER'S tick count (hundreds) rather than
 * with candidate climbs (hundreds of thousands), and the partial covering index
 * `boardsesh_ticks_user_grade_latest_idx` serves the whole build index-only —
 * 17 shared buffers, zero heap fetches, no Sort. The EXPLAIN harness
 * (`search-climbs-explain.integration.test.ts`) pins that plan shape.
 *
 * LEFT JOIN it, never INNER — an inner join drops every climb the climber has
 * not graded, i.e. nearly the whole board. `buildPersonalGradeJoinTarget`
 * returns both halves so a caller cannot join it on the wrong key.
 */
export function buildPersonalGradeSubquery(scope: PersonalGradeScope) {
  return (
    new QueryBuilder()
      .selectDistinctOn([boardseshTicks.climbUuid], {
        climbUuid: boardseshTicks.climbUuid,
        difficulty: clampToBoulderScaleSql(sql`${boardseshTicks.difficulty}`).as(PERSONAL_GRADE_COLUMN),
      })
      .from(boardseshTicks)
      .where(
        and(
          eq(boardseshTicks.userId, scope.userId),
          eq(boardseshTicks.boardType, scope.boardType),
          eq(boardseshTicks.angle, scope.angle),
          // Explicit NULL check, not falsiness: difficulty 0 is a real id.
          isNotNull(boardseshTicks.difficulty),
        ),
      )
      // Bare DESC (= NULLS FIRST) on purpose: it matches the index's declared
      // `DESC NULLS FIRST` pathkeys, so the DISTINCT ON needs no Sort node. See
      // `userGradeLatestIdx` in packages/db/src/schema/app/ascents.ts.
      .orderBy(boardseshTicks.climbUuid, desc(boardseshTicks.climbedAt), desc(boardseshTicks.uuid))
      .as(PERSONAL_GRADE_ALIAS)
  );
}

export type PersonalGradeSubquery = ReturnType<typeof buildPersonalGradeSubquery>;

/** A personal-grade subquery plus the ON condition it must be joined with. */
export type PersonalGradeJoinTarget = {
  subquery: PersonalGradeSubquery;
  on: SQL;
};

/**
 * The subquery and its join key together, so the three query builders that need
 * it (both search paths and `countClimbs`) cannot join it on anything else.
 */
export function buildPersonalGradeJoinTarget(scope: PersonalGradeScope): PersonalGradeJoinTarget {
  const subquery = buildPersonalGradeSubquery(scope);
  return {
    subquery,
    on: sql`${sql.identifier(PERSONAL_GRADE_ALIAS)}.${sql.identifier('climb_uuid')} = ${boardClimbs.uuid}`,
  };
}

/**
 * `COALESCE(my grade, the crowd's)` — what the grade filter and the difficulty
 * sort key on when the climber asked for their own grades. A climb they never
 * graded keeps its crowd position, so the list stays a single ordered sequence
 * rather than two interleaved ones.
 *
 * `crowdGrade` is whatever the same query would have keyed on with personal
 * grades off — for the filter that is `gradeValueSql(...)` (grade-source aware,
 * cross-angle aware), for the sort it is the difficulty sort column. Taking it
 * as a parameter is what keeps the personal rule layered ON TOP of the
 * grade-source and cross-angle rules instead of forking a second crowd grade.
 *
 * Requires the personal-grade subquery to be joined under `PERSONAL_GRADE_ALIAS`.
 */
export function effectiveDifficultySql(crowdGrade: SQL): SQL {
  return sql`COALESCE(${personalGradeColumnSql()}, ${crowdGrade})`;
}

/**
 * Render the in-range test for a grade expression, or `null` when neither bound
 * is set (no filter at all).
 *
 * `minGrade`/`maxGrade` are checked for truthiness rather than `!= null` to
 * match the crowd-grade filter above it, which has always read them that way —
 * grade id 0 is below the scale's floor (10) and never a real bound.
 */
export function gradeInRangeSql(
  gradeExpr: SQL,
  minGrade: number | undefined,
  maxGrade: number | undefined,
): SQL | null {
  if (minGrade && maxGrade) return sql`${gradeExpr} BETWEEN ${minGrade} AND ${maxGrade}`;
  if (minGrade) return sql`${gradeExpr} >= ${minGrade}`;
  if (maxGrade) return sql`${gradeExpr} <= ${maxGrade}`;
  return null;
}

/**
 * The grade-range filter, keyed on the climber's own grade where they gave one.
 *
 * One plain range test over `COALESCE(my grade, the crowd's)`, resolved by the
 * joined `my_grade` subquery. That single expression already says both halves of
 * the rule: a climb the climber graded is admitted on THEIR number, a climb they
 * never graded falls through to the crowd's and behaves exactly as before. A
 * climb with neither (no stats row at this angle, never graded) yields NULL and
 * is excluded — same as the crowd-only filter it replaces.
 *
 * Keeping it a bare comparison rather than a pair of sublinks is what lets
 * Postgres keep pushing the range into the `board_climb_stats` scan.
 *
 * Requires the caller to have joined `buildPersonalGradeJoinTarget()`. Returns
 * `null` when no bound is set, so callers can spread the result.
 */
export function personalGradeRangeCondition(
  crowdGrade: SQL,
  minGrade: number | undefined,
  maxGrade: number | undefined,
): SQL | null {
  return gradeInRangeSql(effectiveDifficultySql(crowdGrade), minGrade, maxGrade);
}

// A Postgres `ARRAY[...]::int[]` literal from a number list, for the tall/wide
// `compatible_size_ids &&` overlap predicates and the Woods zone `= ANY(...)`
// probes. Built explicitly because drizzle's `sql` template expands a bare JS
// array into a parenthesised parameter list — a ROW literal Postgres won't cast
// to `int[]`.
function intArrayLiteral(values: readonly number[]): SQL {
  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::int[]`;
}

/**
 * The community-moderation predicate: a climb hidden by the report/hide flow
 * (`board_climbs.is_hidden`) is gone from every BROWSE surface — lists, counts,
 * feeds, recommendations, the sitemap, similarity discovery.
 *
 * The one exception is an explicit name search. Somebody typing a hidden climb's
 * name already knows it exists — the setter checking on their own climb, a
 * moderator confirming the hide landed — and hiding it from a by-name lookup
 * would read as data loss rather than moderation. Browsing is what the hide is
 * for, so every nameless query keeps the filter.
 *
 * The offline mirror of this rule lives in
 * packages/mobile/src/db/queries/search-climbs-local.ts and must agree, or an
 * offline search shows what the online one hides.
 *
 * `hasNameQuery` is shared with the angle-bound browse restriction
 * (`resolveCrossAngleStats` in ./effective-stats), which makes the same exception
 * for the same reason: a named climb is findable at any angle too.
 */
export function hiddenClimbCondition(searchParams: ClimbSearchParams): SQL[] {
  return hasNameQuery(searchParams) ? [] : [eq(boardClimbs.isHidden, false)];
}

/**
 * The spray-wall integrity predicate: does this climb still have every hold it
 * was set on?
 *
 * Reads the materialised `board_climbs.missing_hold_count`, which
 * `recomputeMissingHoldCounts` re-derives whenever a reset lands. Materialised
 * rather than joined through `board_climb_holds` on purpose — the offline mirror
 * has no such table, so a join would be a filter the phone could never mirror.
 *
 * NULL is the reason both branches COALESCE. Every non-spray climb carries NULL
 * (holds do not come off a catalogue board), as does a spray climb written before
 * the column existed. The honest reading of "unknown" is INTACT: a climb is
 * presumed whole until a reset says otherwise, so INTACT keeps NULLs and BROKEN
 * drops them. Reversed, one un-backfilled row would badge every Kilter climb in
 * the database as broken.
 *
 * The offline mirror of this rule lives in
 * packages/mobile/src/db/queries/search-climbs-local.ts and is the same two
 * COALESCE clauses: SW-15 (#5448) added `missing_hold_count` to the on-device
 * schema and to the `syncClimbs` payload, so the phone answers the filter rather
 * than declining it. Change the NULL rule here and you must change it there.
 */
export function holdIntegrityCondition(searchParams: ClimbSearchParams): SQL[] {
  if (searchParams.holdIntegrity === 'intact') {
    return [sql`COALESCE(${boardClimbs.missingHoldCount}, 0) = 0`];
  }
  if (searchParams.holdIntegrity === 'broken') {
    return [sql`COALESCE(${boardClimbs.missingHoldCount}, 0) > 0`];
  }
  return [];
}

function moonBoardZoneCoordinates(layoutId: number, placementHoleId: SQL): { x: SQL; y: SQL } {
  const geometry = getMoonBoardGeometryByLayoutId(layoutId);
  const { leftMargin, rightMargin, topMargin, bottomMargin } = geometry.calibration;
  const horizontalOrigin = leftMargin * geometry.numColumns;
  const horizontalScale = 1 - leftMargin - rightMargin;
  const verticalOrigin = geometry.rowTop * (1 - topMargin);
  const verticalScale = (geometry.rowTop / geometry.numRows) * (1 - topMargin - bottomMargin);
  const cellIndex = sql`(${placementHoleId} - 1)`;
  const row = sql`(FLOOR(${cellIndex} / ${geometry.numColumns}) + 1)`;

  return {
    x: sql`${horizontalOrigin} + (MOD(${cellIndex}, ${geometry.numColumns}) + 0.5) * ${horizontalScale}`,
    y: sql`${verticalOrigin} - (${geometry.rowTop} - ${row} + 0.5) * ${verticalScale}`,
  };
}

/**
 * The rounded grade id a climb is filtered on — and, under the Boardsesh source,
 * sorted on — for `searchParams.gradeSource` (issues #5643, #5752, #5753).
 *
 *   - 'upstream' (and undefined): the board's own catalogue grade (display_difficulty),
 *     falling back to the Boardsesh grade only when there is no stats row.
 *   - 'boardsesh': the Boardsesh grade (COALESCE(universal, local), the value a
 *     list row labels a climb with when Boardsesh grades are on), falling back to
 *     display_difficulty when the climb has no board_climb_grades row.
 *
 * `displayDifficulty` must be the effective-stats reader (`statsCol`), so this
 * composes with cross-angle. Mirrored by `gradeValueSql` in
 * packages/mobile/src/db/queries/search-climbs-local.ts.
 */
export function gradeValueSql(displayDifficulty: SQL, gradeSource: ClimbSearchParams['gradeSource']): SQL {
  const upstreamGrade = sql`ROUND(${displayDifficulty}::numeric, 0)`;
  const boardseshGrade = sql`ROUND(COALESCE(${boardClimbGrades.universalGrade}, ${boardClimbGrades.localGrade})::numeric, 0)`;
  if (gradeSource !== 'boardsesh') return sql`COALESCE(${upstreamGrade}, ${boardseshGrade})`;
  // A `setter_only` grade is never shown on a row (the label falls back to the
  // upstream grade — `resolveBoardseshDifficulty` in the mobile app), so it must
  // not be filtered or sorted on either. The upstream branch above keeps its
  // fallback exactly as it was.
  const shownBoardseshGrade = sql`CASE WHEN ${boardClimbGrades.confidence} = 'setter_only' THEN NULL ELSE ${boardseshGrade} END`;
  return sql`COALESCE(${shownBoardseshGrade}, ${upstreamGrade})`;
}

/**
 * The Boardsesh-grade row the split grade filter below falls back to. Aliased so
 * the EXISTS probe can never bind to a `board_climb_grades` join the outer query
 * happens to carry. Drizzle renders an aliased table interpolated into `sql` as
 * the bare alias, so the FROM spells out `table AS alias` itself.
 */
const GRADE_FALLBACK_ALIAS = 'grade_fallback';
const gradeFallback = alias(boardClimbGrades, GRADE_FALLBACK_ALIAS);

/**
 * The upstream grade-range filter written for the stats-driven list in
 * search-climbs.ts: a query whose FROM is `board_climb_stats` at the browsed
 * angle INNER JOIN `board_climbs`, with NO `board_climb_grades` join before its
 * LIMIT.
 *
 *   ROUND(display_difficulty) <range>
 *   OR (ROUND(display_difficulty) IS NULL
 *       AND EXISTS (Boardsesh grade at this angle <range>))
 *
 * That is the same test as `gradeValueSql(..., upstream) <range>`, i.e.
 * `COALESCE(ROUND(display_difficulty), ROUND(Boardsesh grade)) <range>`: when
 * the rounded difficulty is set only the first arm can be true, and when it is
 * NULL only the second can. `board_climb_grades` has one row per (board_type,
 * climb_uuid, angle) (its primary key), so the EXISTS is the LEFT JOIN's row.
 * Both arms keep the `::numeric` cast: ROUND(double precision) breaks .5 ties
 * the other way, so dropping it would move a climb across a band edge.
 *
 * Why split it: the COALESCE form needs the grades row for EVERY row the plan
 * visits, and those primary-key probes into the 1.3 GB grades table were most of
 * the disk reads in this query. Here only a climb without a difficulty (a few
 * thousand per board and angle) pays for a grades probe.
 *
 * Two details are load-bearing for the plan, both measured on the production
 * replica across 22 board/band combinations:
 *
 *  - The EXISTS correlates to `board_climbs.uuid`, not to the equal
 *    `board_climb_stats.climb_uuid`. That makes the OR a join-level clause, so
 *    the planner costs the join the way it did for the COALESCE form. Correlated
 *    to the stats row instead, the whole OR is pushed into the stats scan with
 *    an accurate band estimate; next to the planner's 30x underestimate of the
 *    `board_climbs` side (the `required_set_ids <@` / `compatible_size_ids @>`
 *    array filters) that tipped Kilter Original V0-V1 and V3-V4 into probing the
 *    stats row of all 283k climbs on the layout: 1.9 s, against 1 ms here.
 *  - The NULL test is on `ROUND(display_difficulty::numeric, 0)`, not the bare
 *    column. Postgres still derives `band OR rounded IS NULL` from the OR as a
 *    restriction on the stats scan, and in this spelling both halves match
 *    `board_climb_stats_difficulty_rounded_idx`, so a narrow band BitmapOrs
 *    straight out of that index: Kilter Original V14-V16 went from 1.6 s /
 *    1.06M buffers to 19 ms / 12k.
 *
 * Returns `null` when neither bound is set.
 */
function statsRowGradeRangeSql(
  boardType: string,
  angle: number,
  minGrade: number | undefined,
  maxGrade: number | undefined,
): SQL | null {
  const upstreamInRange = gradeInRangeSql(
    sql`ROUND(${boardClimbStats.displayDifficulty}::numeric, 0)`,
    minGrade,
    maxGrade,
  );
  const boardseshInRange = gradeInRangeSql(
    sql`ROUND(COALESCE(${gradeFallback.universalGrade}, ${gradeFallback.localGrade})::numeric, 0)`,
    minGrade,
    maxGrade,
  );
  if (!upstreamInRange || !boardseshInRange) return null;
  return sql`(${upstreamInRange} OR (ROUND(${boardClimbStats.displayDifficulty}::numeric, 0) IS NULL AND EXISTS (
    SELECT 1 FROM ${boardClimbGrades} AS ${sql.identifier(GRADE_FALLBACK_ALIAS)}
    WHERE ${gradeFallback.boardType} = ${boardType}
    AND ${gradeFallback.climbUuid} = ${boardClimbs.uuid}
    AND ${gradeFallback.angle} = ${angle}
    AND ${boardseshInRange}
  )))`;
}

/**
 * Creates a shared filtering object for climb search and heatmap queries.
 * Uses unified tables (board_climbs, board_climb_stats, etc.) with board_type filtering.
 *
 * @param params Board route parameters (board_name, layout_id, etc.)
 * @param searchParams Search/filter parameters
 * @param userId Optional user ID for personal progress filters
 * @param options.crossAngleStats Resolve stats through the climb's set angle when
 *   the browsed angle has none (issue #5405). It is an explicit OPT-IN, never
 *   derived here, because a holds heatmap query (see
 *   `getHoldHeatmapClimbStatsConditions`) reuses these same condition arrays
 *   from a query that drives off `board_climb_holds` and has no `board_climbs`
 *   in its FROM at all. A set-angle reference baked in on the
 *   board's behalf would make that query fail to plan on exactly the boards the
 *   fix is for. The heatmap passes nothing and its SQL is unchanged.
 * @param options.restrictToBrowsedAngle Keep only the climbs that belong to the
 *   browsed angle (issue #5642) — see `browsedAngleRestrictionSql` in
 *   ./effective-stats. Opt-in for the same reason as `crossAngleStats`: the
 *   predicate probes the browsed-angle `board_climb_stats` join and names
 *   `board_climbs.angle`, and the heatmap's FROM has neither. Callers pass
 *   `resolveBrowsedAngleRestriction`; this builder then drops it for a drafts
 *   query and under cross-angle, and reports the outcome as
 *   `isBrowsedAngleRestricted`.
 */
export const createClimbFilters = (
  params: BoardRouteParams,
  searchParams: ClimbSearchParams,
  userId?: string,
  options?: { crossAngleStats?: boolean; restrictToBrowsedAngle?: boolean },
) => {
  const crossAngle = options?.crossAngleStats === true;
  // Reads one stats column from the effective row. Every call shares one
  // row-presence probe, which is what lets a multi-column predicate below
  // (gradeAccuracy) be sure both of its columns describe the same real row.
  const statsCol = (key: StatsColumnKey) => effectiveStatsColumn(key, crossAngle);
  // holdsFilter shape: Record<holdId, Partial<Record<HoldFilterType, 'include' | 'exclude'>>>.
  // ANY means "hold present in any state" (the wildcard); STARTING / HAND /
  // FOOT / FINISH require / forbid the hold appearing with that specific
  // state in board_climb_holds.
  const anyHolds: number[] = [];
  const notHolds: number[] = [];
  const holdStateFilters: Array<{ holdId: number; state: string; mode: 'include' | 'exclude' }> = [];

  for (const [keyRaw, entry] of Object.entries(searchParams.holdsFilter || {})) {
    // Hold ids are 0-based on Woods, so the guard can't reject non-positive ids the
    // way it used to — the first hold of every Woods board would be unfilterable.
    // `Number('')` is 0 too, so check the key really is digits instead of leaning
    // on the parsed number alone. The offline mirror of this parser lives in
    // packages/mobile/src/db/queries/search-climbs-local.ts and must agree — as
    // must the community-hidden rule this file applies below
    // (`hiddenClimbCondition`), which that same file mirrors.
    const holdKey = keyRaw.replace('hold_', '');
    const holdId = Number(holdKey);
    if (!/^\d+$/.test(holdKey) || !Number.isSafeInteger(holdId) || !entry || typeof entry !== 'object') continue;
    for (const [type, mode] of Object.entries(entry as Record<string, unknown>)) {
      if (mode !== 'include' && mode !== 'exclude') continue;
      if (type === 'ANY') {
        if (mode === 'include') anyHolds.push(holdId);
        else notHolds.push(holdId);
      } else if (type === 'STARTING' || type === 'HAND' || type === 'FOOT' || type === 'FINISH') {
        holdStateFilters.push({ holdId, state: type, mode });
      }
    }
  }

  // When onlyDrafts is enabled, show ONLY the user's own draft climbs.
  // Draft climbs can be owned via userId (locally created or JSON-imported)
  // or via setterId (Aurora-synced).
  const isOnlyDrafts = searchParams.onlyDrafts && userId;

  const userOwnershipCondition = userId
    ? or(
        eq(boardClimbs.userId, userId),
        sql`${boardClimbs.setterId} = (
          SELECT ubm.board_user_id FROM user_board_mappings ubm
          WHERE ubm.user_id = ${userId}
          AND ubm.board_type = ${params.board_name}
          LIMIT 1
        )`,
      )!
    : sql`false`;

  const isDraftCondition: SQL = isOnlyDrafts
    ? and(eq(boardClimbs.isDraft, true), userOwnershipCondition)!
    : eq(boardClimbs.isDraft, false);

  // When showing only drafts, skip the isListed filter (drafts are never listed)
  const isListedCondition: SQL | null = isOnlyDrafts ? null : eq(boardClimbs.isListed, true);

  // Angle-bound boards keep only the climbs that belong to the browsed angle
  // (issue #5642). Two exemptions are decided here rather than in
  // `resolveBrowsedAngleRestriction`, because only this builder knows them:
  //   - a user's own drafts list shows every draft, whatever angle it was saved
  //     at — the same list-everything-I-own reading that skips the size and stats
  //     filters for drafts in searchClimbs / countClimbs;
  //   - under cross-angle the search wants every angle, so a caller passing both
  //     options gets cross-angle rather than a contradiction.
  // Both searchClimbs and countClimbs build their WHERE from
  // `getClimbWhereConditions`, which is where this lands, so the list and the
  // count badge above it cannot disagree about it.
  const isBrowsedAngleRestricted = options?.restrictToBrowsedAngle === true && !isOnlyDrafts && !crossAngle;
  const browsedAngleConditions: SQL[] = isBrowsedAngleRestricted ? [browsedAngleRestrictionSql(params.angle)] : [];

  // Boulders / routes filter. Both selected (or both falsy — treated as "no
  // preference") → omit the frames_count constraint entirely. Boulders only →
  // `frames_count = 1`. Routes only → `frames_count > 1`.
  //
  // frames_count is currently NULLABLE in the schema; NULL is legacy
  // pre-migration data and should be treated as single-frame (boulder). The
  // boulders-only branch therefore OR-includes NULL. Follow-up migration
  // (tracked separately) will backfill NULLs to 1 and add NOT NULL, after
  // which the isNull() branch can be dropped.
  const wantsBoulders = !!searchParams.boulders;
  const wantsRoutes = !!searchParams.routes;
  const climbTypeCondition: SQL | null =
    wantsBoulders && !wantsRoutes
      ? or(eq(boardClimbs.framesCount, 1), isNull(boardClimbs.framesCount))!
      : wantsRoutes && !wantsBoulders
        ? gt(boardClimbs.framesCount, 1)
        : null;

  // Base conditions for filtering climbs
  const baseConditions: SQL[] = [
    eq(boardClimbs.boardType, params.board_name),
    eq(boardClimbs.layoutId, params.layout_id),
    ...(isListedCondition ? [isListedCondition] : []),
    isDraftCondition,
    ...hiddenClimbCondition(searchParams),
    ...holdIntegrityCondition(searchParams),
    ...(climbTypeCondition ? [climbTypeCondition] : []),
  ];

  // Size filter: check if this climb fits on the selected board size.
  // Uses denormalized compatible_size_ids array (pre-computed from edge comparison).
  // Use array containment so PostgreSQL can use board_climbs_compatible_size_ids_idx.
  // PostgreSQL's built-in GIN array_ops supports @> for integer[]; no intarray
  // extension or custom operator class is required for this index.
  // MoonBoard has a single fixed size, so skip.
  const sizeConditions: SQL[] =
    params.board_name === 'moonboard' ? [] : [sql`${boardClimbs.compatibleSizeIds} @> ARRAY[${params.size_id}]::int[]`];

  // Projects-only: match climbs with 0 ascents OR no stats row at all.
  // Must live outside climbStatsConditions so it doesn't trigger the stats-driven
  // INNER JOIN path (which would exclude no-stats climbs).
  const projectsOnlyConditions: SQL[] = searchParams.projectsOnly
    ? [sql`COALESCE(${statsCol('ascensionistCount')}, 0) = 0`]
    : [];

  // Personal grades (#4828). Active only for a signed-in climber who asked for
  // it, and never on a drafts query — drafts have no stats row, so the whole
  // grade filter is skipped there today and staying consistent matters more
  // than filtering a handful of self-owned drafts.
  //
  // `personalGradeScope` is also what the sort and the projection read: when it
  // is null they key on the crowd's grade exactly as before.
  const personalGradeScope: PersonalGradeScope | null =
    searchParams.useMyGrades && userId && !isOnlyDrafts
      ? { boardType: params.board_name, angle: params.angle, userId }
      : null;

  // The subquery every personal-grade query joins, built once here so the
  // filter, the sort and the projection all read the same alias. Null exactly
  // when `personalGradeScope` is.
  const personalGradeJoin: PersonalGradeJoinTarget | null = personalGradeScope
    ? buildPersonalGradeJoinTarget(personalGradeScope)
    : null;

  // Conditions for climb stats
  const climbStatsConditions: SQL[] = [];
  // Grade-range conditions, kept separate from climbStatsConditions — see the
  // comment above the minGrade/maxGrade block below for why.
  const gradeRangeConditions: SQL[] = [];

  // Skip minAscents when projectsOnly is active (they're mutually exclusive in the UI,
  // but guard here too so a stale query param can't produce a contradictory filter).
  if (searchParams.minAscents && !searchParams.projectsOnly) {
    climbStatsConditions.push(sql`${statsCol('ascensionistCount')} >= ${searchParams.minAscents}`);
  }

  // Grade range: the legacy crowd/setter grade (display_difficulty) when a stats
  // row exists, falling back to the Boardsesh grade when it doesn't — a climb at
  // a MoonBoard wide angle (moonboard-wide-angles flag), or an unclimbed angle
  // whose cross-angle projection is published, has a board_climb_grades row but
  // no board_climb_stats row at all, so display_difficulty is NULL there. Kept
  // out of `climbStatsConditions` on purpose: that bucket drives the INNER JOIN
  // stats-driven-only routing decision in search-climbs.ts (a real evidence
  // requirement — minAscents/minRating/onlyBenchmarks/gradeAccuracy genuinely
  // can't be satisfied by a stats-less climb), whereas a grade-range filter now
  // CAN match one, so it must not force that INNER JOIN and drop it.
  // Reads through `statsCol` (not the raw column) so this composes with the
  // cross-angle fallback above: under cross-angle, a climb with no stats at the
  // browsed angle but one at its set angle already resolves a real
  // display_difficulty there, and only a climb with NO stats row at either angle
  // falls all the way through to the Boardsesh grade.
  // `gradeSource: 'boardsesh'` swaps the order — see `gradeValueSql`.
  //
  // Personal grades (#4828) wrap this same value rather than replacing it:
  // COALESCE(my grade, gradeRangeValue). A climb the climber graded is admitted
  // on THEIR number, every other climb on exactly the value above. Applying the
  // crowd range as well would AND two different grades together and hide every
  // climb whose grades disagree — precisely the set the feature exists for.
  const gradeRangeValue = gradeValueSql(statsCol('displayDifficulty'), searchParams.gradeSource);
  if (personalGradeScope) {
    const rangeCondition = personalGradeRangeCondition(gradeRangeValue, searchParams.minGrade, searchParams.maxGrade);
    if (rangeCondition) gradeRangeConditions.push(rangeCondition);
  } else if (searchParams.minGrade && searchParams.maxGrade) {
    gradeRangeConditions.push(sql`${gradeRangeValue} BETWEEN ${searchParams.minGrade} AND ${searchParams.maxGrade}`);
  } else if (searchParams.minGrade) {
    gradeRangeConditions.push(sql`${gradeRangeValue} >= ${searchParams.minGrade}`);
  } else if (searchParams.maxGrade) {
    gradeRangeConditions.push(sql`${gradeRangeValue} <= ${searchParams.maxGrade}`);
  }

  // The same grade range for the stats-driven list, which reads no
  // board_climb_grades join before its LIMIT — see `statsRowGradeRangeSql`.
  // `null` means the filter has to read the joined grades row (the Boardsesh
  // source reads it first, personal grades wrap the joined value, and
  // cross-angle resolves the grade at another angle), so the caller must keep
  // the join inside the query and use `getClimbStatsConditions()` instead.
  // Cross-angle is null even without a band: every `statsCol` predicate then
  // reads the effective-stats join, which the stats-driven FROM does not carry.
  // An empty list means there is no grade filter at all.
  const statsRowGradeRangeConditions: SQL[] | null = (() => {
    if (crossAngle) return null;
    if (gradeRangeConditions.length === 0) return [];
    if (personalGradeScope || searchParams.gradeSource === 'boardsesh') return null;
    const condition = statsRowGradeRangeSql(
      params.board_name,
      params.angle,
      searchParams.minGrade,
      searchParams.maxGrade,
    );
    return condition ? [condition] : null;
  })();

  if (searchParams.minRating) {
    // qualityAverage is canonical 1-5 (migrations 0115/0116 backfilled Aurora's 1-3
    // scale to 1-5; MoonBoard is native 0-5), and minRating arrives as whole stars
    // 1-5, so compare directly. The old `/5` divisor assumed a 0-1 scale and made the
    // filter a near no-op — minRating=4 became threshold 0.8, which kept ~every rated
    // climb (verified on prod: 348014/348014 kilter rows passed).
    climbStatsConditions.push(sql`${statsCol('qualityAverage')} >= ${searchParams.minRating}`);
  }

  if (searchParams.gradeAccuracy) {
    // Two stats columns in one predicate. Under cross-angle both go through
    // `statsCol`, which shares a single row-presence probe, so they can never end
    // up describing different rows — a per-column COALESCE would allow exactly
    // that whenever the browsed-angle row carries a NULL difficulty_average.
    climbStatsConditions.push(
      sql`ABS(ROUND(${statsCol('displayDifficulty')}::numeric, 0) - ${statsCol('difficultyAverage')}::numeric) <= ${searchParams.gradeAccuracy}`,
    );
  }

  // Benchmark/classic-only: imported board feeds mark these climbs with a
  // positive benchmark_difficulty. Zero and NULL both mean "not flagged".
  if (searchParams.onlyBenchmarks) {
    climbStatsConditions.push(sql`${statsCol('benchmarkDifficulty')} > 0`);
  }

  // Name search condition. The shared pattern builder escapes the user's own
  // LIKE metacharacters (so "50%" and "a_b" match literally) and folds the
  // punctuation and spacing that made a typed full name miss (#5353). The
  // offline SQLite search uses the same builder.
  const nameCondition: SQL[] = searchParams.name
    ? [sql`${boardClimbs.name} ILIKE ${climbNameLikePattern(searchParams.name)}`]
    : [];

  // Setter name filter condition
  const setterNameCondition: SQL[] =
    searchParams.settername && searchParams.settername.length > 0
      ? [inArray(boardClimbs.setterUsername, searchParams.settername)]
      : [];

  // Hold filter conditions
  // Match the exact `p<holdId>r` token, not a bare `<holdId>r` substring. Frames
  // are concatenated `p<placementId>r<roleCode>` tokens (see board-constants
  // hold-states), so `%30r%` also matches `p130r…`/`p230r…` — wrongly including
  // (and via notLike wrongly excluding) climbs that don't use the hold. Anchoring
  // on the leading `p` fixes it on every board, since every token starts with `p`.
  // Measured on prod: `hold_1` via the old pattern falsely matched ~230k kilter climbs.
  // (A future migration may switch this to a board_climb_holds EXISTS probe, but that
  // table is not yet complete — ~8.9k kilter climbs lack holds rows — so the anchored
  // LIKE is the correct fix today.)
  const holdConditions: SQL[] = [
    ...anyHolds.map((holdId) => like(boardClimbs.frames, `%p${holdId}r%`)),
    ...notHolds.map((holdId) => notLike(boardClimbs.frames, `%p${holdId}r%`)),
  ];

  // State-specific hold conditions — use board_climb_holds. Multiple types
  // on the same hold are OR-combined within their mode: HAND:include +
  // FOOT:include means "hold is HAND OR FOOT" (a hold has only one state in
  // any given climb, so AND would always be empty). Same for excludes.
  const includesByHold = new Map<number, string[]>();
  const excludesByHold = new Map<number, string[]>();
  for (const { holdId, state, mode } of holdStateFilters) {
    const target = mode === 'include' ? includesByHold : excludesByHold;
    const states = target.get(holdId) ?? [];
    states.push(state);
    target.set(holdId, states);
  }
  const holdStateConditions: SQL[] = [];
  for (const [holdId, states] of includesByHold) {
    const stateLiterals = sql.join(
      states.map((s) => sql`${s}`),
      sql`, `,
    );
    holdStateConditions.push(sql`EXISTS (
      SELECT 1 FROM ${boardClimbHolds} ch
      WHERE ch.board_type = ${params.board_name}
      AND ch.climb_uuid = ${boardClimbs.uuid}
      AND ch.hold_id = ${holdId}
      AND ch.hold_state IN (${stateLiterals})
    )`);
  }
  for (const [holdId, states] of excludesByHold) {
    const stateLiterals = sql.join(
      states.map((s) => sql`${s}`),
      sql`, `,
    );
    holdStateConditions.push(sql`NOT EXISTS (
      SELECT 1 FROM ${boardClimbHolds} ch
      WHERE ch.board_type = ${params.board_name}
      AND ch.climb_uuid = ${boardClimbs.uuid}
      AND ch.hold_id = ${holdId}
      AND ch.hold_state IN (${stateLiterals})
    )`);
  }

  // Zone filter — restrict climbs by the user-defined box in board grid
  // coordinates. Aurora boards keep the denormalized `allHolds` path.
  // MoonBoard uses calibrated layout placements for both modes because its
  // climbs intentionally do not carry denormalized edge columns. Woods has
  // neither placements nor edge columns and resolves the box against its hold
  // geometry in TypeScript (see the branch below).
  // Direct db-layer callers bypass GraphQL validation, so re-check the box.
  const zoneBox = searchParams.zoneBox;
  const hasZoneBox = !!zoneBox;
  const validZoneBox =
    zoneBox && zoneBox.edgeRight > zoneBox.edgeLeft && zoneBox.edgeTop > zoneBox.edgeBottom ? zoneBox : null;
  const zoneMode = searchParams.zoneMode === 'anyHold' ? 'anyHold' : 'allHolds';
  const zoneConditions: SQL[] = [];
  if (hasZoneBox && !validZoneBox) {
    // A zone was requested but the box is degenerate (crafted/stale params). Fail
    // closed like the tall/wide filters below rather than returning every climb.
    zoneConditions.push(sql`false`);
  } else if (validZoneBox) {
    if (params.board_name === 'woods') {
      // Woods is code-driven: there are no `board_placements` / `board_holes`
      // rows to read a hold's coordinates from, and its climbs carry no
      // denormalized `edge_*`, so both paths below match nothing at all
      // (boardsesh/boardsesh#4748). Resolve the box in TypeScript instead —
      // `woodsHoldIdsInZone` walks the same detected hold centres the picker drew
      // the box over — and filter on hold ids, which `board_climb_holds` stores
      // directly. Its primary key is (board_type, climb_uuid, hold_id), so each
      // probe below is an index lookup.
      //
      // The two Woods sizes reuse the same hold ids for different physical holds,
      // so the id set is per-size; the `compatible_size_ids` filter above is what
      // keeps the other size's climbs out of the results.
      //
      // The id list needs no cap the way `holdsFilter` does: it isn't user input,
      // it's a subset of one board size's hold table, so it tops out at the 894
      // holds of a 12x12 no matter what box arrives.
      const zoneHoldIds = woodsHoldIdsInZone(params.size_id, validZoneBox);
      if (!zoneHoldIds || zoneHoldIds.length === 0) {
        // An unknown size id, or a box drawn over bare board. No climb can match
        // either way, and returning everything would be worse than nothing — so
        // fail closed like the degenerate-box case above.
        zoneConditions.push(sql`false`);
      } else if (zoneMode === 'anyHold') {
        zoneConditions.push(sql`EXISTS (
          SELECT 1
          FROM ${boardClimbHolds} zone_ch
          WHERE zone_ch.board_type = ${params.board_name}
            AND zone_ch.climb_uuid = ${boardClimbs.uuid}
            AND zone_ch.hold_id = ANY(${intArrayLiteral(zoneHoldIds)})
        )`);
      } else {
        // allHolds: every hold of the climb must fit inside the box — i.e. the
        // climb has holds, and none of them is outside it. Same shape as the
        // MoonBoard containment branch, where the leading EXISTS is what stops a
        // climb with no hold rows at all from matching vacuously.
        //
        // "Outside" is phrased as the complement of the in-box ids rather than as
        // its own list, so a hold id the geometry doesn't know — a corrupt row, or
        // one from a catalog newer than these constants — counts as outside rather
        // than being silently waved through. It also binds the smaller array for
        // the boxes people actually draw.
        zoneConditions.push(
          sql`EXISTS (
            SELECT 1
            FROM ${boardClimbHolds} zone_ch
            WHERE zone_ch.board_type = ${params.board_name}
              AND zone_ch.climb_uuid = ${boardClimbs.uuid}
          )`,
          sql`NOT EXISTS (
            SELECT 1
            FROM ${boardClimbHolds} zone_ch
            WHERE zone_ch.board_type = ${params.board_name}
              AND zone_ch.climb_uuid = ${boardClimbs.uuid}
              AND NOT (zone_ch.hold_id = ANY(${intArrayLiteral(zoneHoldIds)}))
          )`,
        );
      }
    } else if (zoneMode === 'anyHold') {
      const zonePlacementMatch = climbHoldPlacementMatchSql({
        boardType: sql.raw('zone_ch.board_type'),
        climbHoldId: sql.raw('zone_ch.hold_id'),
        placementId: sql.raw('zone_bp.id'),
        placementHoleId: sql.raw('zone_bp.hole_id'),
      });
      const zonePlacementSetCondition =
        params.board_name === 'moonboard' || params.set_ids.length === 0
          ? sql``
          : sql`AND zone_bp.set_id IN (${sql.join(
              params.set_ids.map((setId) => sql`${setId}`),
              sql`, `,
            )})`;
      const zoneCoordinates =
        params.board_name === 'moonboard'
          ? moonBoardZoneCoordinates(params.layout_id, sql.raw('zone_bp.hole_id'))
          : { x: sql.raw('zone_bh.x'), y: sql.raw('zone_bh.y') };
      zoneConditions.push(sql`EXISTS (
        SELECT 1
        FROM ${boardClimbHolds} zone_ch
        JOIN ${boardPlacements} zone_bp
          ON zone_bp.board_type = zone_ch.board_type
          AND ${zonePlacementMatch}
          AND zone_bp.layout_id = ${params.layout_id}
        JOIN ${boardHoles} zone_bh
          ON zone_bh.board_type = zone_ch.board_type
          AND zone_bh.id = zone_bp.hole_id
        WHERE zone_ch.board_type = ${params.board_name}
          AND zone_ch.climb_uuid = ${boardClimbs.uuid}
          ${zonePlacementSetCondition}
          AND ${zoneCoordinates.x} >= ${validZoneBox.edgeLeft}
          AND ${zoneCoordinates.x} <= ${validZoneBox.edgeRight}
          AND ${zoneCoordinates.y} >= ${validZoneBox.edgeBottom}
          AND ${zoneCoordinates.y} <= ${validZoneBox.edgeTop}
      )`);
    } else if (params.board_name === 'moonboard') {
      const containedPlacementMatch = climbHoldPlacementMatchSql({
        boardType: sql.raw('contained_ch.board_type'),
        climbHoldId: sql.raw('contained_ch.hold_id'),
        placementId: sql.raw('contained_bp.id'),
        placementHoleId: sql.raw('contained_bp.hole_id'),
      });
      const containedCoordinates = moonBoardZoneCoordinates(params.layout_id, sql.raw('contained_bp.hole_id'));
      zoneConditions.push(
        sql`EXISTS (
          SELECT 1
          FROM ${boardClimbHolds} contained_ch
          WHERE contained_ch.board_type = ${params.board_name}
            AND contained_ch.climb_uuid = ${boardClimbs.uuid}
        )`,
        sql`NOT EXISTS (
          SELECT 1
          FROM ${boardClimbHolds} contained_ch
          WHERE contained_ch.board_type = ${params.board_name}
            AND contained_ch.climb_uuid = ${boardClimbs.uuid}
            AND NOT EXISTS (
              SELECT 1
              FROM ${boardPlacements} contained_bp
              JOIN ${boardHoles} contained_bh
                ON contained_bh.board_type = contained_bp.board_type
                AND contained_bh.id = contained_bp.hole_id
              WHERE contained_bp.board_type = contained_ch.board_type
                AND contained_bp.layout_id = ${params.layout_id}
                AND ${containedPlacementMatch}
                AND ${containedCoordinates.x} >= ${validZoneBox.edgeLeft}
                AND ${containedCoordinates.x} <= ${validZoneBox.edgeRight}
                AND ${containedCoordinates.y} >= ${validZoneBox.edgeBottom}
                AND ${containedCoordinates.y} <= ${validZoneBox.edgeTop}
            )
        )`,
      );
    } else {
      zoneConditions.push(
        sql`${boardClimbs.edgeLeft} >= ${validZoneBox.edgeLeft}`,
        sql`${boardClimbs.edgeRight} <= ${validZoneBox.edgeRight}`,
        sql`${boardClimbs.edgeBottom} >= ${validZoneBox.edgeBottom}`,
        sql`${boardClimbs.edgeTop} <= ${validZoneBox.edgeTop}`,
      );
    }
  }

  // Tall / Wide climbs filters. A climb is "tall"/"wide" when it can't be done
  // on any size of the active layout's product family that is shorter/narrower
  // than the active size — i.e. its denormalized compatible_size_ids overlaps
  // none of the shorter/narrower family sizes. getTallWideScope is the single
  // source of truth (shared with the mobile offline search and every UI chip);
  // it fails closed (empty sets) when the active size is the shortest/narrowest
  // in its axis or the (board, layout, size) is unknown/mismatched, so a
  // stale/crafted request stays restrictive (`false`) instead of returning
  // everything. Works on every board with a size grid — Kilter Homewall &
  // Original, Tension Board 2, Decoy, Grasshopper — and no-ops on single-size
  // boards (MoonBoard, Touchstone).
  const { narrowerSizeIds, shorterSizeIds, hasNarrower, hasShorter } = getTallWideScope(
    params.board_name,
    params.layout_id,
    params.size_id,
  );

  // The explicit `IS NOT NULL` guard mirrors the mobile offline path
  // (search-climbs-local.ts) and makes the intent obvious: a climb whose
  // compatible_size_ids is NULL isn't classifiable, so it's not tall/wide.
  // (`NOT (NULL && …)` is already NULL — falsy in WHERE — so this is a
  // readability/parity change, not a behavior change.)
  const tallClimbsConditions: SQL[] = [];
  if (searchParams.onlyTallClimbs) {
    tallClimbsConditions.push(
      hasShorter
        ? sql`${boardClimbs.compatibleSizeIds} IS NOT NULL AND NOT (${boardClimbs.compatibleSizeIds} && ${intArrayLiteral(shorterSizeIds)})`
        : sql`false`,
    );
  }

  const wideClimbsConditions: SQL[] = [];
  if (searchParams.onlyWideClimbs) {
    wideClimbsConditions.push(
      hasNarrower
        ? sql`${boardClimbs.compatibleSizeIds} IS NOT NULL AND NOT (${boardClimbs.compatibleSizeIds} && ${intArrayLiteral(narrowerSizeIds)})`
        : sql`false`,
    );
  }

  // Beta-videos filter: keep only climbs that have at least one beta link the
  // user could actually watch (is_listed true or NULL — exclude explicitly
  // hidden links). Applies on every board, unlike the size-gated tall/wide
  // filters above.
  const betaVideosConditions: SQL[] = [];

  if (searchParams.onlyWithBetaVideos) {
    betaVideosConditions.push(sql`EXISTS (
      SELECT 1
      FROM ${boardBetaLinks} bl
      WHERE bl.board_type = ${params.board_name}
        AND bl.climb_uuid = ${boardClimbs.uuid}
        AND bl.is_listed IS NOT FALSE
    )`);
  }

  // Set membership filter: exclude climbs that use holds from sets the user doesn't own.
  // The <@ operator checks that every set a climb requires is in the user's selected sets.
  //
  // required_set_ids is denormalized: Aurora derives it from placements, MoonBoard from
  // the grid cell -> set map (see populateMoonBoardRequiredSetIds). It can be NULL for
  // freshly saved drafts (populated asynchronously) and for MoonBoard climbs not yet
  // backfilled, so allow NULL in those cases — better to show a climb than hide it.
  const allowNullRequiredSets = isOnlyDrafts || params.board_name === 'moonboard';
  const setIdsConditions: SQL[] =
    params.set_ids.length === 0
      ? []
      : [
          allowNullRequiredSets
            ? sql`(${boardClimbs.requiredSetIds} IS NULL OR ${boardClimbs.requiredSetIds} <@ ARRAY[${sql.join(
                params.set_ids.map((id) => sql`${id}`),
                sql`, `,
              )}]::int[])`
            : sql`${boardClimbs.requiredSetIds} <@ ARRAY[${sql.join(
                params.set_ids.map((id) => sql`${id}`),
                sql`, `,
              )}]::int[]`,
        ];

  // Personal progress filter conditions
  const personalProgressConditions: SQL[] = [];
  if (userId) {
    if (searchParams.hideAttempted) {
      // Hide climbs where the user has at least one attempt tick
      personalProgressConditions.push(
        sql`NOT EXISTS (
          SELECT 1 FROM ${boardseshTicks}
          WHERE ${boardseshTicks.climbUuid} = ${boardClimbs.uuid}
          AND ${boardseshTicks.userId} = ${userId}
          AND ${boardseshTicks.boardType} = ${params.board_name}
          AND ${boardseshTicks.angle} = ${params.angle}
          AND ${boardseshTicks.status} = 'attempt'
        )`,
      );
    }

    if (searchParams.hideCompleted) {
      personalProgressConditions.push(
        sql`NOT EXISTS (
          SELECT 1 FROM ${boardseshTicks}
          WHERE ${boardseshTicks.climbUuid} = ${boardClimbs.uuid}
          AND ${boardseshTicks.userId} = ${userId}
          AND ${boardseshTicks.boardType} = ${params.board_name}
          AND ${boardseshTicks.angle} = ${params.angle}
          AND ${boardseshTicks.status} IN ('flash', 'send')
        )`,
      );
    }

    if (searchParams.showOnlyAttempted) {
      // Show only climbs where the user has an attempt tick
      personalProgressConditions.push(
        sql`EXISTS (
          SELECT 1 FROM ${boardseshTicks}
          WHERE ${boardseshTicks.climbUuid} = ${boardClimbs.uuid}
          AND ${boardseshTicks.userId} = ${userId}
          AND ${boardseshTicks.boardType} = ${params.board_name}
          AND ${boardseshTicks.angle} = ${params.angle}
          AND ${boardseshTicks.status} = 'attempt'
        )`,
      );
    }

    if (searchParams.showOnlyCompleted) {
      personalProgressConditions.push(
        sql`EXISTS (
          SELECT 1 FROM ${boardseshTicks}
          WHERE ${boardseshTicks.climbUuid} = ${boardClimbs.uuid}
          AND ${boardseshTicks.userId} = ${userId}
          AND ${boardseshTicks.boardType} = ${params.board_name}
          AND ${boardseshTicks.angle} = ${params.angle}
          AND ${boardseshTicks.status} IN ('flash', 'send')
        )`,
      );
    }

    // Personal rating filters, read straight off the user's ticks at the
    // browsed angle (same scope as the four flags above, and the same scope the
    // community quality_average is stored at).
    //
    // Both cases are written as EXISTS / NOT EXISTS on purpose. A scalar
    // `(SELECT quality … ORDER BY climbed_at DESC LIMIT 1)` correlated
    // subquery cannot be unnested, so Postgres runs it once per candidate
    // climb — measured at 2-3x the unfiltered baseline on the dev DB
    // (220k candidates). These forms unnest into semi/anti joins that the
    // planner can drive from boardsesh_ticks instead, landing at or below
    // baseline.
    if (searchParams.onlyRatedByMe) {
      personalProgressConditions.push(
        sql`EXISTS (
          SELECT 1 FROM ${boardseshTicks}
          WHERE ${boardseshTicks.climbUuid} = ${boardClimbs.uuid}
          AND ${boardseshTicks.userId} = ${userId}
          AND ${boardseshTicks.boardType} = ${params.board_name}
          AND ${boardseshTicks.angle} = ${params.angle}
          AND ${boardseshTicks.quality} IS NOT NULL
        )`,
      );
    }

    if (searchParams.minUserRating) {
      // "The user's LATEST rating is not below N", expressed as an anti-join:
      // exclude the climb when a rated tick below N exists that no newer rated
      // tick supersedes. Re-rating a climb upward therefore lets it back in,
      // and a climb the user never rated has no offending tick, so it stays
      // visible (pair with onlyRatedByMe to drop those too). The (climbed_at,
      // id) row comparison breaks same-timestamp ties by insertion order.
      personalProgressConditions.push(
        sql`NOT EXISTS (
          SELECT 1 FROM ${boardseshTicks} AS rating_below
          WHERE rating_below.climb_uuid = ${boardClimbs.uuid}
          AND rating_below.user_id = ${userId}
          AND rating_below.board_type = ${params.board_name}
          AND rating_below.angle = ${params.angle}
          AND rating_below.quality IS NOT NULL
          AND rating_below.quality < ${searchParams.minUserRating}
          AND NOT EXISTS (
            SELECT 1 FROM ${boardseshTicks} AS rating_newer
            WHERE rating_newer.climb_uuid = rating_below.climb_uuid
            AND rating_newer.user_id = rating_below.user_id
            AND rating_newer.board_type = rating_below.board_type
            AND rating_newer.angle = rating_below.angle
            AND rating_newer.quality IS NOT NULL
            AND (rating_newer.climbed_at, rating_newer.id) > (rating_below.climbed_at, rating_below.id)
          )
        )`,
      );
    }
  }

  // User-specific logbook data selectors using boardsesh_ticks
  const getUserLogbookSelects = () => {
    return {
      userAscents: sql<number>`(
        SELECT COUNT(*)
        FROM ${boardseshTicks}
        WHERE ${boardseshTicks.climbUuid} = ${boardClimbs.uuid}
        AND ${boardseshTicks.userId} = ${userId || ''}
        AND ${boardseshTicks.boardType} = ${params.board_name}
        AND ${boardseshTicks.angle} = ${params.angle}
        AND ${boardseshTicks.status} IN ('flash', 'send')
      )`,
      userAttempts: sql<number>`(
        SELECT COUNT(*)
        FROM ${boardseshTicks}
        WHERE ${boardseshTicks.climbUuid} = ${boardClimbs.uuid}
        AND ${boardseshTicks.userId} = ${userId || ''}
        AND ${boardseshTicks.boardType} = ${params.board_name}
        AND ${boardseshTicks.angle} = ${params.angle}
        AND ${boardseshTicks.status} = 'attempt'
      )`,
    };
  };

  return {
    // True only when this is genuinely a user's drafts query (onlyDrafts AND a
    // userId to own them). Callers MUST derive their isDraftsQuery flag from this,
    // not from `!!searchParams.onlyDrafts`: onlyDrafts without a userId is not a
    // drafts query, and the two predicates disagreeing made searchClimbs skip the
    // size/stats filters and force creation sort while the filters still required
    // listed non-drafts. See searchClimbs / countClimbs.
    isOnlyDrafts: Boolean(isOnlyDrafts),
    /** Whether the WHERE below carries the browsed-angle restriction (issue
     *  #5642) — `restrictToBrowsedAngle` after the drafts and cross-angle
     *  exemptions. Read it back rather than re-deriving it. */
    isBrowsedAngleRestricted,
    getClimbWhereConditions: () => [
      ...baseConditions,
      ...browsedAngleConditions,
      ...nameCondition,
      ...setterNameCondition,
      ...(searchParams.onlyFollowedAuthors ? [followedAuthorCondition(userId)] : []),
      ...holdConditions,
      ...holdStateConditions,
      ...tallClimbsConditions,
      ...wideClimbsConditions,
      ...betaVideosConditions,
      ...zoneConditions,
      ...setIdsConditions,
      ...personalProgressConditions,
      ...projectsOnlyConditions,
    ],
    /**
     * Non-null only when the personal-grade rule is actually in force (the
     * climber asked for it, is signed in, and this is not a drafts query).
     */
    getPersonalGradeScope: (): PersonalGradeScope | null => personalGradeScope,
    /**
     * The `my_grade` subquery and its ON condition, or null when the rule is
     * off. Every query that spreads `getClimbStatsConditions()` MUST left-join
     * this when it is non-null: the grade filter, the difficulty sort and the
     * `myDifficulty` projection all reference the alias it introduces, so they
     * cannot disagree about whose grade a row was selected, ordered and
     * labelled by.
     */
    getPersonalGradeJoin: (): PersonalGradeJoinTarget | null => personalGradeJoin,
    getSizeConditions: () => sizeConditions,
    // Combined WHERE-clause conditions (both buckets) for callers that just need
    // every stats-shaped predicate applied. Callers that also need to decide
    // whether a stats row is REQUIRED (the INNER JOIN stats-driven-only routing
    // in search-climbs.ts) must use `hasRequiredStatsFilters` instead of
    // `.length` on this, since a grade-range-only filter no longer requires one.
    getClimbStatsConditions: () => [...climbStatsConditions, ...gradeRangeConditions],
    /**
     * Stats-shaped predicates for a query whose FROM is `board_climb_stats`
     * (browsed angle) with NO `board_climb_grades` join before its LIMIT: the
     * required-stats bucket plus the split grade range. `null` when the grade
     * filter cannot be written without the joined grades row — the caller then
     * keeps that join in the query and spreads `getClimbStatsConditions()`.
     */
    getStatsRowClimbStatsConditions: (): SQL[] | null =>
      statsRowGradeRangeConditions === null ? null : [...climbStatsConditions, ...statsRowGradeRangeConditions],
    // True only for filters that can't be satisfied without a real board_climb_stats
    // row (minAscents, minRating, onlyBenchmarks, gradeAccuracy) — excludes the
    // grade range, which now falls back to the Boardsesh grade for a stats-less
    // climb (see the gradeRangeConditions comment above).
    hasRequiredStatsFilters: () => climbStatsConditions.length > 0,
    getClimbStatsJoinConditions: () => [
      eq(boardClimbStats.climbUuid, boardClimbs.uuid),
      eq(boardClimbStats.boardType, params.board_name),
      eq(boardClimbStats.angle, params.angle),
    ],
    /** The second stats join used only under cross-angle — see ./effective-stats. */
    getSetAngleStatsJoinConditions: () => setAngleStatsJoinConditions(params.board_name),
    /** Whether the conditions above were built to read the effective row. Callers
     *  route off this rather than re-deriving it, so the search and the count can
     *  never describe different universes. */
    isCrossAngleStats: crossAngle,
    // ON conditions for a LEFT JOIN to board_climb_grades — needed by any caller
    // whose WHERE clause (via getClimbStatsConditions) can now reference the
    // Boardsesh grade fallback in gradeRangeConditions. Reads through the same
    // `gradeJoinAngleSql` the search path uses (see runStandardSearch in
    // search-climbs.ts), so under cross-angle a caller here (count-climbs.ts;
    // the holds heatmap never opts into cross-angle) resolves the grade at the
    // SAME angle the search list did — without this, a climb whose Boardsesh
    // grade only exists at its set angle (not the browsed one) could be found
    // by one query and missed by the other.
    getClimbGradesJoinConditions: () => [
      eq(boardClimbGrades.boardType, params.board_name),
      eq(boardClimbGrades.climbUuid, boardClimbs.uuid),
      sql`${boardClimbGrades.angle} = ${gradeJoinAngleSql(params.angle, crossAngle)}`,
    ],
    getHoldHeatmapClimbStatsConditions: () => [
      eq(boardClimbStats.climbUuid, boardClimbHolds.climbUuid),
      eq(boardClimbStats.boardType, params.board_name),
      eq(boardClimbStats.angle, params.angle),
    ],
    getClimbHoldsJoinConditions: () => [
      eq(boardClimbHolds.climbUuid, boardClimbs.uuid),
      eq(boardClimbHolds.boardType, params.board_name),
    ],
    getUserLogbookSelects,
    // Raw parts
    baseConditions,
    browsedAngleConditions,
    climbStatsConditions,
    gradeRangeConditions,
    nameCondition,
    setterNameCondition,
    holdConditions,
    holdStateConditions,
    tallClimbsConditions,
    wideClimbsConditions,
    betaVideosConditions,
    zoneConditions,
    setIdsConditions,
    sizeConditions,
    personalProgressConditions,
    projectsOnlyConditions,
    anyHolds,
    notHolds,
    holdStateFilters,
  };
};
