import { and, sql } from 'drizzle-orm';
import type { DbInstance } from '../../client/postgres';
import { executeRows } from '../../client/postgres';
import { boardClimbs, boardClimbStats, boardClimbHolds, boardseshTicks } from '../../schema/index';
import { createClimbFilters } from './create-climb-filters';
import type { BoardRouteParams, ClimbSearchParams } from './types';

/**
 * One row of aggregate hold-usage data for a board configuration. Drives the
 * create-climb heatmap (community totals) on web and mobile. The optional
 * `userAscents`/`userAttempts` fields are only populated when a `userId` is
 * supplied (web personal-progress overlay) — the mobile path never passes a
 * userId, so it always gets the community-only shape.
 */
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

/**
 * Aggregate how often each hold is used across the climbs matching a board
 * configuration and (optional) search filters. Shared between the web REST
 * heatmap route + cache and the GraphQL `holdHeatmap` resolver.
 *
 * Pass `dbHandle` (the read replica from the caller) so this stays free of any
 * web/Next coupling — the web wrapper hands in `dbzRead`, the backend hands in
 * `dbRead`. When `userId` is omitted the result carries community totals only.
 *
 * @param dbHandle Drizzle instance (read replica preferred)
 * @param params Board route parameters
 * @param searchParams Search/filter parameters (the same shape used by search)
 * @param userId Optional NextAuth user id for the personal-progress overlay
 */
export const getHoldHeatmapData = async (
  dbHandle: DbInstance,
  params: BoardRouteParams,
  searchParams: ClimbSearchParams,
  userId?: string,
): Promise<HoldHeatmapData[]> => {
  // Use the shared filter creator
  const filters = createClimbFilters(params, searchParams, userId);

  // Check if personal progress filters are active - if so, use user-specific counts
  const personalProgressFiltersEnabled =
    searchParams.hideAttempted ||
    searchParams.hideCompleted ||
    searchParams.showOnlyAttempted ||
    searchParams.showOnlyCompleted;

  let holdStats: Record<string, unknown>[];

  if (personalProgressFiltersEnabled && userId) {
    // When personal progress filters are active, the filters already limit
    // climbs to the user's attempted/completed ones, so the base query is the
    // same but the results are user-filtered.
    holdStats = await dbHandle
      .select({
        holdId: boardClimbHolds.holdId,
        totalUses: sql<number>`COUNT(DISTINCT ${boardClimbHolds.climbUuid})`,
        totalAscents: sql<number>`COUNT(DISTINCT ${boardClimbHolds.climbUuid})`,
        startingUses: sql<number>`SUM(CASE WHEN ${boardClimbHolds.holdState} = 'STARTING' THEN 1 ELSE 0 END)`,
        handUses: sql<number>`SUM(CASE WHEN ${boardClimbHolds.holdState} = 'HAND' THEN 1 ELSE 0 END)`,
        footUses: sql<number>`SUM(CASE WHEN ${boardClimbHolds.holdState} = 'FOOT' THEN 1 ELSE 0 END)`,
        finishUses: sql<number>`SUM(CASE WHEN ${boardClimbHolds.holdState} = 'FINISH' THEN 1 ELSE 0 END)`,
        averageDifficulty: sql<number>`AVG(${boardClimbStats.displayDifficulty})`,
      })
      .from(boardClimbHolds)
      .innerJoin(boardClimbs, and(...filters.getClimbHoldsJoinConditions()))
      .leftJoin(boardClimbStats, and(...filters.getHoldHeatmapClimbStatsConditions()))
      .where(
        and(...filters.getClimbWhereConditions(), ...filters.getSizeConditions(), ...filters.getClimbStatsConditions()),
      )
      .groupBy(boardClimbHolds.holdId);
  } else {
    // Global community stats when no personal progress filters are active.
    holdStats = await dbHandle
      .select({
        holdId: boardClimbHolds.holdId,
        totalUses: sql<number>`COUNT(DISTINCT ${boardClimbHolds.climbUuid})`,
        totalAscents: sql<number>`SUM(${boardClimbStats.ascensionistCount})`,
        startingUses: sql<number>`SUM(CASE WHEN ${boardClimbHolds.holdState} = 'STARTING' THEN 1 ELSE 0 END)`,
        handUses: sql<number>`SUM(CASE WHEN ${boardClimbHolds.holdState} = 'HAND' THEN 1 ELSE 0 END)`,
        footUses: sql<number>`SUM(CASE WHEN ${boardClimbHolds.holdState} = 'FOOT' THEN 1 ELSE 0 END)`,
        finishUses: sql<number>`SUM(CASE WHEN ${boardClimbHolds.holdState} = 'FINISH' THEN 1 ELSE 0 END)`,
        averageDifficulty: sql<number>`AVG(${boardClimbStats.displayDifficulty})`,
      })
      .from(boardClimbHolds)
      .innerJoin(boardClimbs, and(...filters.getClimbHoldsJoinConditions()))
      .leftJoin(boardClimbStats, and(...filters.getHoldHeatmapClimbStatsConditions()))
      .where(
        and(...filters.getClimbWhereConditions(), ...filters.getSizeConditions(), ...filters.getClimbStatsConditions()),
      )
      .groupBy(boardClimbHolds.holdId);
  }

  // Add user-specific data only if not already computed in the main query.
  if (userId && !personalProgressFiltersEnabled) {
    // Per-hold user ascents/attempts come from boardsesh_ticks (NextAuth userId).
    const [userAscentsRows, userAttemptsRows] = await Promise.all([
      executeRows<{ hold_id: number; user_ascents: number }>(
        dbHandle,
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
        dbHandle,
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

    const ascentsMap = new Map<number, number>();
    const attemptsMap = new Map<number, number>();

    for (const row of userAscentsRows) {
      ascentsMap.set(Number(row.hold_id), Number(row.user_ascents));
    }
    for (const row of userAttemptsRows) {
      attemptsMap.set(Number(row.hold_id), Number(row.user_attempts));
    }

    holdStats = holdStats.map((stat) => ({
      ...stat,
      userAscents: ascentsMap.get(Number(stat.holdId)) || 0,
      userAttempts: attemptsMap.get(Number(stat.holdId)) || 0,
    }));
  } else if (personalProgressFiltersEnabled && userId) {
    // The main stats already ARE the user stats, but the frontend still expects
    // userAscents/userAttempts fields for backward compatibility.
    holdStats = holdStats.map((stat) => ({
      ...stat,
      userAscents: Number(stat.totalAscents) || 0,
      userAttempts: Number(stat.totalUses) || 0,
    }));
  }

  return holdStats.map((stats) => normalizeStats(stats, userId));
};

function normalizeStats(stats: Record<string, unknown>, userId?: string): HoldHeatmapData {
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

  if (userId) {
    result.userAscents = Number(stats.userAscents || 0);
    result.userAttempts = Number(stats.userAttempts || 0);
  }

  return result;
}
