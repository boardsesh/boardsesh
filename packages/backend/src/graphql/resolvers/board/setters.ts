import { eq, sql, and, ilike } from 'drizzle-orm';
import { db } from '../../../db/client';
import { UNIFIED_TABLES, isValidBoardName, type BoardName } from '../../../db/queries/util/table-select';
import { getSizeEdges } from '../../../db/queries/util/product-sizes-data';
import { validateInput } from '../shared/helpers';
import { BoardNameSchema } from '../../../validation/schemas';

export interface SetterInput {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  search?: string;
}

export interface SetterStat {
  setterUsername: string;
  climbCount: number;
}

export const settersQuery = {
  setters: async (
    _: unknown,
    { input }: { input: SetterInput },
  ): Promise<SetterStat[]> => {
    validateInput(BoardNameSchema, input.boardName, 'boardName');

    if (!isValidBoardName(input.boardName)) {
      throw new Error(`Invalid board name: ${input.boardName}`);
    }

    const boardName = input.boardName as BoardName;

    // MoonBoard doesn't have setter stats
    if (boardName === 'moonboard') {
      return [];
    }

    const sizeEdges = getSizeEdges(boardName, input.sizeId);
    if (!sizeEdges) {
      return [];
    }

    const { climbs, climbStats } = UNIFIED_TABLES;

    try {
      const whereConditions = [
        eq(climbs.boardType, boardName),
        eq(climbs.layoutId, input.layoutId),
        eq(climbStats.angle, input.angle),
        sql`${climbs.edgeLeft} > ${sizeEdges.edgeLeft}`,
        sql`${climbs.edgeRight} < ${sizeEdges.edgeRight}`,
        sql`${climbs.edgeBottom} > ${sizeEdges.edgeBottom}`,
        sql`${climbs.edgeTop} < ${sizeEdges.edgeTop}`,
        sql`${climbs.setterUsername} IS NOT NULL`,
        sql`${climbs.setterUsername} != ''`,
      ];

      if (input.search && input.search.trim().length > 0) {
        whereConditions.push(ilike(climbs.setterUsername, `%${input.search}%`));
      }

      const result = await db
        .select({
          setterUsername: climbs.setterUsername,
          climbCount: sql<number>`count(*)::int`,
        })
        .from(climbs)
        .innerJoin(
          climbStats,
          and(
            eq(climbStats.climbUuid, climbs.uuid),
            eq(climbStats.boardType, boardName),
          ),
        )
        .where(and(...whereConditions))
        .groupBy(climbs.setterUsername)
        .orderBy(sql`count(*) DESC`)
        .limit(50);

      return result
        .filter((stat): stat is typeof stat & { setterUsername: string } => stat.setterUsername !== null)
        .map(stat => ({
          setterUsername: stat.setterUsername,
          climbCount: stat.climbCount,
        }));
    } catch (error) {
      console.error('Error in setters resolver:', error);
      throw error;
    }
  },
};
