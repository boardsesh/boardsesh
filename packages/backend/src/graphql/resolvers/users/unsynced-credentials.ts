import { eq, and, isNull, count, sql } from 'drizzle-orm';
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

    // Get user's Aurora credentials
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

    const validCreds = credentials.filter(
      (c): c is typeof c & { auroraUserId: number; boardType: 'kilter' | 'tension' } =>
        c.auroraUserId !== null && (c.boardType === 'kilter' || c.boardType === 'tension'),
    );

    if (validCreds.length === 0) return counts;

    // Single query for unsynced ascents grouped by board type
    const boardTypes = validCreds.map((c) => c.boardType);
    const ascentCounts = await db
      .select({
        boardType: dbSchema.boardseshTicks.boardType,
        count: count(),
      })
      .from(dbSchema.boardseshTicks)
      .where(
        and(
          eq(dbSchema.boardseshTicks.userId, userId),
          sql`${dbSchema.boardseshTicks.boardType} IN (${sql.join(boardTypes.map((t) => sql`${t}`), sql`, `)})`,
          isNull(dbSchema.boardseshTicks.auroraId),
        ),
      )
      .groupBy(dbSchema.boardseshTicks.boardType);

    for (const row of ascentCounts) {
      const bt = row.boardType as 'kilter' | 'tension';
      if (bt === 'kilter' || bt === 'tension') {
        counts[bt].ascents = Number(row.count);
      }
    }

    // Single query for unsynced climbs grouped by board type
    const setterConditions = validCreds.map(
      (c) => sql`(${dbSchema.boardClimbs.boardType} = ${c.boardType} AND ${dbSchema.boardClimbs.setterId} = ${c.auroraUserId})`,
    );
    const climbCounts = await db
      .select({
        boardType: dbSchema.boardClimbs.boardType,
        count: count(),
      })
      .from(dbSchema.boardClimbs)
      .where(
        and(
          sql`(${sql.join(setterConditions, sql` OR `)})`,
          eq(dbSchema.boardClimbs.synced, false),
        ),
      )
      .groupBy(dbSchema.boardClimbs.boardType);

    for (const row of climbCounts) {
      const bt = row.boardType as 'kilter' | 'tension';
      if (bt === 'kilter' || bt === 'tension') {
        counts[bt].climbs = Number(row.count);
      }
    }

    return counts;
  },
};
