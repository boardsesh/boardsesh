import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { pubsub } from '../../../pubsub/index';
import { redisClientManager } from '../../../redis/client';
import { logger } from '../../../utils/logger';
import { recomputeClimbStats } from './recompute-climb-stats';

const DEBOUNCE_MS = 2000;
const REDIS_KEY_PREFIX = 'boardsesh:debounce:climb-stats:';

/**
 * Local timers used to schedule the recompute after the debounce window.
 * In multi-instance deployments the Redis key decides which instance
 * actually runs the recompute — the timer just provides the delay.
 *
 * Keyed by `${boardType}|${climbUuid}|${angle}`.
 */
const pending = new Map<string, ReturnType<typeof setTimeout>>();

function buildKey(boardType: string, climbUuid: string, angle: number): string {
  return `${boardType}|${climbUuid}|${angle}`;
}

/**
 * Debounced wrapper around recomputeClimbStats.
 *
 * Bursts of tick saves on the same climb collapse into a single recompute
 * within a 2s window. Mirrors the design of publishDebouncedSessionStats
 * (sessions/debounced-stats-publisher.ts) — local timer + Redis nonce so
 * only the instance that received the *last* tick runs the recompute when
 * scaled horizontally.
 *
 * Falls back to local-only debounce when Redis is not available.
 */
export function queueClimbStatsRecompute(boardType: string, climbUuid: string, angle: number): void {
  const key = buildKey(boardType, climbUuid, angle);
  const existing = pending.get(key);
  if (existing) {
    clearTimeout(existing);
  }

  const nonce = randomUUID();
  const redisKey = `${REDIS_KEY_PREFIX}${key}`;

  if (redisClientManager.isRedisConnected()) {
    const { publisher } = redisClientManager.getClients();
    publisher.set(redisKey, nonce, 'PX', DEBOUNCE_MS + 500).catch((err) => {
      logger.error(`[debouncedClimbStats] Redis SET failed for ${key}:`, err);
    });
  }

  pending.set(
    key,
    setTimeout(async () => {
      pending.delete(key);

      // Multi-instance dedup gate. The instance that holds the latest
      // nonce in Redis owns this debounce window — only it runs the
      // recompute *and* the publish. Earlier versions only used the nonce
      // to delete the key and fell through to recompute unconditionally,
      // which produced 3× publishes (and 3× UI flickers) across a 3-node
      // cluster even though the DB update was idempotent.
      //
      // If Redis isn't connected we run unconditionally — single-instance
      // mode where there's no one to coordinate with.
      // If Redis is reachable but the GET errors, we also fall through
      // (silent drops would be worse than a duplicate publish).
      if (redisClientManager.isRedisConnected()) {
        try {
          const { publisher } = redisClientManager.getClients();
          const current = await publisher.get(redisKey);
          if (current !== nonce) {
            // Another instance owns this window — exit and let them publish.
            return;
          }
          await publisher.del(redisKey);
        } catch (err) {
          logger.error(`[debouncedClimbStats] Redis GET failed for ${key}, falling through:`, err);
        }
      }

      try {
        await recomputeClimbStats(boardType, climbUuid, angle);
      } catch (error) {
        logger.error(`[debouncedClimbStats] Failed to recompute stats for ${key}:`, error);
        return;
      }

      // Read back the canonical stats row joined with the climb's layout
      // so we can publish on the layout-scoped channel. Subscribers are
      // page-level (one per board layout), so the routed payload still
      // carries climbUuid + angle for cache routing on the client.
      try {
        const [row] = await db
          .select({
            ascensionistCount: dbSchema.boardClimbStats.ascensionistCount,
            qualityAverage: dbSchema.boardClimbStats.qualityAverage,
            difficultyAverage: dbSchema.boardClimbStats.difficultyAverage,
            displayDifficulty: dbSchema.boardClimbStats.displayDifficulty,
            layoutId: dbSchema.boardClimbs.layoutId,
          })
          .from(dbSchema.boardClimbStats)
          .leftJoin(
            dbSchema.boardClimbs,
            and(
              eq(dbSchema.boardClimbs.boardType, dbSchema.boardClimbStats.boardType),
              eq(dbSchema.boardClimbs.uuid, dbSchema.boardClimbStats.climbUuid),
            ),
          )
          .where(
            and(
              eq(dbSchema.boardClimbStats.boardType, boardType),
              eq(dbSchema.boardClimbStats.climbUuid, climbUuid),
              eq(dbSchema.boardClimbStats.angle, angle),
            ),
          )
          .limit(1);

        if (!row) {
          // Stats row missing — recompute insert should have seeded it,
          // but defensively bail rather than publish on a bogus channel.
          return;
        }
        if (row.layoutId == null) {
          // Stats arrived before the board_climbs row (possible during a
          // mid-Aurora-sync race). Subscribers will pick up the canonical
          // values on the next render after sync completes.
          logger.debug(`[debouncedClimbStats] No layout for ${key}; skipping publish`);
          return;
        }

        pubsub.publishClimbStatsEvent(`${boardType}:${row.layoutId}`, {
          boardType,
          climbUuid,
          angle,
          ascensionistCount: row.ascensionistCount ?? 0,
          qualityAverage: row.qualityAverage,
          difficultyAverage: row.difficultyAverage,
          displayDifficulty: row.displayDifficulty,
        });
      } catch (error) {
        logger.error(`[debouncedClimbStats] Failed to publish stats event for ${key}:`, error);
      }
    }, DEBOUNCE_MS),
  );
}
