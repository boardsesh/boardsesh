import { desc, sql, and, eq } from 'drizzle-orm';
import type { DbInstance } from '../../client/postgres';
import { boardClimbs, boardClimbStats } from '../../schema/index';
import { createClimbFilters } from './create-climb-filters';
import { getGradeLabel } from './grade-lookup';
import type { BoardRouteParams, ClimbSearchParams, ClimbRow, ClimbSearchResult } from './types';

type RawSelectResult = {
  uuid: string;
  setter_username: string | null;
  name: string | null;
  frames: string | null;
  is_draft: boolean | null;
  angle: number | null;
  ascensionist_count: string | null;
  difficulty_id: number | null;
  quality_average: number | null;
  difficulty_error: number | null;
  benchmark_difficulty: number | null;
  description: string | null;
  created_at: string | null;
  published_at: string | null;
};

function mapResultToClimbRow(result: RawSelectResult, angle: number): ClimbRow {
  return {
    uuid: result.uuid,
    setter_username: result.setter_username || '',
    name: result.name || '',
    frames: result.frames || '',
    angle,
    ascensionist_count: Number(result.ascensionist_count || 0),
    difficulty: getGradeLabel(result.difficulty_id),
    quality_average: result.quality_average?.toString() || '0',
    stars: Math.round((Number(result.quality_average) || 0) * 5),
    difficulty_error: result.difficulty_error?.toString() || '0',
    benchmark_difficulty:
      result.benchmark_difficulty && result.benchmark_difficulty > 0 ? result.benchmark_difficulty.toString() : null,
    is_draft: result.is_draft ?? false,
    description: result.description || '',
    created_at: result.created_at,
    published_at: result.published_at,
  };
}

/**
 * Search for climbs with various filters.
 * Shared between the GraphQL backend resolver and Next.js SSR.
 *
 * @param db Drizzle database instance
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
  const page = searchParams.page ?? 0;
  const pageSize = searchParams.pageSize ?? 20;

  const filters = createClimbFilters(params, searchParams, userId);

  // Drafts never have stats, so force creation sort (stats-based sorts would be meaningless)
  const sortBy = searchParams.onlyDrafts ? 'creation' : searchParams.sortBy || 'ascents';
  const sortOrder = searchParams.sortOrder === 'asc' ? 'asc' : 'desc';
  const isDraftsQuery = !!searchParams.onlyDrafts;

  // For ascents DESC (the default landing page sort), drive FROM board_climb_stats
  // so PostgreSQL reads board_climb_stats_ascents_covering_idx in sorted order and
  // stops after pageSize+1 qualifying rows. The LEFT JOIN alternative materializes
  // the full join result and sorts it, which under concurrent load exhausts
  // /dev/shm via parallel hash join + sort workers (each allocates a 16MB shared
  // memory segment) and produces "could not resize shared memory segment" errors.
  //
  // Climbs without a board_climb_stats row would only appear after every climb
  // with any ascent (NULLS LAST), i.e. far past the first paginated page. Trading
  // that long-tail visibility for an index-only plan is the right call for the
  // hot path. Other sort orders, drafts, and projectsOnly still use the LEFT JOIN.
  const useStatsDriven = sortBy === 'ascents' && sortOrder === 'desc' && !isDraftsQuery && !searchParams.projectsOnly;

  if (useStatsDriven) {
    return statsDrivenSearch(db, params, filters, page, pageSize);
  }

  return standardSearch(db, params, searchParams, filters, sortBy, sortOrder, isDraftsQuery, page, pageSize);
};

/**
 * Stats-driven search: FROM board_climb_stats INNER JOIN board_climbs.
 * PostgreSQL reads board_climb_stats_ascents_covering_idx in ascensionist_count
 * DESC order and stops after pageSize+1 qualifying rows.
 *
 * Trade-off vs LEFT JOIN: climbs that have no board_climb_stats row for the
 * given (board_type, angle) are dropped. They would only appear after every
 * climb that has any ascent (NULLS LAST) and so are unreachable through normal
 * pagination anyway. The benefit is no Sort/Gather node, no /dev/shm pressure
 * under concurrent load.
 *
 * All climb filters (including personal progress like hideCompleted) are in
 * the WHERE clause — not the JOIN ON — so they apply correctly to the result set.
 */
async function statsDrivenSearch(
  db: DbInstance,
  params: BoardRouteParams,
  filters: ReturnType<typeof createClimbFilters>,
  page: number,
  pageSize: number,
): Promise<ClimbSearchResult> {
  const selectFields = {
    uuid: boardClimbs.uuid,
    setter_username: boardClimbs.setterUsername,
    name: boardClimbs.name,
    frames: boardClimbs.frames,
    is_draft: boardClimbs.isDraft,
    angle: boardClimbStats.angle,
    ascensionist_count: boardClimbStats.ascensionistCount,
    difficulty_id: sql<number | null>`ROUND(${boardClimbStats.displayDifficulty}::numeric, 0)`,
    quality_average: sql<number | null>`ROUND(${boardClimbStats.qualityAverage}::numeric, 2)`,
    difficulty_error: sql<
      number | null
    >`ROUND(${boardClimbStats.difficultyAverage}::numeric - ${boardClimbStats.displayDifficulty}::numeric, 2)`,
    benchmark_difficulty: boardClimbStats.benchmarkDifficulty,
    description: boardClimbs.description,
    created_at: boardClimbs.createdAt,
    published_at: boardClimbs.publishedAt,
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
    .orderBy(sql`${boardClimbStats.ascensionistCount} DESC NULLS LAST`, desc(boardClimbs.uuid))
    .limit(pageSize + 1)
    .offset(page * pageSize)) as unknown as RawSelectResult[];

  const hasMore = results.length > pageSize;
  const trimmed = hasMore ? results.slice(0, pageSize) : results;
  const climbs = trimmed.map((r) => mapResultToClimbRow(r, params.angle));
  return { climbs, hasMore };
}

/**
 * Standard search: FROM board_climbs LEFT JOIN board_climb_stats.
 * Used for non-default sorts (difficulty, name, quality, creation, popular)
 * and for draft queries.
 */
async function standardSearch(
  db: DbInstance,
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
            AND ${boardClimbs.framesCount} = 1
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
    name: boardClimbs.name,
    frames: boardClimbs.frames,
    is_draft: boardClimbs.isDraft,
    angle: boardClimbStats.angle,
    ascensionist_count: boardClimbStats.ascensionistCount,
    difficulty_id: sql<number | null>`ROUND(${boardClimbStats.displayDifficulty}::numeric, 0)`,
    quality_average: sql<number | null>`ROUND(${boardClimbStats.qualityAverage}::numeric, 2)`,
    difficulty_error: sql<
      number | null
    >`ROUND(${boardClimbStats.difficultyAverage}::numeric - ${boardClimbStats.displayDifficulty}::numeric, 2)`,
    benchmark_difficulty: boardClimbStats.benchmarkDifficulty,
    description: boardClimbs.description,
    created_at: boardClimbs.createdAt,
    published_at: boardClimbs.publishedAt,
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

  const climbs = trimmed.map((r) => mapResultToClimbRow(r, params.angle));
  return { climbs, hasMore };
}
