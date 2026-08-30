import { desc, sql, and, eq } from 'drizzle-orm';
import type { DbInstance } from '../../client/postgres';
import { boardClimbs, boardClimbStats, boardClimbGrades } from '../../schema/index';
import { withSerialPlan } from '../util/serial-plan';
import { createClimbFilters } from './create-climb-filters';
import { getClimbStars } from './climb-stars';
import { getGradeLabel } from './grade-lookup';
import { toConfidenceTier } from '../grade-model/constants';
import {
  normalizeSearchSortBy,
  type BoardRouteParams,
  type ClimbSearchParams,
  type ClimbRow,
  type ClimbSearchResult,
} from './types';

// Runtime shape of a search row. postgres.js returns numeric/bigint columns as
// JS strings (no `types` parser is configured), so the ROUND(...::numeric) and
// bigint expressions arrive as strings even though SQL treats them as numbers.
// These annotations are deliberately `number | string` so downstream code can't
// assume a JS number and silently string-concatenate. doublePrecision columns
// (benchmark_difficulty) do come back as real JS numbers.
type RawSelectResult = {
  uuid: string;
  setter_username: string | null;
  userId: string | null;
  name: string | null;
  frames: string | null;
  controller_route_uuid: string | null;
  is_draft: boolean | null;
  angle: number | null;
  ascensionist_count: string | null;
  difficulty_id: number | string | null;
  quality_average: number | string | null;
  difficulty_error: number | string | null;
  benchmark_difficulty: number | null;
  description: string | null;
  characteristics: string[] | null;
  created_at: string | null;
  published_at: string | null;
  frames_count: number | null;
  frames_pace: number | null;
  // integer[] comes back as a real JS number array; NULL for a climb whose
  // denormalised columns haven't been populated (drafts, legacy rows).
  compatible_size_ids: number[] | null;
  // doublePrecision COALESCE comes back as a real JS number (like benchmark_difficulty);
  // confidence is text. Both null when the climb has no board_climb_grades row at this angle.
  boardsesh_difficulty: number | null;
  boardsesh_confidence: string | null;
};

// difficulty_id arrives as a string like "15" from the driver; coerce to an integer
// for the GRADE_MAP lookup instead of relying on JS object-key coercion.
function toIntegerOrNull(value: number | string | null): number | null {
  if (value === null || value === undefined) return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric) : null;
}

function mapResultToClimbRow(result: RawSelectResult, params: BoardRouteParams): ClimbRow {
  return {
    uuid: result.uuid,
    setter_username: result.setter_username || '',
    userId: result.userId ?? null,
    name: result.name || '',
    frames: result.frames || '',
    controllerRouteUuid: result.controller_route_uuid ?? null,
    // The search is scoped to one board + layout (the WHERE filter), so every
    // row belongs to it — stamp from the route params like `angle`. Lets the
    // queue's BLE spill guard tell a climb set for another board apart.
    boardType: params.board_name,
    layoutId: params.layout_id,
    angle: params.angle,
    ascensionist_count: Number(result.ascensionist_count || 0),
    difficulty: getGradeLabel(toIntegerOrNull(result.difficulty_id)),
    quality_average: result.quality_average?.toString() || '0',
    stars: getClimbStars(result.quality_average),
    difficulty_error: result.difficulty_error?.toString() || '0',
    benchmark_difficulty:
      result.benchmark_difficulty && result.benchmark_difficulty > 0 ? result.benchmark_difficulty.toString() : null,
    is_draft: result.is_draft ?? false,
    description: result.description || '',
    characteristics: result.characteristics ?? null,
    created_at: result.created_at,
    published_at: result.published_at,
    framesCount: result.frames_count ?? null,
    framesPace: result.frames_pace ?? null,
    compatibleSizeIds: result.compatible_size_ids ?? null,
    // COALESCE(universal_grade, local_grade) is doublePrecision → real JS number, but
    // coerce defensively so a stringly-typed driver value can't string-concatenate.
    boardseshDifficulty: result.boardsesh_difficulty == null ? null : Number(result.boardsesh_difficulty),
    boardseshConfidence: toConfidenceTier(result.boardsesh_confidence),
  };
}

type TransactionDb = Parameters<Parameters<DbInstance['transaction']>[0]>[0];
type SearchDb = DbInstance | TransactionDb;
export type StatsDrivenSort = 'ascents' | 'quality';

/**
 * Upper bound on the page index. 500 pages × the 100-row pageSize cap is a 50k-row
 * worst-case OFFSET on the index-ordered path — bounded and cheap; legitimate UI
 * paging never approaches it. The API layer rejects pages past this; the shared
 * query clamps as a backstop for SSR/direct callers that bypass that validation,
 * so a crafted `page=10_000_000` can't force an OFFSET-200M serial scan per request.
 */
export const MAX_SEARCH_PAGE = 500;

export function clampSearchPage(page: number | undefined): number {
  if (!Number.isFinite(page)) return 0;
  return Math.min(Math.max(Math.trunc(page as number), 0), MAX_SEARCH_PAGE);
}

export function getStatsDrivenSort(sortBy: string, sortOrder: 'asc' | 'desc'): StatsDrivenSort | null {
  if (sortOrder !== 'desc') return null;
  if (sortBy === 'ascents' || sortBy === 'quality') return sortBy;
  return null;
}

/**
 * Search for climbs with various filters.
 * Shared between the GraphQL backend resolver and Next.js SSR.
 *
 * @param db Top-level Drizzle database instance. Transaction-scoped callers
 * would need an explicit signature change and must preserve standardSearch's
 * and statsDrivenSearch's transaction-scoped SET LOCAL guards.
 * @param params Board route parameters
 * @param searchParams Search/filter parameters
 * @param userId Optional user ID for personal progress filters
 */
export const searchClimbs = async (
  db: DbInstance,
  params: BoardRouteParams,
  searchParams: ClimbSearchParams,
  userId?: string,
): Promise<ClimbSearchResult> => {
  const page = clampSearchPage(searchParams.page);
  const pageSize = searchParams.pageSize ?? 20;

  const filters = createClimbFilters(params, searchParams, userId);
  // Derive from the filter builder's unified predicate (onlyDrafts AND a userId),
  // not `!!searchParams.onlyDrafts` — otherwise onlyDrafts-without-userId makes this
  // skip the size/stats filters and force creation sort while the filters still
  // require listed non-drafts. See filters.isOnlyDrafts.
  const isDraftsQuery = filters.isOnlyDrafts;

  // Drafts never have stats, so force creation sort (stats-based sorts would be meaningless)
  const sortBy = isDraftsQuery ? 'creation' : normalizeSearchSortBy(searchParams.sortBy);
  const sortOrder = searchParams.sortOrder === 'asc' ? 'asc' : 'desc';
  const statsDrivenSort = getStatsDrivenSort(sortBy, sortOrder);

  const hasStatsFilters = filters.getClimbStatsConditions().length > 0;
  if (!statsDrivenSort) {
    return standardSearch(db, params, searchParams, filters, sortBy, sortOrder, isDraftsQuery, page, pageSize, false);
  }

  const path = chooseSearchPath({
    statsDrivenSort,
    isDraftsQuery,
    projectsOnly: !!searchParams.projectsOnly,
    // Routes-only (frames_count > 1, boulders off) — see chooseSearchPath.
    routesOnly: !!searchParams.routes && !searchParams.boulders,
    hasStatsFilters,
  });

  if (path === 'standard-only') {
    return standardSearch(db, params, searchParams, filters, sortBy, sortOrder, isDraftsQuery, page, pageSize, false);
  }

  // Both 'stats-driven-only' and 'stats-driven-with-fallback' start with statsDriven.
  const statsResult = await statsDrivenSearch(db, params, filters, statsDrivenSort, page, pageSize);
  if (statsResult.hasMore) {
    return statsResult;
  }

  // statsDriven returned a partial page: it has exhausted the climbs that HAVE a
  // stats row at this angle. Re-run the same window through standardSearch's LEFT
  // JOIN so stats-less climbs (projects) still show up — on ANY page, not just
  // page 0 (issue #1971). The count badge comes from countClimbs, which counts the
  // unified LEFT JOIN universe, so truncating here is what made the count disagree
  // with the visible list and fired "no more climbs" early.
  //
  // Why running standardSearch past page 0 is safe now: the #1969 failure mode was
  // a parallel plan whose per-worker DSM allocations exhausted /dev/shm. Both paths
  // have since been wrapped in `SET LOCAL max_parallel_workers_per_gather = 0`
  // (standardSearch in 07dfe54b2, statsDrivenSearch in a31f88baf / #3856), so
  // neither can allocate a parallel-sort DSM segment regardless of page depth. The
  // page-0 gate predates both guards (9acb8b913) and was protecting against a plan
  // shape that is now disabled by GUC — do not re-introduce it.
  //
  // Cost: the fallback only fires once statsDriven is exhausted. Broad filters never
  // reach it at shallow depth (hasMore stays true), but a deep enough page — one whose
  // OFFSET lands past the stats-having count — reaches it on any filter, bounded by
  // that filter's selectivity. The extra work is the countClimbs scan shape plus a
  // top-N heapsort bounded by OFFSET + LIMIT, so per-page cost past the boundary is
  // roughly constant and equal to today's page-0 fallback cost on the same filter.
  // `page` is clamped to MAX_SEARCH_PAGE; `pageSize` is caller-supplied and is NOT
  // clamped here (searchClimbs defaults it to 20), so the OFFSET bound is only as
  // tight as whatever validates pageSize upstream.
  //
  // `orderStatsHavingFirst: true` makes the fallback's ordering a prefix-compatible
  // continuation of the stats-driven pages — see runStandardSearch.
  // Future work: keyset pagination or a popular_climbs materialized view so the
  // stats-driven path can rank stats-less climbs natively.
  if (path === 'stats-driven-with-fallback') {
    return standardSearch(db, params, searchParams, filters, sortBy, sortOrder, isDraftsQuery, page, pageSize, true);
  }
  return statsResult;
};

/**
 * Three search paths, distinguished by post-statsDriven behavior:
 *   - 'standard-only'              — skip statsDriven entirely (LEFT JOIN path)
 *   - 'stats-driven-only'          — run statsDriven; whatever it returns is final
 *   - 'stats-driven-with-fallback' — run statsDriven; if partial page, retry via
 *                                    standardSearch to surface stats-less climbs
 */
export type SearchPath = 'standard-only' | 'stats-driven-only' | 'stats-driven-with-fallback';

/**
 * Pure routing decision for `searchClimbs`. Exported for unit testing — exercising
 * each branch via SQL integration tests would require seeded data and is brittle
 * compared to direct assertions on the routing logic.
 *
 * Decision tree:
 *   - non-indexed sort      → standard-only
 *   - drafts query          → standard-only (drafts have no stats rows)
 *   - projectsOnly          → standard-only (the user explicitly wants stats-less climbs)
 *   - routesOnly            → standard-only (routes are few + often unclimbed; the stats path drops them)
 *   - hasStatsFilters       → stats-driven-only (a stats predicate can't be satisfied through the
 *                             LEFT JOIN either, so a fallback would return nothing new)
 *   - otherwise             → stats-driven-with-fallback (any page — see issue #1971)
 */
export function chooseSearchPath(input: {
  statsDrivenSort: StatsDrivenSort | null;
  isDraftsQuery: boolean;
  projectsOnly: boolean;
  routesOnly: boolean;
  hasStatsFilters: boolean;
}): SearchPath {
  if (!input.statsDrivenSort) return 'standard-only';
  if (input.isDraftsQuery) return 'standard-only';
  if (input.projectsOnly) return 'standard-only';
  // Routes (frames_count > 1) are a small, frequently-unclimbed set. The
  // stats-driven path INNER JOINs board_climb_stats at the angle, which drops
  // routes with no stats row — the count query still counts them, so the list
  // comes back empty while the count says e.g. 66. Force the LEFT JOIN path so
  // unclimbed routes surface; the tiny routes dataset makes the index plan moot.
  if (input.routesOnly) return 'standard-only';
  // Stats filters (minAscents, grade range, quality, accuracy) exclude stats-less
  // climbs from the LEFT JOIN path too, so a fallback would return nothing new and
  // just double the query count. countClimbs applies the same conditions, so the
  // count and the list already agree on this branch.
  if (input.hasStatsFilters) return 'stats-driven-only';
  return 'stats-driven-with-fallback';
}

/**
 * Stats-driven search: FROM board_climb_stats INNER JOIN board_climbs.
 * PostgreSQL usually reads the relevant stats covering index in sort order and
 * stops after pageSize+1 qualifying rows — but with a narrow grade band + size
 * predicates + a larger pageSize + a page>0 OFFSET, the planner can still pick a
 * parallel plan, and each worker's DSM allocation can exhaust a small /dev/shm
 * (#3856). `withSerialPlan` disables per-gather parallelism inside a transaction,
 * the same guard standardSearch / countClimbs / getSetterStats use.
 *
 * The INNER JOIN excludes climbs without a stats row at this angle. The caller
 * (`searchClimbs`) compensates on any page without stats filters, whenever this
 * query returns a partial page — stats-less climbs (projects) need to fill out
 * narrow-filter results at every depth, not just the first page (issue #1971).
 * See the comment in `searchClimbs` for the full reasoning.
 *
 * All climb filters (including personal progress like hideCompleted) are in
 * the WHERE clause — not the JOIN ON — so they apply correctly to the result set.
 */
async function statsDrivenSearch(
  db: SearchDb,
  params: BoardRouteParams,
  filters: ReturnType<typeof createClimbFilters>,
  sortBy: StatsDrivenSort,
  page: number,
  pageSize: number,
): Promise<ClimbSearchResult> {
  return withSerialPlan(db, (tx) => runStatsDrivenSearch(tx, params, filters, sortBy, page, pageSize));
}

async function runStatsDrivenSearch(
  db: SearchDb,
  params: BoardRouteParams,
  filters: ReturnType<typeof createClimbFilters>,
  sortBy: StatsDrivenSort,
  page: number,
  pageSize: number,
): Promise<ClimbSearchResult> {
  const orderByClause =
    sortBy === 'quality'
      ? sql`${boardClimbStats.qualityAverage} DESC NULLS LAST`
      : sql`${boardClimbStats.ascensionistCount} DESC NULLS LAST`;

  const selectFields = {
    uuid: boardClimbs.uuid,
    setter_username: boardClimbs.setterUsername,
    userId: boardClimbs.userId,
    name: boardClimbs.name,
    frames: boardClimbs.frames,
    controller_route_uuid: boardClimbs.controllerRouteUuid,
    is_draft: boardClimbs.isDraft,
    angle: boardClimbStats.angle,
    ascensionist_count: boardClimbStats.ascensionistCount,
    // ROUND(::numeric) returns text over the wire (see RawSelectResult).
    difficulty_id: sql<number | string | null>`ROUND(${boardClimbStats.displayDifficulty}::numeric, 0)`,
    quality_average: sql<number | string | null>`ROUND(${boardClimbStats.qualityAverage}::numeric, 2)`,
    difficulty_error: sql<
      number | string | null
    >`ROUND(${boardClimbStats.difficultyAverage}::numeric - ${boardClimbStats.displayDifficulty}::numeric, 2)`,
    benchmark_difficulty: boardClimbStats.benchmarkDifficulty,
    description: boardClimbs.description,
    characteristics: boardClimbs.characteristics,
    created_at: boardClimbs.createdAt,
    published_at: boardClimbs.publishedAt,
    frames_count: boardClimbs.framesCount,
    frames_pace: boardClimbs.framesPace,
    // The sizes this climb fits on. Carried on every search row because the queue
    // and the playlist rows judge size compatibility client-side, and on Woods
    // that is the only signal that separates the 8x10 from the 12x12.
    compatible_size_ids: boardClimbs.compatibleSizeIds,
    // Boardsesh grade at the searched angle (params.angle). Surfaced flattened so
    // list rows carry it without a per-climb boardseshGrade round-trip.
    boardsesh_difficulty: sql<
      number | null
    >`COALESCE(${boardClimbGrades.universalGrade}, ${boardClimbGrades.localGrade})`,
    boardsesh_confidence: boardClimbGrades.confidence,
  };

  const results: RawSelectResult[] = (await db
    .select(selectFields)
    .from(boardClimbStats)
    .innerJoin(boardClimbs, eq(boardClimbs.uuid, boardClimbStats.climbUuid))
    // Boardsesh grade for the searched climb at the searched angle. LEFT JOIN so a
    // climb without a grade row still returns (fields come back NULL — safe).
    .leftJoin(
      boardClimbGrades,
      and(
        eq(boardClimbGrades.boardType, params.board_name),
        eq(boardClimbGrades.climbUuid, boardClimbs.uuid),
        eq(boardClimbGrades.angle, params.angle),
      ),
    )
    .where(
      and(
        // Stats-table scope
        eq(boardClimbStats.boardType, params.board_name),
        eq(boardClimbStats.angle, params.angle),
        // All climb conditions (base filters, name, setter, holds, personal progress)
        ...filters.getClimbWhereConditions(),
        // Size edge bounds
        ...filters.getSizeConditions(),
        // Stats conditions (minAscents, grade range, quality, accuracy)
        ...filters.getClimbStatsConditions(),
      ),
    )
    // Tiebreak on the stats-side climb_uuid (identical value to board_climbs.uuid under
    // the INNER JOIN equality) so the ORDER BY textually matches the v2 covering index's
    // trailing key column — the scan returns rows already in order, no sort. Do NOT
    // mirror this in runStandardSearch: there it's a LEFT JOIN and climb_uuid is NULL
    // for stats-less rows, which would corrupt the ordering.
    .orderBy(orderByClause, desc(boardClimbStats.climbUuid))
    .limit(pageSize + 1)
    .offset(page * pageSize)) as unknown as RawSelectResult[];

  const hasMore = results.length > pageSize;
  const trimmed = hasMore ? results.slice(0, pageSize) : results;
  const climbs = trimmed.map((row) => mapResultToClimbRow(row, params));
  return { climbs, hasMore };
}

/**
 * Standard search: FROM board_climbs LEFT JOIN board_climb_stats.
 * Used for non-default sorts (difficulty, name, creation, popular) and for
 * draft queries.
 *
 * @param orderStatsHavingFirst Pass `true` only from the stats-driven fallback so
 * the result window lines up with statsDrivenSearch's pages. See runStandardSearch.
 */
async function standardSearch(
  db: SearchDb,
  params: BoardRouteParams,
  searchParams: ClimbSearchParams,
  filters: ReturnType<typeof createClimbFilters>,
  sortBy: string,
  sortOrder: string,
  isDraftsQuery: boolean,
  page: number,
  pageSize: number,
  orderStatsHavingFirst: boolean,
): Promise<ClimbSearchResult> {
  return withSerialPlan(db, (tx) =>
    runStandardSearch(
      tx,
      params,
      searchParams,
      filters,
      sortBy,
      sortOrder,
      isDraftsQuery,
      page,
      pageSize,
      orderStatsHavingFirst,
    ),
  );
}

async function runStandardSearch(
  db: SearchDb,
  params: BoardRouteParams,
  searchParams: ClimbSearchParams,
  filters: ReturnType<typeof createClimbFilters>,
  sortBy: string,
  sortOrder: string,
  isDraftsQuery: boolean,
  page: number,
  pageSize: number,
  orderStatsHavingFirst: boolean,
): Promise<ClimbSearchResult> {
  // For the popular sort, pre-aggregate total ascents across all angles via a joined subquery
  // instead of a correlated subquery that runs per candidate row.
  // Scoped with an EXISTS to only aggregate stats for climbs matching the search filters.
  const popularCountsSubquery =
    sortBy === 'popular'
      ? db
          .select({
            climbUuid: boardClimbStats.climbUuid,
            totalAscensionistCount: sql<number>`COALESCE(SUM(${boardClimbStats.ascensionistCount}), 0)`.as(
              'total_ascensionist_count',
            ),
          })
          .from(boardClimbStats)
          .where(
            and(
              eq(boardClimbStats.boardType, params.board_name),
              sql`EXISTS (
            SELECT 1 FROM ${boardClimbs}
            WHERE ${boardClimbs.uuid} = ${boardClimbStats.climbUuid}
            AND ${boardClimbs.boardType} = ${params.board_name}
            AND ${boardClimbs.layoutId} = ${params.layout_id}
            AND ${boardClimbs.isListed} = true
            AND ${boardClimbs.isDraft} = false
            AND (${boardClimbs.framesCount} = 1 OR ${boardClimbs.framesCount} IS NULL)
          )`,
            ),
          )
          .groupBy(boardClimbStats.climbUuid)
          .as('popular_counts')
      : null;

  const allowedSortColumns: Record<string, ReturnType<typeof sql>> = {
    ascents: sql`${boardClimbStats.ascensionistCount}`,
    difficulty: sql`ROUND(${boardClimbStats.displayDifficulty}::numeric, 0)`,
    name: sql`${boardClimbs.name}`,
    quality: sql`${boardClimbStats.qualityAverage}`,
    creation: sql`${boardClimbs.createdAt}`,
    ...(popularCountsSubquery ? { popular: sql`${popularCountsSubquery.totalAscensionistCount}` } : {}),
  };

  const sortColumn = allowedSortColumns[sortBy] || sql`${boardClimbs.createdAt}`;

  // Random sort: hash the uuid with a per-search seed so one shuffle is stable
  // across OFFSET-paginated pages, while a new seed reshuffles. Empty seed falls
  // back to a constant salt (md5 is never NULL, so pagination is still stable).
  //
  // Perf: md5(uuid || seed) is non-SARGable — no index satisfies it, so this is a
  // full scan + sort of the filtered set (the whole board when unfiltered). That's
  // inherent to "shuffle everything"; the LIMIT keeps the returned rows small but
  // the sort still touches every matching row. It bypasses the SSR cache (see the
  // web cachedSearchClimbs guard), so each request re-sorts. Acceptable at current
  // catalog sizes; if it ever bites, gate on a filter threshold or a sampling
  // strategy (e.g. TABLESAMPLE / a precomputed random column) rather than md5.
  const randomOrderExpr =
    sortBy === 'random' ? sql`md5(${boardClimbs.uuid} || ${searchParams.sortSeed || 'boardsesh'})` : null;

  const whereConditions = [
    ...filters.getClimbWhereConditions(),
    // Draft climbs may have NULL compatible_size_ids (denormalized columns not yet populated),
    // so skip the size filter entirely — users must be able to find their freshly saved drafts.
    ...(isDraftsQuery ? [] : filters.getSizeConditions()),
    // Draft climbs never have board_climb_stats rows, so stats-based filters
    // (grade range, min ascents, quality, accuracy) would reject every draft.
    ...(isDraftsQuery ? [] : filters.getClimbStatsConditions()),
  ];

  const selectFields = {
    uuid: boardClimbs.uuid,
    setter_username: boardClimbs.setterUsername,
    userId: boardClimbs.userId,
    name: boardClimbs.name,
    frames: boardClimbs.frames,
    controller_route_uuid: boardClimbs.controllerRouteUuid,
    is_draft: boardClimbs.isDraft,
    angle: boardClimbStats.angle,
    ascensionist_count: boardClimbStats.ascensionistCount,
    // ROUND(::numeric) returns text over the wire (see RawSelectResult).
    difficulty_id: sql<number | string | null>`ROUND(${boardClimbStats.displayDifficulty}::numeric, 0)`,
    quality_average: sql<number | string | null>`ROUND(${boardClimbStats.qualityAverage}::numeric, 2)`,
    difficulty_error: sql<
      number | string | null
    >`ROUND(${boardClimbStats.difficultyAverage}::numeric - ${boardClimbStats.displayDifficulty}::numeric, 2)`,
    benchmark_difficulty: boardClimbStats.benchmarkDifficulty,
    description: boardClimbs.description,
    characteristics: boardClimbs.characteristics,
    created_at: boardClimbs.createdAt,
    published_at: boardClimbs.publishedAt,
    frames_count: boardClimbs.framesCount,
    frames_pace: boardClimbs.framesPace,
    // The sizes this climb fits on. Carried on every search row because the queue
    // and the playlist rows judge size compatibility client-side, and on Woods
    // that is the only signal that separates the 8x10 from the 12x12.
    compatible_size_ids: boardClimbs.compatibleSizeIds,
    // Boardsesh grade at the searched angle (params.angle). Surfaced flattened so
    // list rows carry it without a per-climb boardseshGrade round-trip.
    boardsesh_difficulty: sql<
      number | null
    >`COALESCE(${boardClimbGrades.universalGrade}, ${boardClimbGrades.localGrade})`,
    boardsesh_confidence: boardClimbGrades.confidence,
  };

  const orderByClause = randomOrderExpr
    ? sql`${randomOrderExpr} ASC`
    : sortOrder === 'asc'
      ? sql`${sortColumn} ASC NULLS FIRST`
      : sql`${sortColumn} DESC NULLS LAST`;

  // Stats-presence key, used ONLY by the stats-driven fallback (issue #1971). It
  // pins every climb that has a board_climb_stats row at this angle ahead of every
  // stats-less one, so the unified order becomes
  //   [stats-having, in exactly statsDrivenSearch's order] ++ [stats-less by uuid DESC]
  // and each fallback page is a prefix-compatible continuation of the stats-driven
  // pages — nothing duplicated or skipped at the boundary. Rows with a non-NULL sort
  // key are unaffected (they already sort ahead of every NULL); the key only
  // disambiguates the NULL tail, where a stats row with a NULL ascensionist_count /
  // quality_average would otherwise interleave with stats-less climbs by uuid DESC.
  // Never set it for name/creation/popular/random sorts — it would reorder them (and
  // break the md5 shuffle's page stability).
  const orderByKeys = [
    ...(orderStatsHavingFirst ? [sql`CASE WHEN ${boardClimbStats.climbUuid} IS NULL THEN 1 ELSE 0 END ASC`] : []),
    orderByClause,
    desc(boardClimbs.uuid),
  ];

  // LEFT JOIN preserves climbs without stats (they get NULL stats columns).
  const coreQuery = db
    .select(selectFields)
    .from(boardClimbs)
    .leftJoin(boardClimbStats, and(...filters.getClimbStatsJoinConditions()))
    // Boardsesh grade at the searched angle (params.angle). LEFT JOIN so stats-less
    // climbs still return; the grade fields are NULL when no grade row exists.
    .leftJoin(
      boardClimbGrades,
      and(
        eq(boardClimbGrades.boardType, params.board_name),
        eq(boardClimbGrades.climbUuid, boardClimbs.uuid),
        eq(boardClimbGrades.angle, params.angle),
      ),
    );

  const queryWithJoins = popularCountsSubquery
    ? coreQuery.leftJoin(popularCountsSubquery, eq(popularCountsSubquery.climbUuid, boardClimbs.uuid))
    : coreQuery;

  const results: RawSelectResult[] = (await queryWithJoins
    .where(and(...whereConditions))
    .orderBy(...orderByKeys)
    .limit(pageSize + 1)
    .offset(page * pageSize)) as unknown as RawSelectResult[];

  const hasMore = results.length > pageSize;
  const trimmed = hasMore ? results.slice(0, pageSize) : results;

  const climbs = trimmed.map((row) => mapResultToClimbRow(row, params));
  return { climbs, hasMore };
}
