import { eq } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, validateInput } from '../shared/helpers';
import { BoardNameSchema } from '../../../validation/schemas';

interface UserBoardMapping {
  id: string;
  userId: string;
  boardType: string;
  boardUserId: number;
  boardUsername: string | null;
  linkedAt: string;
}

export const boardMappingsQuery = {
  userBoardMappings: async (
    _: unknown,
    __: unknown,
    ctx: ConnectionContext,
  ): Promise<UserBoardMapping[]> => {
    requireAuthenticated(ctx);
    const userId = ctx.userId!;

    const results = await db
      .select()
      .from(dbSchema.userBoardMappings)
      .where(eq(dbSchema.userBoardMappings.userId, userId));

    return results.map(row => ({
      id: row.id.toString(),
      userId: row.userId,
      boardType: row.boardType,
      boardUserId: row.boardUserId,
      boardUsername: row.boardUsername,
      linkedAt: row.linkedAt.toISOString(),
    }));
  },
};

export const boardMappingsMutation = {
  saveUserBoardMapping: async (
    _: unknown,
    { boardType, boardUserId, boardUsername }: {
      boardType: string;
      boardUserId: number;
      boardUsername?: string;
    },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    requireAuthenticated(ctx);
    validateInput(BoardNameSchema, boardType, 'boardType');

    const userId = ctx.userId!;

    if (!Number.isInteger(boardUserId) || boardUserId <= 0) {
      throw new Error('boardUserId must be a positive integer');
    }

    await db
      .insert(dbSchema.userBoardMappings)
      .values({
        userId,
        boardType,
        boardUserId,
        boardUsername: boardUsername || null,
      })
      .onConflictDoUpdate({
        target: [dbSchema.userBoardMappings.userId, dbSchema.userBoardMappings.boardType],
        set: {
          boardUserId,
          boardUsername: boardUsername || null,
          linkedAt: new Date(),
        },
      });

    return true;
  },
};
