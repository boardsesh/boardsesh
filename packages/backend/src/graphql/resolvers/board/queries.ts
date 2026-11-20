import { eq, asc, and, isNotNull } from 'drizzle-orm';
import type { QueryResolvers } from '@boardsesh/shared-schema/generated';
import { ANGLES } from '@boardsesh/board-config';
import { quantumCatalogClimbCondition } from '@boardsesh/db/queries';
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
    const validatedBoardName = validateInput(BoardNameSchema, boardName, 'boardName');

    // Quantum's supported angles are catalogue data rather than a fixed
    // manufacturer-wide table. Return only angles present in the last signed,
    // successfully imported snapshot; an empty catalogue truthfully yields [].
    if (validatedBoardName === 'quantum') {
      return getQuantumCatalogAngles(layoutId);
    }

    // Aurora doesn't sync a per-layout angle table (deliberately excluded —
    // see packages/aurora-sync/src/sync/shared-sync.ts). Every layout for a
    // given board type supports the same fixed angle range, hardcoded in
    // ANGLES (packages/shared/board-config/src/board-data.ts). The `layoutId`
    // argument is kept for API compatibility but doesn't affect the result.
    return ANGLES[validatedBoardName].map((angle) => ({ angle }));
  },
};

/** Angles represented by signed-catalog routes, excluding Boardsesh-authored rows. */
export async function getQuantumCatalogAngles(layoutId: number): Promise<Array<{ angle: number }>> {
  const rows = await db
    .selectDistinct({ angle: dbSchema.boardClimbs.angle })
    .from(dbSchema.boardClimbs)
    .where(
      and(
        quantumCatalogClimbCondition(),
        eq(dbSchema.boardClimbs.layoutId, layoutId),
        eq(dbSchema.boardClimbs.isListed, true),
        isNotNull(dbSchema.boardClimbs.angle),
      ),
    )
    .orderBy(asc(dbSchema.boardClimbs.angle));
  return rows.filter((row): row is { angle: number } => row.angle !== null);
}
