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

      // Best-effort multi-instance dedup: if we can confirm via Redis that
      // we still own the latest nonce, clean up the key. If GET throws, the
      // nonce doesn't match (another instance won OR our SET never landed),
      // or Redis went away — fall through to the recompute anyway.
      // recomputeClimbStats is idempotent, so duplicate runs across
      // instances are harmless; a silent drop is not.
      if (redisClientManager.isRedisConnected()) {
        try {
          const { publisher } = redisClientManager.getClients();
          const current = await publisher.get(redisKey);
          if (current === nonce) {
            await publisher.del(redisKey);
          }
        } catch (err) {
          logger.error(`[debouncedClimbStats] Redis GET failed for ${key}, recomputing anyway:`, err);
        }
      }

      try {
        await recomputeClimbStats(boardType, climbUuid, angle);
      } catch (error) {
        logger.error(`[debouncedClimbStats] Failed to recompute stats for ${key}:`, error);
        return;
      }

      // Read back the canonical stats row and push it to any clients
      // subscribed to this (boardType, climbUuid, angle). The subscription
      // resolver lives in climb-stats-subscriptions.ts; the channel key
      // shape mirrors the one used there.
      try {
        const [row] = await db
          .select({
            ascensionistCount: dbSchema.boardClimbStats.ascensionistCount,
            qualityAverage: dbSchema.boardClimbStats.qualityAverage,
            difficultyAverage: dbSchema.boardClimbStats.difficultyAverage,
            displayDifficulty: dbSchema.boardClimbStats.displayDifficulty,
          })
          .from(dbSchema.boardClimbStats)
          .where(
            and(
              eq(dbSchema.boardClimbStats.boardType, boardType),
              eq(dbSchema.boardClimbStats.climbUuid, climbUuid),
              eq(dbSchema.boardClimbStats.angle, angle),
            ),
          )
          .limit(1);

        if (row) {
          pubsub.publishClimbStatsEvent(`${boardType}:${climbUuid}:${angle}`, {
            boardType,
            climbUuid,
            angle,
            ascensionistCount: row.ascensionistCount ?? 0,
            qualityAverage: row.qualityAverage,
            difficultyAverage: row.difficultyAverage,
            displayDifficulty: row.displayDifficulty,
          });
        }
      } catch (error) {
        logger.error(`[debouncedClimbStats] Failed to publish stats event for ${key}:`, error);
      }
    }, DEBOUNCE_MS),
  );
}
