import { and, sql, type SQL } from 'drizzle-orm';
import { dbzRead as db, executeRows } from '@/app/lib/db/db';
import type { ParsedBoardRouteParameters, SearchRequestPagination } from '@/app/lib/types';
import { UNIFIED_TABLES } from '@/lib/db/queries/util/table-select';
import { createClimbFilters } from '@boardsesh/db/queries';
import { boardseshTicks } from '@/app/lib/db/schema';

export type HoldHeatmapData = {
  holdId: number;
  totalUses: number;
  startingUses: number;
  totalAscents: number;
  handUses: number;
  footUses: number;
  finishUses: number;
  averageDifficulty: number | null;
  userAscents?: number;
  userAttempts?: number;
};

export const getHoldHeatmapData = async (
  params: ParsedBoardRouteParameters,
  searchParams: SearchRequestPagination,
  userId?: string,
): Promise<HoldHeatmapData[]> => {
  const { climbs, climbStats, climbHolds } = UNIFIED_TABLES;

  // Use the shared filter creator
  // Personal grades (#4828) are deliberately dropped here rather than honoured.
  // The grade filter they produce reads a `my_grade` alias that only the search
  // paths left-join (`filters.getPersonalGradeJoin()`); this aggregate spreads
  // `getClimbWhereConditions()` without that join, so an inbound `useMyGrades`
  // would raise 42P01 — a 500 rather than wrong rows. Unreachable today (web
  // never parses the param, see `urlParamsToSearchParams`), so this is a guard
  // against a future caller, not a live bug. Honouring it properly means adding
  // the join here too; see the search paths for the shape.
  const filters = createClimbFilters(params, { ...searchParams, useMyGrades: false }, userId);

  try {
    // Check if personal progress filters are active - if so, use user-specific counts
    const personalProgressFiltersEnabled =
      searchParams.hideAttempted ||
      searchParams.hideCompleted ||
      searchParams.showOnlyAttempted ||
      searchParams.showOnlyCompleted;

    let holdStats: Record<string, unknown>[];

    // This GROUP BY over board_climb_holds (millions of rows) LEFT JOIN
    // board_climb_stats is the same plan-shape class that exhausted Postgres
    // /dev/shm in #2378: on a broad filter the planner fans it out into a
    // parallel hash join whose workers each allocate a dynamic-shared-memory
    // segment, and an under-provisioned shared-memory container then raises
    // "could not resize shared memory segment". Run it with per-gather
    // parallelism disabled inside a transaction (SET LOCAL needs one; the pool
    // runs prepare:false behind PgBouncer transaction pooling), mirroring the
    // searchClimbs / countClimbs guards in @boardsesh/db.
    const heatmapWhere = and(
      ...filters.getClimbWhereConditions(),
      ...filters.getSizeConditions(),
      ...filters.getClimbStatsConditions(),
    );

    // Both the personal-progress and community branches run the identical shape;
    // only the totalAscents column differs. Share one runner so the guard and the
    // join/where/groupBy stay in lockstep across both.
    const runHeatmapAggregate = (totalAscents: SQL<number>) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL max_parallel_workers_per_gather = 0`);
        return tx
          .select({
            holdId: climbHolds.holdId,
            totalUses: sql<number>`COUNT(DISTINCT ${climbHolds.climbUuid})`,
            totalAscents,
            startingUses: sql<number>`SUM(CASE WHEN ${climbHolds.holdState} = 'STARTING' THEN 1 ELSE 0 END)`,
            handUses: sql<number>`SUM(CASE WHEN ${climbHolds.holdState} = 'HAND' THEN 1 ELSE 0 END)`,
            footUses: sql<number>`SUM(CASE WHEN ${climbHolds.holdState} = 'FOOT' THEN 1 ELSE 0 END)`,
            finishUses: sql<number>`SUM(CASE WHEN ${climbHolds.holdState} = 'FINISH' THEN 1 ELSE 0 END)`,
            averageDifficulty: sql<number>`AVG(${climbStats.displayDifficulty})`,
          })
          .from(climbHolds)
          .innerJoin(climbs, and(...filters.getClimbHoldsJoinConditions()))
          .leftJoin(climbStats, and(...filters.getHoldHeatmapClimbStatsConditions()))
          .where(heatmapWhere)
          .groupBy(climbHolds.holdId);
      });

    if (personalProgressFiltersEnabled && userId) {
      // The filters already limit climbs to the user's attempted/completed ones, so
      // totalAscents is the user's climb count per hold (same shape as totalUses).
      holdStats = await runHeatmapAggregate(sql<number>`COUNT(DISTINCT ${climbHolds.climbUuid})`);
    } else {
      // Global community stats: sum ascents across the matching climbs per hold.
      holdStats = await runHeatmapAggregate(sql<number>`SUM(${climbStats.ascensionistCount})`);
    }

    // Add user-specific data only if not already computed in the main query
    if (userId && !personalProgressFiltersEnabled) {
      // Only fetch separate user data if we're not already using user-specific main stats
      // Uses boardsesh_ticks (NextAuth userId)

      // Query for user ascents and attempts per hold in parallel
      const [userAscentsQuery, userAttemptsQuery] = await Promise.all([
        executeRows<{ hold_id: number; user_ascents: number }>(
          db,
          sql`
          SELECT ch.hold_id, COUNT(*) as user_ascents
          FROM ${boardseshTicks} t
          JOIN board_climb_holds ch ON t.climb_uuid = ch.climb_uuid AND ch.board_type = ${params.board_name}
          WHERE t.user_id = ${userId}
            AND t.board_type = ${params.board_name}
            AND t.angle = ${params.angle}
            AND t.status IN ('flash', 'send')
          GROUP BY ch.hold_id
        `,
        ),
        executeRows<{ hold_id: number; user_attempts: number }>(
          db,
          sql`
          SELECT ch.hold_id, SUM(t.attempt_count) as user_attempts
          FROM ${boardseshTicks} t
          JOIN board_climb_holds ch ON t.climb_uuid = ch.climb_uuid AND ch.board_type = ${params.board_name}
          WHERE t.user_id = ${userId}
            AND t.board_type = ${params.board_name}
            AND t.angle = ${params.angle}
          GROUP BY ch.hold_id
        `,
        ),
      ]);

      // Convert results to Maps for easier lookup
      const ascentsMap = new Map();
      const attemptsMap = new Map();

      for (const row of userAscentsQuery) {
        ascentsMap.set(Number(row.hold_id), Number(row.user_ascents));
      }

      for (const row of userAttemptsQuery) {
        attemptsMap.set(Number(row.hold_id), Number(row.user_attempts));
      }

      // Merge the user data with the hold stats
      holdStats = holdStats.map((stat) => ({
        ...stat,
        userAscents: ascentsMap.get(Number(stat.holdId)) || 0,
        userAttempts: attemptsMap.get(Number(stat.holdId)) || 0,
      }));
    } else if (personalProgressFiltersEnabled && userId) {
      // When using personal progress filters, the main stats ARE the user stats,
      // but we still need to provide the userAscents and userAttempts fields
      // for backward compatibility with the frontend
      holdStats = holdStats.map((stat) => ({
        ...stat,
        userAscents: Number(stat.totalAscents) || 0,
        userAttempts: Number(stat.totalUses) || 0,
      }));
    }

    return holdStats.map((stats) => normalizeStats(stats, userId));
  } catch (error) {
    console.error('Error in getHoldHeatmapData:', error);
    throw error;
  }
};

function normalizeStats(stats: Record<string, unknown>, userId?: string): HoldHeatmapData {
  // For numeric fields, ensure we're returning a number and handle null/undefined properly
  const result: HoldHeatmapData = {
    holdId: Number(stats.holdId),
    totalUses: Number(stats.totalUses || 0),
    totalAscents: Number(stats.totalAscents || 0),
    startingUses: Number(stats.startingUses || 0),
    handUses: Number(stats.handUses || 0),
    footUses: Number(stats.footUses || 0),
    finishUses: Number(stats.finishUses || 0),
    averageDifficulty: stats.averageDifficulty ? Number(stats.averageDifficulty) : null,
  };

  // Add user-specific fields if userId was provided
  if (userId) {
    result.userAscents = Number(stats.userAscents || 0);
    result.userAttempts = Number(stats.userAttempts || 0);
  }

  return result;
}
