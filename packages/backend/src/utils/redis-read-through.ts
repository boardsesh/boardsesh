import { redisClientManager } from '../redis/client';
import { logger } from './logger';
import { singleFlight } from './single-flight';

/**
 * A shared Redis read-through in front of one expensive, viewer-independent
 * read, with the miss collapsed to one in-flight copy per key per process.
 *
 * The same two properties `similar-climbs-cache.ts` documents: the cache decides
 * how OFTEN the statement runs, `singleFlight` decides how many copies run AT
 * ONCE — and the second is what keeps a cold window from emptying the pool
 * (`docs/db-connectivity.md`).
 *
 * Every Redis failure falls through to `load` instead of to an error: an
 * unreachable Redis must degrade to the uncached read, never take the caller
 * down. A failed `load` is not cached, and its rejection reaches every joined
 * caller, exactly as `singleFlight` does on its own.
 *
 * No process-local fallback: with no Redis, single-flight alone still collapses
 * the concurrent burst, which is the half that protects the pool.
 */
export async function readThroughRedis<Value>(options: {
  key: string;
  ttlSeconds: number;
  /** Log prefix, e.g. `BoardDiscovery`. */
  label: string;
  load: () => Promise<Value>;
}): Promise<Value> {
  const { key, ttlSeconds, label, load } = options;

  if (redisClientManager.isRedisConnected()) {
    try {
      const cached = await redisClientManager.getClients().publisher.get(key);
      if (cached !== null && cached !== undefined) return JSON.parse(cached) as Value;
    } catch (error) {
      logger.error(`[${label}] Redis read failed:`, error);
    }
  }

  return singleFlight(key, async () => {
    const loaded = await load();

    if (redisClientManager.isRedisConnected()) {
      try {
        await redisClientManager.getClients().publisher.set(key, JSON.stringify(loaded), 'EX', ttlSeconds);
      } catch (error) {
        logger.error(`[${label}] Redis write failed:`, error);
      }
    }

    return loaded;
  });
}
