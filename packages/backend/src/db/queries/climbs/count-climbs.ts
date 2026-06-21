import { sql, and } from 'drizzle-orm';
import { dbRead } from '../../client';
import { boardClimbs, boardClimbStats } from '@boardsesh/db/schema';
import { createClimbFilters, type BoardRouteParams, type ClimbSearchParams } from '@boardsesh/db/queries';
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
  // allocates a DSM segment. Disable per-gather parallelism inside a transaction
  // (SET LOCAL needs a transaction; the client runs prepare:false behind PgBouncer
  // transaction pooling), mirroring searchClimbs' standardSearch guard. Reproduced
  // live on prod: a bare board_climbs aggregate raised "could not resize shared
  // memory segment". The unused board_climb_stats join is left in place — Postgres
  // already eliminates it via the stats PK when no condition references stats columns
  // (verified by the EXPLAIN harness), so there's nothing to hand-optimize.
  try {
    return await dbRead.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL max_parallel_workers_per_gather = 0`);
      const result = await tx
        .select({ count: sql<number>`count(*)` })
        .from(boardClimbs)
        .leftJoin(boardClimbStats, and(...filters.getClimbStatsJoinConditions()))
        .where(and(...whereConditions));
      return Number(result[0]?.count ?? 0);
    });
  } catch (error) {
    logger.error('Error in countClimbs:', error);
    throw error;
  }
};
