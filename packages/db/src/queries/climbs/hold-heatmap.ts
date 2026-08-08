import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbInstance } from '../../client/postgres';
import { boardClimbHolds, boardClimbs, boardClimbStats, boardseshTicks } from '../../schema';
import { createClimbFilters } from './create-climb-filters';
import type { BoardRouteParams, ClimbSearchParams } from './types';

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
 * Aggregate hold usage for one physical board configuration. `holdId` is the
 * renderer/frame cell id stored in board_climb_holds, including for MoonBoard.
 */
export async function getHoldHeatmapData(
  db: DbInstance,
  params: BoardRouteParams,
  searchParams: ClimbSearchParams,
  userId?: string,
): Promise<HoldHeatmapData[]> {
  const filters = createClimbFilters(params, searchParams, userId);

  let holdStats: Record<string, unknown>[] = await db
    .select({
      holdId: boardClimbHolds.holdId,
      totalUses: sql<number>`COUNT(DISTINCT ${boardClimbHolds.climbUuid})`,
      totalAscents: sql<number>`COALESCE(SUM(${boardClimbStats.ascensionistCount}), 0)`,
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

  if (userId) {
    const [userAscents, userAttempts] = await Promise.all([
      db
        .select({
          holdId: boardClimbHolds.holdId,
          userAscents: sql<number>`COUNT(*)`,
        })
        .from(boardseshTicks)
        .innerJoin(
          boardClimbHolds,
          and(
            eq(boardseshTicks.climbUuid, boardClimbHolds.climbUuid),
            eq(boardClimbHolds.boardType, params.board_name),
          ),
        )
        .innerJoin(boardClimbs, and(...filters.getClimbHoldsJoinConditions()))
        .leftJoin(boardClimbStats, and(...filters.getHoldHeatmapClimbStatsConditions()))
        .where(
          and(
            eq(boardseshTicks.userId, userId),
            eq(boardseshTicks.boardType, params.board_name),
            eq(boardseshTicks.angle, params.angle),
            inArray(boardseshTicks.status, ['flash', 'send']),
            ...filters.getClimbWhereConditions(),
            ...filters.getSizeConditions(),
            ...filters.getClimbStatsConditions(),
          ),
        )
        .groupBy(boardClimbHolds.holdId),
      db
        .select({
          holdId: boardClimbHolds.holdId,
          userAttempts: sql<number>`COALESCE(SUM(${boardseshTicks.attemptCount}), 0)`,
        })
        .from(boardseshTicks)
        .innerJoin(
          boardClimbHolds,
          and(
            eq(boardseshTicks.climbUuid, boardClimbHolds.climbUuid),
            eq(boardClimbHolds.boardType, params.board_name),
          ),
        )
        .innerJoin(boardClimbs, and(...filters.getClimbHoldsJoinConditions()))
        .leftJoin(boardClimbStats, and(...filters.getHoldHeatmapClimbStatsConditions()))
        .where(
          and(
            eq(boardseshTicks.userId, userId),
            eq(boardseshTicks.boardType, params.board_name),
            eq(boardseshTicks.angle, params.angle),
            ...filters.getClimbWhereConditions(),
            ...filters.getSizeConditions(),
            ...filters.getClimbStatsConditions(),
          ),
        )
        .groupBy(boardClimbHolds.holdId),
    ]);
    const ascentsByHold = new Map(userAscents.map((row) => [Number(row.holdId), Number(row.userAscents)]));
    const attemptsByHold = new Map(userAttempts.map((row) => [Number(row.holdId), Number(row.userAttempts)]));
    holdStats = holdStats.map((stat) => ({
      ...stat,
      userAscents: ascentsByHold.get(Number(stat.holdId)) ?? 0,
      userAttempts: attemptsByHold.get(Number(stat.holdId)) ?? 0,
    }));
  }

  return holdStats.map((stats) => normalizeHoldHeatmapData(stats, userId));
}

function normalizeHoldHeatmapData(stats: Record<string, unknown>, userId?: string): HoldHeatmapData {
  const result: HoldHeatmapData = {
    holdId: Number(stats.holdId),
    totalUses: Number(stats.totalUses) || 0,
    totalAscents: Number(stats.totalAscents) || 0,
    startingUses: Number(stats.startingUses) || 0,
    handUses: Number(stats.handUses) || 0,
    footUses: Number(stats.footUses) || 0,
    finishUses: Number(stats.finishUses) || 0,
    averageDifficulty: stats.averageDifficulty == null ? null : Number(stats.averageDifficulty),
  };
  if (userId) {
    result.userAscents = Number(stats.userAscents) || 0;
    result.userAttempts = Number(stats.userAttempts) || 0;
  }
  return result;
}
