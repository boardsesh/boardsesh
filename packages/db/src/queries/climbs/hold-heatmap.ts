import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { boardClimbHolds, boardClimbs, boardClimbStats, boardseshTicks } from '../../schema';
import { withSerialPlan, type SerialPlanDb } from '../util/serial-plan';
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
 *
 * Personal-progress filters (hideAttempted / hideCompleted / showOnlyAttempted /
 * showOnlyCompleted) already narrow the climb set to the caller's own climbs, so
 * the community `SUM(ascensionist_count)` would double-count against a personal
 * view. In that mode `totalAscents` is the user's climb count per hold and the
 * two tick roll-ups are skipped — the main aggregate already *is* the user's
 * data. This mirrors the web behaviour this function was extracted from.
 */
export async function getHoldHeatmapData(
  db: SerialPlanDb,
  params: BoardRouteParams,
  searchParams: ClimbSearchParams,
  userId?: string,
): Promise<HoldHeatmapData[]> {
  const filters = createClimbFilters(params, searchParams, userId);

  const personalProgressFiltersEnabled = Boolean(
    searchParams.hideAttempted ||
    searchParams.hideCompleted ||
    searchParams.showOnlyAttempted ||
    searchParams.showOnlyCompleted,
  );
  const personalMode = personalProgressFiltersEnabled && !!userId;

  const heatmapWhere = and(
    ...filters.getClimbWhereConditions(),
    ...filters.getSizeConditions(),
    ...filters.getClimbStatsConditions(),
  );

  // This GROUP BY over board_climb_holds (millions of rows) LEFT JOIN
  // board_climb_stats is the plan-shape class that exhausted Postgres /dev/shm
  // in #2378: on a broad filter the planner fans it out into a parallel hash
  // join whose workers each allocate a dynamic-shared-memory segment, and an
  // under-provisioned shared-memory container then raises "could not resize
  // shared memory segment". `withSerialPlan` disables per-gather parallelism
  // inside a transaction, the same guard searchClimbs / countClimbs use.
  const runHeatmapAggregate = (totalAscents: SQL<number>) =>
    withSerialPlan(db, async (tx) =>
      tx
        .select({
          holdId: boardClimbHolds.holdId,
          totalUses: sql<number>`COUNT(DISTINCT ${boardClimbHolds.climbUuid})`,
          totalAscents,
          startingUses: sql<number>`SUM(CASE WHEN ${boardClimbHolds.holdState} = 'STARTING' THEN 1 ELSE 0 END)`,
          handUses: sql<number>`SUM(CASE WHEN ${boardClimbHolds.holdState} = 'HAND' THEN 1 ELSE 0 END)`,
          footUses: sql<number>`SUM(CASE WHEN ${boardClimbHolds.holdState} = 'FOOT' THEN 1 ELSE 0 END)`,
          finishUses: sql<number>`SUM(CASE WHEN ${boardClimbHolds.holdState} = 'FINISH' THEN 1 ELSE 0 END)`,
          averageDifficulty: sql<number>`AVG(${boardClimbStats.displayDifficulty})`,
        })
        .from(boardClimbHolds)
        .innerJoin(boardClimbs, and(...filters.getClimbHoldsJoinConditions()))
        .leftJoin(boardClimbStats, and(...filters.getHoldHeatmapClimbStatsConditions()))
        .where(heatmapWhere)
        .groupBy(boardClimbHolds.holdId),
    );

  let holdStats: Record<string, unknown>[] = personalMode
    ? await runHeatmapAggregate(sql<number>`COUNT(DISTINCT ${boardClimbHolds.climbUuid})`)
    : await runHeatmapAggregate(sql<number>`COALESCE(SUM(${boardClimbStats.ascensionistCount}), 0)`);

  if (userId && !personalMode) {
    // The tick roll-ups join back through board_climbs under the same filters as
    // the community aggregate. MoonBoard reuses frame cell ids across layouts and
    // hold sets, so an unscoped tick join would bleed another MoonBoard variant's
    // sends into this board's heatmap.
    const [userAscents, userAttempts] = await Promise.all([
      withSerialPlan(db, async (tx) =>
        tx
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
      ),
      withSerialPlan(db, async (tx) =>
        tx
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
      ),
    ]);
    const ascentsByHold = new Map(userAscents.map((row) => [Number(row.holdId), Number(row.userAscents)]));
    const attemptsByHold = new Map(userAttempts.map((row) => [Number(row.holdId), Number(row.userAttempts)]));
    holdStats = holdStats.map((stat) => ({
      ...stat,
      userAscents: ascentsByHold.get(Number(stat.holdId)) ?? 0,
      userAttempts: attemptsByHold.get(Number(stat.holdId)) ?? 0,
    }));
  } else if (personalMode) {
    // Under personal-progress filters the main aggregate already counts only the
    // user's climbs, so the user columns read straight off it.
    holdStats = holdStats.map((stat) => ({
      ...stat,
      userAscents: Number(stat.totalAscents) || 0,
      userAttempts: Number(stat.totalUses) || 0,
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
