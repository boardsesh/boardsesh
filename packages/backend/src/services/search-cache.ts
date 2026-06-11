import { createHash } from 'crypto';
import { redisClientManager } from '../redis/client';
import type { ClimbSearchParams, ParsedBoardRouteParameters } from '../db/queries/climbs/index';
import { logger } from '../utils/logger';

/** Default TTL for cached search results: 24 hours. */
export const DEFAULT_SEARCH_CACHE_TTL = 86400;

/**
 * Bump when a code change alters search result *content* for an existing key.
 * v3: anchored hold LIKE (`%p<id>r%`), minRating compared on the 1-5 scale,
 * popular-sort counting NULL frames_count, name ILIKE escaping, zone fail-closed.
 */
const CACHE_VERSION = 'v3';

/**
 * Recursively sorts the keys of an object so that JSON.stringify produces
 * a deterministic string regardless of insertion order.
 */
function sortKeysRecursively(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysRecursively);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysRecursively((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Redis-based cache for climb search queries.
 *
 * All cache operations are best-effort: a Redis miss or error never blocks
 * the caller. `setCachedResult` is fire-and-forget.
 */
export class SearchCacheService {
  /**
   * Builds a deterministic Redis cache key from route parameters and search
   * params. The trailing hash encodes all non-undefined search params so that
   * any change to the query produces a different key.
   *
   * Format:
   *   `boardsesh:climb-search:{suffix}:{board}:{layout}:{size}:{sets}:{angle}:{paramsHash}`
   */
  buildCacheKey(params: ParsedBoardRouteParameters, searchParams: ClimbSearchParams, suffix: string): string {
    // Filter out undefined values before hashing for a stable representation.
    const defined: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(searchParams)) {
      if (v !== undefined) {
        defined[k] = v;
      }
    }

    const sorted = sortKeysRecursively(defined);
    const paramsHash = createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 16);

    const setsPart = [...params.set_ids].sort((a, b) => a - b).join(',');

    return [
      'boardsesh:climb-search',
      CACHE_VERSION,
      suffix,
      params.board_name,
      params.layout_id,
      params.size_id,
      setsPart,
      params.angle,
      paramsHash,
    ].join(':');
  }

  /**
   * Retrieves and deserialises a cached value. Returns `null` on a cache miss
   * or if Redis is unavailable / returns an error.
   */
  async getCachedResult<T>(key: string): Promise<T | null> {
    if (!redisClientManager.isRedisConnected()) {
      return null;
    }

    try {
      const { publisher } = redisClientManager.getClients();
      const raw = await publisher.get(key);
      if (raw === null) {
        return null;
      }
      return JSON.parse(raw) as T;
    } catch (error) {
      logger.error('[SearchCache] Error reading cache key', key, error);
      return null;
    }
  }

  /**
   * Serialises `data` and stores it under `key` with the given TTL (seconds).
   * This is fire-and-forget: the returned promise is intentionally not awaited
   * and errors are swallowed so that cache writes never affect the caller.
   */
  setCachedResult(key: string, data: unknown, ttlSeconds = DEFAULT_SEARCH_CACHE_TTL): void {
    if (!redisClientManager.isRedisConnected()) {
      return;
    }

    try {
      const { publisher } = redisClientManager.getClients();
      publisher.set(key, JSON.stringify(data), 'EX', ttlSeconds).catch((error: unknown) => {
        logger.error('[SearchCache] Error writing cache key', key, error);
      });
    } catch (error) {
      logger.error('[SearchCache] Error initiating cache write for key', key, error);
    }
  }
}

/** Singleton instance used across the backend. */
export const searchCache = new SearchCacheService();
