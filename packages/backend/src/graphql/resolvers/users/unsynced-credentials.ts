import { eq, and, isNull, count } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated } from '../shared/helpers';

export interface UnsyncedBoardCounts {
  ascents: number;
  climbs: number;
}

export interface UnsyncedCounts {
  kilter: UnsyncedBoardCounts;
  tension: UnsyncedBoardCounts;
}

export const unsyncedCredentialsQuery = {
  unsyncedAuroraCredentials: async (
    _: unknown,
    __: unknown,
    ctx: ConnectionContext,
  ): Promise<UnsyncedCounts> => {
    requireAuthenticated(ctx);
    const userId = ctx.userId!;

    // Get user's Aurora account user IDs from credentials
    const credentials = await db
      .select({
        boardType: dbSchema.auroraCredentials.boardType,
        auroraUserId: dbSchema.auroraCredentials.auroraUserId,
      })
      .from(dbSchema.auroraCredentials)
      .where(eq(dbSchema.auroraCredentials.userId, userId));

    const counts: UnsyncedCounts = {
      kilter: { ascents: 0, climbs: 0 },
      tension: { ascents: 0, climbs: 0 },
    };

    for (const cred of credentials) {
      if (!cred.auroraUserId) continue;

      const boardType = cred.boardType as 'kilter' | 'tension';
      if (boardType !== 'kilter' && boardType !== 'tension') continue;

      // Count unsynced ticks
      const [ascentResult] = await db
        .select({ count: count() })
        .from(dbSchema.boardseshTicks)
        .where(
          and(
            eq(dbSchema.boardseshTicks.userId, userId),
            eq(dbSchema.boardseshTicks.boardType, boardType),
            isNull(dbSchema.boardseshTicks.auroraId),
          ),
        );

      // Count unsynced climbs
      const [climbResult] = await db
        .select({ count: count() })
        .from(dbSchema.boardClimbs)
        .where(
          and(
            eq(dbSchema.boardClimbs.boardType, boardType),
            eq(dbSchema.boardClimbs.setterId, cred.auroraUserId),
            eq(dbSchema.boardClimbs.synced, false),
          ),
        );

      counts[boardType] = {
        ascents: Number(ascentResult?.count ?? 0),
        climbs: Number(climbResult?.count ?? 0),
      };
    }

    return counts;
  },
};
