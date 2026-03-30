import { eq, and, inArray, isNotNull, desc } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, validateInput } from '../shared/helpers';
import { BoardNameSchema } from '../../../validation/schemas';

export const auroraGetLogbookQuery = {
  auroraGetLogbook: async (
    _: unknown,
    { boardName, userId, climbUuids }: {
      boardName: string;
      userId: string;
      climbUuids?: string[];
    },
    ctx: ConnectionContext,
  ): Promise<unknown> => {
    requireAuthenticated(ctx);
    validateInput(BoardNameSchema, boardName, 'boardName');

    if (boardName === 'moonboard') {
      throw new Error('MoonBoard does not support this endpoint');
    }

    // Use the authenticated user's ID for lookups
    const nextAuthUserId = ctx.userId!;

    const baseConditions = [
      eq(dbSchema.boardseshTicks.boardType, boardName),
      eq(dbSchema.boardseshTicks.userId, nextAuthUserId),
    ];

    if (climbUuids && climbUuids.length > 0) {
      baseConditions.push(inArray(dbSchema.boardseshTicks.climbUuid, climbUuids));
    } else {
      baseConditions.push(isNotNull(dbSchema.boardseshTicks.difficulty));
    }

    const results = await db
      .select()
      .from(dbSchema.boardseshTicks)
      .where(and(...baseConditions))
      .orderBy(desc(dbSchema.boardseshTicks.climbedAt));

    // Transform to logbook entry format
    return results.map(tick => ({
      uuid: tick.uuid,
      wall_uuid: null,
      climb_uuid: tick.climbUuid,
      angle: tick.angle,
      is_mirror: tick.isMirror ?? false,
      user_id: 0,
      attempt_id: tick.status === 'flash' ? 1 : tick.status === 'send' ? 2 : 0,
      tries: tick.attemptCount,
      quality: tick.quality ?? 0,
      difficulty: tick.difficulty ?? 0,
      is_benchmark: tick.isBenchmark ?? false,
      is_listed: true,
      comment: tick.comment ?? '',
      climbed_at: tick.climbedAt,
      created_at: tick.createdAt,
      updated_at: tick.updatedAt,
      is_ascent: tick.status === 'flash' || tick.status === 'send',
    }));
  },
};
