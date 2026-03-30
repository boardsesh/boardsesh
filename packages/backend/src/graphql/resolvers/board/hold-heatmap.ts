import { eq, sql, and } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import { UNIFIED_TABLES } from '../../../db/queries/util/table-select';
import { getSizeEdges } from '../../../db/queries/util/product-sizes-data';
import { isValidBoardName, type BoardName } from '../../../db/queries/util/table-select';
import { validateInput } from '../shared/helpers';
import { BoardNameSchema } from '../../../validation/schemas';
import * as dbSchema from '@boardsesh/db/schema';

export interface HeatmapInput {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  gradeAccuracy?: string;
  minGrade?: number;
  maxGrade?: number;
  minAscents?: number;
  minRating?: number;
  sortBy?: string;
  sortOrder?: string;
  name?: string;
  settername?: string;
  onlyClassics?: boolean;
  onlyTallClimbs?: boolean;
  holdsFilter?: Record<string, unknown>;
}

export interface HoldStat {
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
}

export const holdHeatmapQuery = {
  holdHeatmap: async (
    _: unknown,
    { input }: { input: HeatmapInput },
    ctx: ConnectionContext,
  ): Promise<HoldStat[]> => {
    validateInput(BoardNameSchema, input.boardName, 'boardName');

    if (!isValidBoardName(input.boardName)) {
      throw new Error(`Invalid board name: ${input.boardName}`);
    }

    const boardName = input.boardName as BoardName;

    // MoonBoard doesn't have heatmap data
    if (boardName === 'moonboard') {
      return [];
    }

    const sizeEdges = getSizeEdges(boardName, input.sizeId);
    if (!sizeEdges) {
      return [];
    }

    const { climbs, climbStats, climbHolds } = UNIFIED_TABLES;
    const userId = ctx.isAuthenticated ? ctx.userId : undefined;

    try {
      // Build base WHERE conditions for climbs
      const climbConditions = [
        eq(climbs.boardType, boardName),
        eq(climbs.layoutId, input.layoutId),
        sql`${climbs.edgeLeft} > ${sizeEdges.edgeLeft}`,
        sql`${climbs.edgeRight} < ${sizeEdges.edgeRight}`,
        sql`${climbs.edgeBottom} > ${sizeEdges.edgeBottom}`,
        sql`${climbs.edgeTop} < ${sizeEdges.edgeTop}`,
        sql`${climbs.isListed} = true`,
        sql`${climbs.isDraft} = false`,
        sql`${climbs.framesCount} = 1`,
      ];

      // Add optional filters
      if (input.minAscents) {
        climbConditions.push(sql`${climbStats.ascensionistCount} >= ${input.minAscents}`);
      }
      if (input.minGrade) {
        climbConditions.push(sql`${climbStats.displayDifficulty} >= ${input.minGrade}`);
      }
      if (input.maxGrade) {
        climbConditions.push(sql`${climbStats.displayDifficulty} <= ${input.maxGrade}`);
      }
      if (input.minRating) {
        climbConditions.push(sql`${climbStats.qualityAverage} >= ${input.minRating}`);
      }
      if (input.name) {
        climbConditions.push(sql`${climbs.name} ILIKE ${'%' + input.name + '%'}`);
      }
      if (input.settername) {
        climbConditions.push(sql`${climbs.setterUsername} ILIKE ${'%' + input.settername + '%'}`);
      }

      const holdStats = await db
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
        .innerJoin(
          climbs,
          and(
            eq(climbHolds.climbUuid, climbs.uuid),
            eq(climbHolds.boardType, climbs.boardType),
          ),
        )
        .leftJoin(
          climbStats,
          and(
            eq(climbStats.climbUuid, climbs.uuid),
            eq(climbStats.boardType, boardName),
            eq(climbStats.angle, input.angle),
          ),
        )
        .where(and(...climbConditions))
        .groupBy(climbHolds.holdId);

      let results: HoldStat[] = holdStats.map(stat => ({
        holdId: Number(stat.holdId),
        totalUses: Number(stat.totalUses || 0),
        startingUses: Number(stat.startingUses || 0),
        totalAscents: Number(stat.totalAscents || 0),
        handUses: Number(stat.handUses || 0),
        footUses: Number(stat.footUses || 0),
        finishUses: Number(stat.finishUses || 0),
        averageDifficulty: stat.averageDifficulty ? Number(stat.averageDifficulty) : null,
      }));

      // Add user-specific data if authenticated
      if (userId) {
        const [userAscentsQuery, userAttemptsQuery] = await Promise.all([
          db.execute(sql`
            SELECT ch.hold_id, COUNT(*) as user_ascents
            FROM ${dbSchema.boardseshTicks} t
            JOIN board_climb_holds ch ON t.climb_uuid = ch.climb_uuid AND ch.board_type = ${boardName}
            WHERE t.user_id = ${userId}
              AND t.board_type = ${boardName}
              AND t.angle = ${input.angle}
              AND t.status IN ('flash', 'send')
            GROUP BY ch.hold_id
          `),
          db.execute(sql`
            SELECT ch.hold_id, SUM(t.attempt_count) as user_attempts
            FROM ${dbSchema.boardseshTicks} t
            JOIN board_climb_holds ch ON t.climb_uuid = ch.climb_uuid AND ch.board_type = ${boardName}
            WHERE t.user_id = ${userId}
              AND t.board_type = ${boardName}
              AND t.angle = ${input.angle}
            GROUP BY ch.hold_id
          `),
        ]);

        const ascentsMap = new Map<number, number>();
        const attemptsMap = new Map<number, number>();

        const ascentsRows = Array.isArray(userAscentsQuery) ? userAscentsQuery : (userAscentsQuery as { rows: Record<string, unknown>[] }).rows;
        const attemptsRows = Array.isArray(userAttemptsQuery) ? userAttemptsQuery : (userAttemptsQuery as { rows: Record<string, unknown>[] }).rows;

        for (const row of ascentsRows) {
          ascentsMap.set(Number(row.hold_id), Number(row.user_ascents));
        }
        for (const row of attemptsRows) {
          attemptsMap.set(Number(row.hold_id), Number(row.user_attempts));
        }

        results = results.map(stat => ({
          ...stat,
          userAscents: ascentsMap.get(stat.holdId) || 0,
          userAttempts: attemptsMap.get(stat.holdId) || 0,
        }));
      }

      return results;
    } catch (error) {
      console.error('Error in holdHeatmap resolver:', error);
      throw error;
    }
  },
};
