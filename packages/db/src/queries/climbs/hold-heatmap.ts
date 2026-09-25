import { and, eq, sql } from 'drizzle-orm';
import type { DbInstance } from '../../client/postgres';
import { boardClimbGrades, boardClimbHolds, boardClimbs, boardClimbStats } from '../../schema';
import { withSerialPlan, type SerialPlanDb } from '../util/serial-plan';
import { createClimbFilters } from './create-climb-filters';
import {
  boardClimbStatsAtSetAngle,
  effectiveStatsColumn,
  gradeJoinAngleSql,
  resolveBrowsedAngleRestriction,
  resolveCrossAngleStats,
} from './effective-stats';
import type { BoardRouteParams, ClimbSearchParams } from './types';

/** One hold's usage across the climbs a search matches. */
export type HoldHeatmapData = {
  holdId: number;
  totalUses: number;
  startingUses: number;
  handUses: number;
  footUses: number;
  finishUses: number;
  /** Sum of the matched climbs' ascent counts at the browsed angle. */
  totalAscents: number;
  averageDifficulty: number | null;
};

/**
 * Per-hold usage over the climbs one search matches: the live (admin) half of the
 * hold heatmap. Normal climbers get the same aggregate on device from the holds
 * index (packages/mobile/src/db/queries/get-hold-heatmap-local.ts), so the two
 * must filter identically — which is why this builds its WHERE, joins and angle
 * rules from `createClimbFilters` with the exact options `searchClimbs` passes.
 *
 * `holdId` is the renderer/frame id stored in `board_climb_holds`, MoonBoard
 * cells included. Stats (ascents, difficulty) are read from the effective row the
 * list reads, so a Woods cross-angle search counts the same numbers it shows.
 *
 * Runs under `withSerialPlan`, like search and setter stats: a GROUP BY over
 * every hold row of a layout is a plan Postgres happily parallelizes, and the
 * per-worker DSM allocations are what exhausted `/dev/shm` (#3856, #4105).
 */
export async function getHoldHeatmapData(
  db: DbInstance,
  params: BoardRouteParams,
  searchParams: ClimbSearchParams,
  userId?: string,
): Promise<HoldHeatmapData[]> {
  const filters = createClimbFilters(params, searchParams, userId, {
    crossAngleStats: resolveCrossAngleStats(params, searchParams),
    restrictToBrowsedAngle: resolveBrowsedAngleRestriction(params, searchParams),
  });
  const crossAngle = filters.isCrossAngleStats;
  const isDraftsQuery = filters.isOnlyDrafts;

  const rows = await withSerialPlan(db, (tx) => runHoldHeatmapQuery(tx, params, filters, crossAngle, isDraftsQuery));
  return rows.map(normalizeHoldHeatmapRow);
}

async function runHoldHeatmapQuery(
  db: SerialPlanDb,
  params: BoardRouteParams,
  filters: ReturnType<typeof createClimbFilters>,
  crossAngle: boolean,
  isDraftsQuery: boolean,
): Promise<Record<string, unknown>[]> {
  const withStatsJoin = db
    .select({
      holdId: boardClimbHolds.holdId,
      totalUses: sql<number>`COUNT(DISTINCT ${boardClimbHolds.climbUuid})`,
      totalAscents: sql<number>`COALESCE(SUM(${effectiveStatsColumn('ascensionistCount', crossAngle)}), 0)`,
      startingUses: sql<number>`SUM(CASE WHEN ${boardClimbHolds.holdState} = 'STARTING' THEN 1 ELSE 0 END)`,
      handUses: sql<number>`SUM(CASE WHEN ${boardClimbHolds.holdState} = 'HAND' THEN 1 ELSE 0 END)`,
      footUses: sql<number>`SUM(CASE WHEN ${boardClimbHolds.holdState} = 'FOOT' THEN 1 ELSE 0 END)`,
      finishUses: sql<number>`SUM(CASE WHEN ${boardClimbHolds.holdState} = 'FINISH' THEN 1 ELSE 0 END)`,
      averageDifficulty: sql<number | null>`AVG(${effectiveStatsColumn('displayDifficulty', crossAngle)})`,
    })
    .from(boardClimbHolds)
    .innerJoin(boardClimbs, and(...filters.getClimbHoldsJoinConditions()))
    .leftJoin(boardClimbStats, and(...filters.getClimbStatsJoinConditions()));
  // Same join order as runStandardSearch: the set-angle row before the grades
  // join, whose ON clause reads both stats aliases under cross-angle.
  const withSetAngleJoin = crossAngle
    ? withStatsJoin.leftJoin(boardClimbStatsAtSetAngle, and(...filters.getSetAngleStatsJoinConditions()))
    : withStatsJoin;
  // The grade-range filter falls back to the Boardsesh grade for a stats-less
  // climb, so the grades join has to be present for its WHERE to resolve.
  const coreQuery = withSetAngleJoin.leftJoin(
    boardClimbGrades,
    and(
      eq(boardClimbGrades.boardType, params.board_name),
      eq(boardClimbGrades.climbUuid, boardClimbs.uuid),
      sql`${boardClimbGrades.angle} = ${gradeJoinAngleSql(params.angle, crossAngle)}`,
    ),
  );

  return coreQuery
    .where(
      and(
        ...filters.getClimbWhereConditions(),
        // Drafts carry no stats and may lack compatible_size_ids — the same two
        // exemptions searchClimbs makes for a drafts list.
        ...(isDraftsQuery ? [] : filters.getSizeConditions()),
        ...(isDraftsQuery ? [] : filters.getClimbStatsConditions()),
      ),
    )
    .groupBy(boardClimbHolds.holdId);
}

/** Postgres returns COUNT/SUM as bigint text and AVG as numeric text. */
export function normalizeHoldHeatmapRow(row: Record<string, unknown>): HoldHeatmapData {
  return {
    holdId: Number(row.holdId),
    totalUses: Number(row.totalUses) || 0,
    startingUses: Number(row.startingUses) || 0,
    handUses: Number(row.handUses) || 0,
    footUses: Number(row.footUses) || 0,
    finishUses: Number(row.finishUses) || 0,
    totalAscents: Number(row.totalAscents) || 0,
    averageDifficulty: row.averageDifficulty == null ? null : Number(row.averageDifficulty),
  };
}
