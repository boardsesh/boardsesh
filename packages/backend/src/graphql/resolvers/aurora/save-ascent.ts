import { randomUUID } from 'crypto';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, validateInput } from '../shared/helpers';
import { BoardNameSchema } from '../../../validation/schemas';
import dayjs from 'dayjs';

export interface SaveAscentInput {
  token: string;
  uuid: string;
  userId: number;
  climbUuid: string;
  angle: number;
  isMirror: boolean;
  attemptId: number;
  bidCount: number;
  quality: number;
  difficulty: number;
  isBenchmark: boolean;
  comment: string;
  climbedAt: string;
}

export interface SaveAscentResult {
  success: boolean;
}

export const auroraSaveAscentMutation = {
  auroraSaveAscent: async (
    _: unknown,
    { boardName, input }: { boardName: string; input: SaveAscentInput },
    ctx: ConnectionContext,
  ): Promise<SaveAscentResult> => {
    requireAuthenticated(ctx);
    validateInput(BoardNameSchema, boardName, 'boardName');

    if (boardName === 'moonboard') {
      throw new Error('MoonBoard does not support this endpoint');
    }

    const nextAuthUserId = ctx.userId!;

    // Convert the ISO date to the required format
    const formattedDate = dayjs(input.climbedAt).format('YYYY-MM-DD HH:mm:ss');
    const now = new Date().toISOString();

    // Determine status
    const status = input.attemptId === 1 ? 'flash' : 'send';
    const tickUuid = randomUUID();

    await db
      .insert(dbSchema.boardseshTicks)
      .values({
        uuid: tickUuid,
        userId: nextAuthUserId,
        boardType: boardName,
        climbUuid: input.climbUuid,
        angle: input.angle,
        isMirror: input.isMirror,
        status,
        attemptCount: input.bidCount,
        quality: input.quality,
        difficulty: input.difficulty,
        isBenchmark: input.isBenchmark,
        comment: input.comment || '',
        climbedAt: formattedDate,
        createdAt: now,
        updatedAt: now,
        auroraType: 'ascents',
        auroraId: input.uuid,
      })
      .onConflictDoUpdate({
        target: dbSchema.boardseshTicks.auroraId,
        set: {
          climbUuid: input.climbUuid,
          angle: input.angle,
          isMirror: input.isMirror,
          status,
          attemptCount: input.bidCount,
          quality: input.quality,
          difficulty: input.difficulty,
          isBenchmark: input.isBenchmark,
          comment: input.comment || '',
          climbedAt: formattedDate,
          updatedAt: now,
        },
      });

    return { success: true };
  },
};
