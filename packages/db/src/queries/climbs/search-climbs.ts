import { desc, sql, and, eq } from 'drizzle-orm';
import type { DbInstance } from '../../client/postgres';
import { boardClimbs, boardClimbStats } from '../../schema/index';
import { createClimbFilters } from './create-climb-filters';
import { getClimbStars } from './climb-stars';
import { getGradeLabel } from './grade-lookup';
import type { BoardRouteParams, ClimbSearchParams, ClimbRow, ClimbSearchResult } from './types';

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
  is_draft: boolean | null;
  angle: number | null;
  ascensionist_count: string | null;
  difficulty_id: number | string | null;
  quality_average: number | string | null;
  difficulty_error: number | string | null;
  benchmark_difficulty: number | null;
  description: string | null;
  created_at: string | null;
  published_at: string | null;
  frames_count: number | null;
  frames_pace: number | null;
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
    angle: params.angle,
    ascensionist_count: Number(result.ascensionist_count || 0),
    difficulty: getGradeLabel(toIntegerOrNull(result.difficulty_id)),
    quality_average: result.quality_average?.toString() || '0',
    stars: getClimbStars(params.board_name, result.quality_average),
    difficulty_error: result.difficulty_error?.toString() || '0',
    benchmark_difficulty:
      result.benchmark_difficulty && result.benchmark_difficulty > 0 ? result.benchmark_difficulty.toString() : null,
    is_draft: result.is_draft ?? false,
    description: result.description || '',
    created_at: result.created_at,
    published_at: result.published_at,
    framesCount: result.frames_count ?? null,
    framesPace: result.frames_pace ?? null,
  };
}

type TransactionDb = Parameters<Parameters<DbInstance['transaction']>[0]>[0];
type SearchDb = DbInstance | TransactionDb;
type SearchDbTransaction = DbInstance['transaction'];
type SearchDbExecute = (query: unknown) => Promise<unknown>;
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

function getTransaction(db: SearchDb): SearchDbTransaction | null {
  const candidate = db as SearchDb & { transaction?: unknown };
  return typeof candidate.transaction === 'function' ? (candidate.transaction.bind(db) as SearchDbTransaction) : null;
}

function getExecute(db: SearchDb): SearchDbExecute | null {
  const candidate = db as SearchDb & { execute?: unknown };
  return typeof candidate.execute === 'function' ? (candidate.execute.bind(db) as SearchDbExecute) : null;
}

/**
 * Search for climbs with various filters.
 * Shared between the GraphQL backend resolver and Next.js SSR.
 *
 * @param db Top-level Drizzle database instance. Transaction-scoped callers
 * would need an explicit signature change and must preserve standardSearch's
 * transaction-scoped SET LOCAL guard.
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
  const sortBy = isDraftsQuery ? 'creation' : searchParams.sortBy || 'ascents';
  const sortOrder = searchParams.sortOrder === 'asc' ? 'asc' : 'desc';
  const statsDrivenSort = getStatsDrivenSort(sortBy, sortOrder);

  const hasStatsFilters = filters.getClimbStatsConditions().length > 0;
  if (!statsDrivenSort) {
    return standardSearch(db, params, searchParams, filters, sortBy, sortOrder, isDraftsQuery, page, pageSize);
  }

  const path = chooseSearchPath({
    statsDrivenSort,
    isDraftsQuery,
    projectsOnly: !!searchParams.projectsOnly,
    // Routes-only (frames_count > 1, boulders off) — see chooseSearchPath.
    routesOnly: !!searchParams.routes && !searchParams.boulders,
    page,
    hasStatsFilters,
  });

  if (path === 'standard-only') {
    return standardSearch(db, params, searchParams, filters, sortBy, sortOrder, isDraftsQuery, page, pageSize);
  }

  // Both 'stats-driven-only' and 'stats-driven-with-fallback' start with statsDriven.
  const statsResult = await statsDrivenSearch(db, params, filters, statsDrivenSort, page, pageSize);
  if (statsResult.hasMore) {
    return statsResult;
  }

  // statsDriven returned a partial page. Fall back to standardSearch only on page 0
  // without stats filters, where stats-less climbs (projects) need to fill out
  // narrow-filter results. The fallback's dataset is small enough that the planner
  // picks a serial plan and doesn't allocate parallel-sort DSM segments.
  //
  // KNOWN TRADE-OFF: sparse first-page ascents/quality sorts can pay for two
  // queries: the stats-driven index probe and then the LEFT JOIN fallback. That
  // is intentional so stats-less climbs still appear at the bottom of the first
  // page instead of disappearing from narrow result sets.
  //
  // KNOWN TRADE-OFF (search-climbs.ts:80-91 review feedback): when the page-0
  // fallback returns hasMore=true but the user navigates to page 1, statsDriven on
  // page 1 returns 0 and we don't fall back (page > 0). The user sees an empty
  // next page. Accepted because:
  //   - The narrow-filter case where this is visible is a small fraction of traffic.
  //   - Running standardSearch on page > 0 with deep OFFSET re-creates the parallel
  //     plan and /dev/shm pressure that PR #1969 fixes for the hot path.
  //   - A properly correct fix needs server-side state across pages (count of
  //     stats-having for the filter) which itself takes a parallel plan on broad
  //     filters — verified ~862ms via EXPLAIN ANALYZE.
  // Future work: track in production via cache-miss telemetry; consider keyset
  // pagination or a popular_climbs materialized view as the next scale move.
  if (path === 'stats-driven-with-fallback') {
    return standardSearch(db, params, searchParams, filters, sortBy, sortOrder, isDraftsQuery, page, pageSize);
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
 *   - page === 0 && !hasStatsFilters → stats-driven-with-fallback
 *   - otherwise             → stats-driven-only
 */
export function chooseSearchPath(input: {
  statsDrivenSort: StatsDrivenSort | null;
  isDraftsQuery: boolean;
  projectsOnly: boolean;
  routesOnly: boolean;
  page: number;
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
  if (input.page === 0 && !input.hasStatsFilters) return 'stats-driven-with-fallback';
  return 'stats-driven-only';
}

/**
 * Stats-driven search: FROM board_climb_stats INNER JOIN board_climbs.
 * PostgreSQL reads the relevant stats covering index in sort order and stops
 * after pageSize+1 qualifying rows.
 *
 * The INNER JOIN excludes climbs without a stats row at this angle. The caller
 * (`searchClimbs`) compensates only on page 0 without stats filters, where
 * stats-less climbs (projects) need to fill out narrow-filter results. See the
 * comment in `searchClimbs` for the full reasoning.
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
    created_at: boardClimbs.createdAt,
    published_at: boardClimbs.publishedAt,
    frames_count: boardClimbs.framesCount,
    frames_pace: boardClimbs.framesPace,
  };

  const results: RawSelectResult[] = (await db
    .select(selectFields)
    .from(boardClimbStats)
    .innerJoin(boardClimbs, eq(boardClimbs.uuid, boardClimbStats.climbUuid))
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
    .orderBy(orderByClause, desc(boardClimbs.uuid))
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
): Promise<ClimbSearchResult> {
  const transaction = getTransaction(db);
  if (transaction) {
    return transaction(async (transactionDb) => {
      await transactionDb.execute(sql`SET LOCAL max_parallel_workers_per_gather = 0`);
      return runStandardSearch(
        transactionDb,
        params,
        searchParams,
        filters,
        sortBy,
        sortOrder,
        isDraftsQuery,
        page,
        pageSize,
      );
    });
  }

  // Reached only by execute-only query test doubles. Production call sites pass
  // top-level DbInstance values so the transaction branch scopes SET LOCAL
  // correctly; do not broaden searchClimbs to TransactionDb without revisiting
  // that planner guard.
  const execute = getExecute(db);
  if (execute) {
    await execute(sql`SET LOCAL max_parallel_workers_per_gather = 0`);
  }

  return runStandardSearch(db, params, searchParams, filters, sortBy, sortOrder, isDraftsQuery, page, pageSize);
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
    created_at: boardClimbs.createdAt,
    published_at: boardClimbs.publishedAt,
    frames_count: boardClimbs.framesCount,
    frames_pace: boardClimbs.framesPace,
  };

  const orderByClause = sortOrder === 'asc' ? sql`${sortColumn} ASC NULLS FIRST` : sql`${sortColumn} DESC NULLS LAST`;

  // LEFT JOIN preserves climbs without stats (they get NULL stats columns).
  const coreQuery = db
    .select(selectFields)
    .from(boardClimbs)
    .leftJoin(boardClimbStats, and(...filters.getClimbStatsJoinConditions()));

  const queryWithJoins = popularCountsSubquery
    ? coreQuery.leftJoin(popularCountsSubquery, eq(popularCountsSubquery.climbUuid, boardClimbs.uuid))
    : coreQuery;

  const results: RawSelectResult[] = (await queryWithJoins
    .where(and(...whereConditions))
    .orderBy(orderByClause, desc(boardClimbs.uuid))
    .limit(pageSize + 1)
    .offset(page * pageSize)) as unknown as RawSelectResult[];

  const hasMore = results.length > pageSize;
  const trimmed = hasMore ? results.slice(0, pageSize) : results;

  const climbs = trimmed.map((row) => mapResultToClimbRow(row, params));
  return { climbs, hasMore };
}
