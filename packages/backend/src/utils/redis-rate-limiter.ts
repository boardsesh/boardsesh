import { redisClientManager } from '../redis/client';
import { checkRateLimit, RateLimitError } from './rate-limiter';
import { logger } from './logger';

/**
 * Lua script for atomic INCR + EXPIRE.
 * Prevents race condition where process crash between INCR and EXPIRE
 * would leave a key without TTL, persisting forever.
 *
 * KEYS[1] = rate limit key
 * ARGV[1] = expire time in seconds
 *
 * Returns the new count after increment.
 */
const RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`;

/**
 * Distributed rate limiter using an atomic Lua script (INCR + EXPIRE).
 * Falls back to in-memory rate limiter if Redis is unavailable.
 *
 * Key format: ratelimit:{identity}:{operation}:{windowBucket}
 * where windowBucket = Math.floor(Date.now() / windowMs)
 *
 * By default Redis failures use the local limiter. Callers that already ran a
 * local tier pass `fallbackToMemory: false` to avoid counting one request twice.
 */
export async function checkRateLimitRedis(
  identity: string,
  operation: string,
  maxRequests: number,
  windowMs: number,
  options: { fallbackToMemory?: boolean } = {},
): Promise<void> {
  const fallbackToMemory = options.fallbackToMemory ?? true;

  // If Redis is not connected, use the optional in-memory fallback.
  if (!redisClientManager.isRedisConnected()) {
    // Some callers already applied their own in-memory tier. They disable this
    // fallback so one request is not counted twice against the same bucket.
    if (fallbackToMemory) checkRateLimit(`${identity}:${operation}`, maxRequests, windowMs);
    return;
  }

  try {
    const { publisher } = redisClientManager.getClients();
    const windowBucket = Math.floor(Date.now() / windowMs);
    const key = `ratelimit:${identity}:${operation}:${windowBucket}`;
    const expireSeconds = Math.ceil(windowMs / 1000);

    // Atomic INCR + EXPIRE via Lua script
    const count = (await publisher.eval(RATE_LIMIT_SCRIPT, 1, key, expireSeconds.toString())) as number;

    if (count > maxRequests) {
      const retryAfterSeconds = Math.ceil((windowMs - (Date.now() % windowMs)) / 1000);
      throw new RateLimitError(retryAfterSeconds);
    }
  } catch (err) {
    // If the error is our rate limit error, re-throw it
    if (err instanceof RateLimitError) {
      throw err;
    }
    // Otherwise Redis failed — fall back to in-memory
    logger.warn(
      fallbackToMemory
        ? '[RateLimit] Redis unavailable, falling back to in-memory:'
        : '[RateLimit] Redis unavailable; caller in-memory tier remains active:',
      (err as Error).message,
    );
    if (fallbackToMemory) checkRateLimit(`${identity}:${operation}`, maxRequests, windowMs);
  }
}
