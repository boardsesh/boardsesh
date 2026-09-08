import { sql, and } from 'drizzle-orm';
import { dbRead } from '../../client';
import { boardClimbs, boardClimbStats } from '@boardsesh/db/schema';
import {
  createClimbFilters,
  withSerialPlan,
  type BoardRouteParams,
  type ClimbSearchParams,
} from '@boardsesh/db/queries';
import { logger } from '../../../utils/logger';

/**
 * Counts the total number of climbs matching the search criteria.
 * This is a separate query from searchClimbs to avoid the expensive count(*) over()
 * window function that forces a full table scan.
 *
 * This query is only executed when the `totalCount` field is requested in the GraphQL query.
 * The ClimbSearchResult type uses field-level resolvers, so if a client only requests
 * `climbs` and `hasMore`, this count query is never executed - improving performance.
 *
 * @see resolvers.ts ClimbSearchResult.totalCount for the field resolver
 */
export const countClimbs = async (
  params: BoardRouteParams,
  searchParams: ClimbSearchParams,
  userId?: string,
): Promise<number> => {
  const filters = createClimbFilters(params, searchParams, userId);

  // Same unified drafts predicate searchClimbs uses (onlyDrafts AND a userId), so the
  // size/stats filters are skipped here only when they're skipped there.
  const isDraftsQuery = filters.isOnlyDrafts;

  // getClimbWhereConditions() carries the personal-grade range filter (#4828) as
  // well as the base/name/hold/progress predicates, so the count is computed
  // from the SAME predicate the list is. If it ever drifts out of here the
  // "Show N" badge starts disagreeing with what the list actually shows.
  //
  // That filter reads the `my_grade` alias, so the join below is mandatory
  // whenever this is non-null — searchClimbs joins the identical thing.
  const personalGradeJoin = filters.getPersonalGradeJoin();

  const whereConditions = [
    ...filters.getClimbWhereConditions(),
    // Draft climbs may have NULL compatible_size_ids (denormalized columns not yet populated),
    // so skip the size filter entirely — users must be able to find their freshly saved drafts.
    ...(isDraftsQuery ? [] : filters.getSizeConditions()),
    // Draft climbs never have stats rows — skip stats filters to avoid rejecting all drafts
    ...(isDraftsQuery ? [] : filters.getClimbStatsConditions()),
  ];

  // This broad LEFT JOIN count is the same plan shape that exhausted /dev/shm in the
  // PR #1969 incident — a filtered count goes parallel (Gather) and each worker
  // allocates a DSM segment. `withSerialPlan` disables per-gather parallelism inside
  // a transaction, mirroring searchClimbs' standardSearch guard. Reproduced live on
  // prod: a bare board_climbs aggregate raised "could not resize shared memory
  // segment". The unused board_climb_stats join is left in place — Postgres already
  // eliminates it via the stats PK when no condition references stats columns
  // (verified by the EXPLAIN harness), so there's nothing to hand-optimize.
  try {
    return await withSerialPlan(dbRead, async (tx) => {
      const baseQuery = tx
        .select({ count: sql<number>`count(*)` })
        .from(boardClimbs)
        .leftJoin(boardClimbStats, and(...filters.getClimbStatsJoinConditions()));
      // LEFT JOIN, never INNER — an inner join would count only the climbs this
      // climber has graded, which is the opposite of what the badge means.
      const result = await (
        personalGradeJoin ? baseQuery.leftJoin(personalGradeJoin.subquery, personalGradeJoin.on) : baseQuery
      ).where(and(...whereConditions));
      return Number(result[0]?.count ?? 0);
    });
  } catch (error) {
    logger.error('Error in countClimbs:', error);
    throw error;
  }
};
