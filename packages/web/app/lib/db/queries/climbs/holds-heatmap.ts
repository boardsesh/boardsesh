import { and, sql } from 'drizzle-orm';
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
  const filters = createClimbFilters(params, searchParams, userId);

  try {
    // Check if personal progress filters are active - if so, use user-specific counts
    const personalProgressFiltersEnabled =
      searchParams.hideAttempted ||
      searchParams.hideCompleted ||
      searchParams.showOnlyAttempted ||
      searchParams.showOnlyCompleted;

    let holdStats: Record<string, unknown>[];

    if (personalProgressFiltersEnabled && userId) {
      // When personal progress filters are active, we need to compute user-specific hold statistics
      // Since the filters already limit climbs to user's attempted/completed ones,
      // we can use the same base query but the results will be user-filtered
      const baseQuery = db
        .select({
          holdId: climbHolds.holdId,
          totalUses: sql<number>`COUNT(DISTINCT ${climbHolds.climbUuid})`,
          totalAscents: sql<number>`COUNT(DISTINCT ${climbHolds.climbUuid})`, // For user mode, this represents user's climb count per hold
          startingUses: sql<number>`SUM(CASE WHEN ${climbHolds.holdState} = 'STARTING' THEN 1 ELSE 0 END)`,
          handUses: sql<number>`SUM(CASE WHEN ${climbHolds.holdState} = 'HAND' THEN 1 ELSE 0 END)`,
          footUses: sql<number>`SUM(CASE WHEN ${climbHolds.holdState} = 'FOOT' THEN 1 ELSE 0 END)`,
          finishUses: sql<number>`SUM(CASE WHEN ${climbHolds.holdState} = 'FINISH' THEN 1 ELSE 0 END)`,
          averageDifficulty: sql<number>`AVG(${climbStats.displayDifficulty})`,
        })
        .from(climbHolds)
        .innerJoin(climbs, and(...filters.getClimbHoldsJoinConditions()))
        .leftJoin(climbStats, and(...filters.getHoldHeatmapClimbStatsConditions()))
        .where(
          and(
            ...filters.getClimbWhereConditions(),
            ...filters.getSizeConditions(),
            ...filters.getClimbStatsConditions(),
          ),
        )
        .groupBy(climbHolds.holdId);

      holdStats = await baseQuery;
    } else {
      // Use global community stats when no personal progress filters are active
      const baseQuery = db
        .select({
          holdId: climbHolds.holdId,
          totalUses: sql<number>`COUNT(DISTINCT ${climbHolds.climbUuid})`,
          totalAscents: sql<number>`SUM(${climbStats.ascensionistCount})`,
          startingUses: sql<number>`SUM(CASE WHEN ${climbHolds.holdState} = 'STARTING' THEN 1 ELSE 0 END)`,
          handUses: sql<number>`SUM(CASE WHEN ${climbHolds.holdState} = 'HAND' THEN 1 ELSE 0 END)`,
          footUses: sql<number>`SUM(CASE WHEN ${climbHolds.holdState} = 'FOOT' THEN 1 ELSE 0 END)`,
          finishUses: sql<number>`SUM(CASE WHEN ${climbHolds.holdState} = 'FINISH' THEN 1 ELSE 0 END)`,
          averageDifficulty: sql<number>`AVG(${climbStats.displayDifficulty})`,
        })
        .from(climbHolds)
        .innerJoin(climbs, and(...filters.getClimbHoldsJoinConditions()))
        .leftJoin(climbStats, and(...filters.getHoldHeatmapClimbStatsConditions()))
        .where(
          and(
            ...filters.getClimbWhereConditions(),
            ...filters.getSizeConditions(),
            ...filters.getClimbStatsConditions(),
          ),
        )
        .groupBy(climbHolds.holdId);

      holdStats = await baseQuery;
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
