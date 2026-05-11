import { eq, asc, and, sql } from 'drizzle-orm';
import type { QueryResolvers } from '@boardsesh/shared-schema/generated';
import { executeRows } from '@boardsesh/db/client';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { validateInput } from '../shared/helpers';
import { BoardNameSchema } from '../../../validation/schemas';

export const boardQueries: Pick<QueryResolvers, 'grades' | 'angles'> = {
  grades: async (_, { boardName }) => {
    validateInput(BoardNameSchema, boardName, 'boardName');

    const grades = await db
      .select({
        difficultyId: dbSchema.boardDifficultyGrades.difficulty,
        name: dbSchema.boardDifficultyGrades.boulderName,
      })
      .from(dbSchema.boardDifficultyGrades)
      .where(
        and(eq(dbSchema.boardDifficultyGrades.boardType, boardName), eq(dbSchema.boardDifficultyGrades.isListed, true)),
      )
      .orderBy(asc(dbSchema.boardDifficultyGrades.difficulty));

    return grades.map((g) => ({
      difficultyId: g.difficultyId,
      name: g.name || '',
    }));
  },

  angles: async (_, { boardName, layoutId }) => {
    validateInput(BoardNameSchema, boardName, 'boardName');

    const result = await executeRows<{ angle: number }>(
      db,
      sql`
      SELECT DISTINCT pa.angle
      FROM board_products_angles pa
      JOIN board_layouts l
        ON l.board_type = pa.board_type AND l.product_id = pa.product_id
      WHERE l.board_type = ${boardName} AND l.id = ${layoutId}
      ORDER BY pa.angle ASC
    `,
    );

    return result.map((r) => ({ angle: r.angle }));
  },
};
