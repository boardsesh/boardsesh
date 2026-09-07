import { randomUUID } from 'crypto';
import { and, eq, sql } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { getGradeLabel } from '@boardsesh/db/queries';
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
 * Runs the recompute inline for one (boardType, climbUuid, angle) before the
 * mutation returns: clients invalidate their climb lists as soon as saveTick
 * resolves, so a refetch would otherwise race the 2 s debounce and read an
 * ungraded or missing row (#4798). One short PK-keyed transaction, idempotent,
 * so the debounced pass still runs for coalescing and the canonical
 * `climbStatsUpdated` publish. Never rejects: stats must not fail the tick.
 */
export async function recomputeClimbStatsNow(boardType: string, climbUuid: string, angle: number): Promise<void> {
  const key = buildKey(boardType, climbUuid, angle);
  try {
    await recomputeClimbStats(boardType, climbUuid, angle);
  } catch (error) {
    logger.error(`[climbStatsNow] inline recompute failed for ${key}:`, error);
  }
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

  logger.info(`[debouncedClimbStats] queued ${key}`);

  pending.set(
    key,
    setTimeout(async () => {
      pending.delete(key);
      logger.info(`[debouncedClimbStats] firing ${key}`);

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

      // Read the COMPLETE canonical row from the primary. The mutation and
      // recompute have just committed, so a replica read here could publish an
      // older count/revision and prematurely erase the optimistic floor.
      // Duplicate recomputes are deliberately allowed by the fail-open Redis
      // gate above; unchanged rows retain sync_seq and clients reject duplicate
      // revisions with BigInt comparison.
      try {
        const [row] = await db
          .select({
            layoutId: dbSchema.boardClimbs.layoutId,
            ascensionistCount: dbSchema.boardClimbStats.ascensionistCount,
            qualityAverage: dbSchema.boardClimbStats.qualityAverage,
            difficultyAverage: dbSchema.boardClimbStats.difficultyAverage,
            displayDifficulty: dbSchema.boardClimbStats.displayDifficulty,
            faUsername: dbSchema.boardClimbStats.faUsername,
            faAt: dbSchema.boardClimbStats.faAt,
            // Preserve the bigint exactly across the JS boundary.
            syncSeq: sql<string>`${dbSchema.boardClimbStats.syncSeq}::text`,
          })
          .from(dbSchema.boardClimbStats)
          .innerJoin(
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
          logger.debug(`[debouncedClimbStats] No canonical row/layout for ${key}; skipping publish`);
          return;
        }
        const difficulty = row.displayDifficulty == null ? null : getGradeLabel(Math.round(row.displayDifficulty));
        pubsub.publishClimbStatsEvent(`${boardType}:${row.layoutId}`, {
          boardType,
          layoutId: row.layoutId,
          climbUuid,
          angle,
          ascensionistCount: row.ascensionistCount ?? 0,
          qualityAverage: row.qualityAverage,
          difficultyAverage: row.difficultyAverage,
          displayDifficulty: row.displayDifficulty,
          difficulty,
          faUsername: row.faUsername,
          faAt: row.faAt,
          syncSeq: row.syncSeq,
        });
      } catch (error) {
        // Recompute remains successful if event enrichment/fan-out fails. The
        // client refreshes retained keys on subscription errors/reconnects.
        logger.error(`[debouncedClimbStats] Failed to publish canonical stats for ${key}:`, error);
      }
    }, DEBOUNCE_MS),
  );
}
