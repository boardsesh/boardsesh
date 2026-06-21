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
 * Key format: ratelimit:{userId}:{operation}:{windowBucket}
 * where windowBucket = Math.floor(Date.now() / windowMs)
 */
export async function checkRateLimitRedis(
  userId: string,
  operation: string,
  maxRequests: number,
  windowMs: number,
): Promise<void> {
  // If Redis is not connected, fall back to in-memory
  if (!redisClientManager.isRedisConnected()) {
    // Fall back to in-memory rate limiter using a combined key
    checkRateLimit(`${userId}:${operation}`, maxRequests, windowMs);
    return;
  }

  try {
    const { publisher } = redisClientManager.getClients();
    const windowBucket = Math.floor(Date.now() / windowMs);
    const key = `ratelimit:${userId}:${operation}:${windowBucket}`;
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
    logger.warn('[RateLimit] Redis unavailable, falling back to in-memory:', (err as Error).message);
    checkRateLimit(`${userId}:${operation}`, maxRequests, windowMs);
  }
}
