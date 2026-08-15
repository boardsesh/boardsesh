import { redisClientManager } from '../../../redis/client';
import { logger } from '../../../utils/logger';

/**
 * Best-effort TTL cache for standings pages.
 *
 * Measured against production (global, rolling 30 days, ~1,200 climbers):
 * **~95 ms server-side warm, but ~1.25 s cold.** The ranking walks three CTE
 * layers — first-send-per-climb, a per-day ROW_NUMBER cap, then a grouped
 * aggregate with three window functions — so the pages it touches are large
 * enough that an evicted or post-deploy cache costs an order of magnitude more
 * than the steady state. That cold path is what a climber would meet after a
 * deploy, which is exactly when nobody wants to wait.
 *
 * A ranking is inherently stale-tolerant: nobody is harmed by a leaderboard
 * that is up to a minute old, and the rolling window means the numbers move
 * gradually anyway.
 *
 * Deliberately mirrors `board-presence/stats.ts`: best-effort GET returning
 * null on error or when Redis is off, fire-and-forget SET. If Redis is down the
 * feature degrades to "always compute" rather than failing — a leaderboard is
 * not worth a 500.
 */
const STANDINGS_CACHE_PREFIX = 'boardsesh:standings:v1:';
const STANDINGS_CACHE_TTL_SECONDS = 60;

/**
 * The cache key must capture everything that changes the response, or one
 * climber's page gets served to another.
 *
 * `viewerId` is part of the key because the payload carries viewer-specific
 * fields — `isViewer` per row, the viewer block, and (critically) the viewer's
 * own real name and id on a row that is anonymised for everybody else. Sharing
 * one entry across viewers would leak exactly what the anonymity setting
 * exists to withhold.
 */
export function standingsCacheKey(parts: {
  scopeId: string;
  window: string;
  limit: number;
  offset: number;
  viewerId: string | null;
}): string {
  return `${STANDINGS_CACHE_PREFIX}${parts.scopeId}:${parts.window}:${parts.limit}:${parts.offset}:${parts.viewerId ?? 'anon'}`;
}

export async function getCachedStandings<T>(key: string): Promise<T | null> {
  if (!redisClientManager.isRedisConnected()) return null;
  try {
    const { publisher } = redisClientManager.getClients();
    const raw = await publisher.get(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch (error) {
    logger.error('[standings] cache read failed:', error);
    return null;
  }
}

/** Fire-and-forget; never blocks or throws for the caller. */
export function setCachedStandings(key: string, payload: unknown): void {
  if (!redisClientManager.isRedisConnected()) return;
  try {
    const { publisher } = redisClientManager.getClients();
    publisher.set(key, JSON.stringify(payload), 'EX', STANDINGS_CACHE_TTL_SECONDS).catch((error: unknown) => {
      logger.error('[standings] cache write failed:', error);
    });
  } catch (error) {
    logger.error('[standings] cache write threw:', error);
  }
}
