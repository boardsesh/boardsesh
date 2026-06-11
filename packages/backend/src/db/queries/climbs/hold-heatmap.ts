import { and, eq, inArray, sql } from 'drizzle-orm';
import { boardseshTicks } from '@boardsesh/db/schema';
import { createClimbFilters, type BoardRouteParams, type ClimbSearchParams } from '@boardsesh/db/queries';
import { dbRead } from '../../client';
import { UNIFIED_TABLES } from '../util/table-select';

export type HoldHeatmapPoint = {
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

type RawHoldHeatmapRow = {
  holdId: number | string | bigint | null;
  totalUses: number | string | bigint | null;
  startingUses: number | string | bigint | null;
  totalAscents: number | string | bigint | null;
  handUses: number | string | bigint | null;
  footUses: number | string | bigint | null;
  finishUses: number | string | bigint | null;
  averageDifficulty: number | string | null;
  userAscents?: number | string | bigint | null;
  userAttempts?: number | string | bigint | null;
};

export async function getHoldHeatmapData(
  params: BoardRouteParams,
  searchParams: ClimbSearchParams,
  userId?: string,
): Promise<HoldHeatmapPoint[]> {
  const { climbs, climbStats, climbHolds } = UNIFIED_TABLES;
  const filters = createClimbFilters(params, searchParams, userId);
  const personalProgressFiltersEnabled =
    searchParams.hideAttempted ||
    searchParams.hideCompleted ||
    searchParams.showOnlyAttempted ||
    searchParams.showOnlyCompleted;

  let holdStats: RawHoldHeatmapRow[];

  if (personalProgressFiltersEnabled && userId) {
    holdStats = await dbRead
      .select({
        holdId: climbHolds.holdId,
        totalUses: sql<number>`COUNT(DISTINCT ${climbHolds.climbUuid})`,
        // In user-filtered mode this is the user's matching climb count per hold.
        totalAscents: sql<number>`COUNT(DISTINCT ${climbHolds.climbUuid})`,
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
        and(...filters.getClimbWhereConditions(), ...filters.getSizeConditions(), ...filters.getClimbStatsConditions()),
      )
      .groupBy(climbHolds.holdId);
  } else {
    holdStats = await dbRead
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
        and(...filters.getClimbWhereConditions(), ...filters.getSizeConditions(), ...filters.getClimbStatsConditions()),
      )
      .groupBy(climbHolds.holdId);
  }

  if (userId && !personalProgressFiltersEnabled) {
    const [userAscentsRows, userAttemptsRows] = await Promise.all([
      dbRead
        .select({
          holdId: climbHolds.holdId,
          userAscents: sql<number>`COUNT(*)`,
        })
        .from(boardseshTicks)
        .innerJoin(
          climbHolds,
          and(eq(boardseshTicks.climbUuid, climbHolds.climbUuid), eq(climbHolds.boardType, params.board_name)),
        )
        .where(
          and(
            eq(boardseshTicks.userId, userId),
            eq(boardseshTicks.boardType, params.board_name),
            eq(boardseshTicks.angle, params.angle),
            inArray(boardseshTicks.status, ['flash', 'send']),
          ),
        )
        .groupBy(climbHolds.holdId),
      dbRead
        .select({
          holdId: climbHolds.holdId,
          userAttempts: sql<number>`SUM(${boardseshTicks.attemptCount})`,
        })
        .from(boardseshTicks)
        .innerJoin(
          climbHolds,
          and(eq(boardseshTicks.climbUuid, climbHolds.climbUuid), eq(climbHolds.boardType, params.board_name)),
        )
        .where(
          and(
            eq(boardseshTicks.userId, userId),
            eq(boardseshTicks.boardType, params.board_name),
            eq(boardseshTicks.angle, params.angle),
          ),
        )
        .groupBy(climbHolds.holdId),
    ]);

    const ascentsByHold = new Map(userAscentsRows.map((row) => [Number(row.holdId), Number(row.userAscents ?? 0)]));
    const attemptsByHold = new Map(userAttemptsRows.map((row) => [Number(row.holdId), Number(row.userAttempts ?? 0)]));

    holdStats = holdStats.map((stat) => ({
      ...stat,
      userAscents: ascentsByHold.get(Number(stat.holdId)) ?? 0,
      userAttempts: attemptsByHold.get(Number(stat.holdId)) ?? 0,
    }));
  } else if (personalProgressFiltersEnabled && userId) {
    holdStats = holdStats.map((stat) => ({
      ...stat,
      userAscents: Number(stat.totalAscents ?? 0),
      userAttempts: Number(stat.totalUses ?? 0),
    }));
  }

  return holdStats.map((stat) => normalizeStats(stat, userId));
}

function normalizeStats(stats: RawHoldHeatmapRow, userId?: string): HoldHeatmapPoint {
  const result: HoldHeatmapPoint = {
    holdId: Number(stats.holdId),
    totalUses: Number(stats.totalUses ?? 0),
    totalAscents: Number(stats.totalAscents ?? 0),
    startingUses: Number(stats.startingUses ?? 0),
    handUses: Number(stats.handUses ?? 0),
    footUses: Number(stats.footUses ?? 0),
    finishUses: Number(stats.finishUses ?? 0),
    averageDifficulty: stats.averageDifficulty == null ? null : Number(stats.averageDifficulty),
  };

  if (userId) {
    result.userAscents = Number(stats.userAscents ?? 0);
    result.userAttempts = Number(stats.userAttempts ?? 0);
  }

  return result;
}
