import { count, sql } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { gymActivityStats } from '@boardsesh/db/schema';
import {
  GYM_ACTIVITY_REFRESH_LOCK_KEY,
  countGymsWithActivity,
  rebuildGymActivityStats,
  type GymActivityRefreshSkipReason,
} from '@boardsesh/db/queries';
import { db } from '../../../db/client';
import { logger } from '../../../utils/logger';

export const gymActivityStatsMutations = {
  refreshGymActivityStats: async (
    _: unknown,
    { force = false }: { force?: boolean | null },
    ctx: ConnectionContext,
  ) => {
    if (ctx.transport !== 'http' || !ctx.isCronAuthenticated) {
      throw new GraphQLError('Cron authentication required', {
        extensions: { code: 'UNAUTHENTICATED', http: { status: 401 } },
      });
    }

    const forced = force === true;
    const startedAt = Date.now();
    let scanDurationMs = 0;
    let writeDurationMs = 0;
    let previousGymCount: number | null = null;
    let gymCount: number | null = null;
    let skipped: GymActivityRefreshSkipReason | null = null;

    const decline = (reason: GymActivityRefreshSkipReason, message: string): never => {
      skipped = reason;
      throw new GraphQLError(message, {
        extensions: {
          code: 'CONFLICT',
          http: { status: 409 },
          skipped,
          gymCount,
          previousGymCount,
          forced,
          scanDurationMs,
          writeDurationMs,
        },
      });
    };

    try {
      const refreshed = await db.transaction(
        async (tx) => {
          // Serialize guard reads with other refreshes. A repeatable snapshot also
          // keeps board visibility changes between the count and rebuild from
          // bypassing the shrink guard.
          const lockRows = await tx.execute<{ locked: boolean }>(
            sql`SELECT pg_try_advisory_xact_lock(${GYM_ACTIVITY_REFRESH_LOCK_KEY}) AS locked`,
          );
          if (!lockRows[0]?.locked) decline('locked', 'another gym activity stats refresh is already running');

          const scanStartedAt = Date.now();
          const [previousRow] = await tx.select({ gymCount: count() }).from(gymActivityStats);
          previousGymCount = previousRow?.gymCount ?? 0;
          gymCount = await countGymsWithActivity(tx);
          scanDurationMs = Date.now() - scanStartedAt;

          if (gymCount === 0) decline('empty', 'the refresh found 0 gyms with activity; refusing to empty the cache');
          if (!forced && gymCount * 2 < previousGymCount) {
            decline('shrank', 'the refresh found over 50% fewer gyms; retry with force: true if the drop is real');
          }

          const writeStartedAt = Date.now();
          try {
            gymCount = await rebuildGymActivityStats(tx);
          } finally {
            writeDurationMs = Date.now() - writeStartedAt;
          }
          return { gymCount, previousGymCount };
        },
        { isolationLevel: 'repeatable read' },
      );

      return {
        ...refreshed,
        forced,
        scanDurationMs,
        writeDurationMs,
        durationMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof GraphQLError) throw error;
      logger.error('Gym activity stats refresh failed', error);
      throw new GraphQLError('Gym activity stats refresh failed', {
        extensions: { code: 'INTERNAL_SERVER_ERROR', http: { status: 500 } },
      });
    } finally {
      logger.info('Gym activity stats refresh finished', {
        gymCount,
        previousGymCount,
        forced,
        skipped,
        scanDurationMs,
        writeDurationMs,
        durationMs: Date.now() - startedAt,
      });
    }
  },
};
