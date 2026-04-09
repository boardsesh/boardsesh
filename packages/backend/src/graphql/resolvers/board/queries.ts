import { eq, asc, and, sql } from 'drizzle-orm';

import { createRequestDb } from '@boardsesh/db/client';

const db = createRequestDb();
import type { Grade, Angle } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { validateInput } from '../shared/helpers';
import { BoardNameSchema } from '../../../validation/schemas';

export const boardQueries = {
  /**
   * Get difficulty grades for a specific board type
   */
  grades: async (_: unknown, { boardName }: { boardName: string }): Promise<Grade[]> => {
    validateInput(BoardNameSchema, boardName, 'boardName');

    // Use unified table with board_type filter
    const grades = await db
      .select({
        difficultyId: dbSchema.boardDifficultyGrades.difficulty,
        name: dbSchema.boardDifficultyGrades.boulderName,
      })
      .from(dbSchema.boardDifficultyGrades)
      .where(
        and(
          eq(dbSchema.boardDifficultyGrades.boardType, boardName),
          eq(dbSchema.boardDifficultyGrades.isListed, true),
        ),
      )
      .orderBy(asc(dbSchema.boardDifficultyGrades.difficulty));

    return grades.map(g => ({
      difficultyId: g.difficultyId,
      name: g.name || '',
    }));
  },

  /**
   * Get available angles for a specific board layout
   */
  angles: async (_: unknown, { boardName, layoutId }: { boardName: string; layoutId: number }): Promise<Angle[]> => {
    validateInput(BoardNameSchema, boardName, 'boardName');

    // Use raw SQL with unified tables
    // This query joins layouts to products to get available angles for a layout
    const result = await db.execute<{ angle: number }>(sql`
      SELECT DISTINCT pa.angle
      FROM board_products_angles pa
      JOIN board_layouts l
        ON l.board_type = pa.board_type AND l.product_id = pa.product_id
      WHERE l.board_type = ${boardName} AND l.id = ${layoutId}
      ORDER BY pa.angle ASC
    `);

    // Handle both possible return types from execute
    const rows = Array.isArray(result) ? result : (result as { rows: { angle: number }[] }).rows;
    return rows.map(r => ({ angle: r.angle }));
  },
};
