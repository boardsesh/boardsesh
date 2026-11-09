import { redisClientManager } from '../redis/client';
import { checkRateLimit, incrementRateLimit, peekRateLimit, RateLimitError } from './rate-limiter';
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

export interface RateLimitUsage {
  limit: number;
  remaining: number;
  resetSeconds: number;
}

/** A paused Redis would otherwise hold the request until the socket gives up. */
const REDIS_DEADLINE_MS = 100;

function withRedisDeadline<Result>(command: Promise<Result>): Promise<Result> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(() => reject(new Error('Redis did not answer in time')), REDIS_DEADLINE_MS);
    deadline.unref();
  });
  return Promise.race([command, timedOut]).finally(() => clearTimeout(deadline));
}

function rateLimitKey(identity: string, operation: string, windowMs: number): string {
  return `ratelimit:${identity}:${operation}:${Math.floor(Date.now() / windowMs)}`;
}

function secondsUntilWindowEnds(windowMs: number): number {
  return Math.ceil((windowMs - (Date.now() % windowMs)) / 1000);
}

function usageFrom(maxRequests: number, count: number, resetSeconds: number): RateLimitUsage {
  return { limit: maxRequests, remaining: Math.max(0, maxRequests - count), resetSeconds };
}

/**
 * The same limit as `checkRateLimitRedis`, for callers that publish
 * `RateLimit-*` headers. Throws `RateLimitError` over the limit.
 */
export async function consumeRateLimitRedis(
  identity: string,
  operation: string,
  maxRequests: number,
  windowMs: number,
): Promise<RateLimitUsage> {
  const usingMemory = () => {
    const entry = checkRateLimit(`${identity}:${operation}`, maxRequests, windowMs);
    return usageFrom(maxRequests, entry.count, Math.ceil((entry.resetAt - Date.now()) / 1000));
  };

  if (!redisClientManager.isRedisConnected()) return usingMemory();

  try {
    const { publisher } = redisClientManager.getClients();
    const key = rateLimitKey(identity, operation, windowMs);
    const expireSeconds = Math.ceil(windowMs / 1000);
    const count = (await withRedisDeadline(
      publisher.eval(RATE_LIMIT_SCRIPT, 1, key, expireSeconds.toString()),
    )) as number;
    const resetSeconds = secondsUntilWindowEnds(windowMs);
    if (count > maxRequests) throw new RateLimitError(resetSeconds);
    return usageFrom(maxRequests, count, resetSeconds);
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    logger.warn('[RateLimit] Redis unavailable, falling back to in-memory:', (err as Error).message);
    return usingMemory();
  }
}

/**
 * Checks a window without counting this call, for a limit charged only once the
 * work has succeeded (`countRateLimitRedis`). Throws `RateLimitError` when full.
 */
export async function peekRateLimitRedis(
  identity: string,
  operation: string,
  maxRequests: number,
  windowMs: number,
): Promise<RateLimitUsage> {
  const usingMemory = () => {
    const entry = peekRateLimit(`${identity}:${operation}`);
    const count = entry?.count ?? 0;
    const resetSeconds = entry ? Math.ceil((entry.resetAt - Date.now()) / 1000) : secondsUntilWindowEnds(windowMs);
    if (count >= maxRequests) throw new RateLimitError(resetSeconds);
    return usageFrom(maxRequests, count, resetSeconds);
  };

  if (!redisClientManager.isRedisConnected()) return usingMemory();

  try {
    const { publisher } = redisClientManager.getClients();
    const stored = await withRedisDeadline(publisher.get(rateLimitKey(identity, operation, windowMs)));
    const count = Number(stored ?? 0);
    const resetSeconds = secondsUntilWindowEnds(windowMs);
    if (count >= maxRequests) throw new RateLimitError(resetSeconds);
    return usageFrom(maxRequests, count, resetSeconds);
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    logger.warn('[RateLimit] Redis unavailable, falling back to in-memory:', (err as Error).message);
    return usingMemory();
  }
}

/** Adds one to a window without checking it. Never throws: the work it counts has already happened. */
export async function countRateLimitRedis(identity: string, operation: string, windowMs: number): Promise<void> {
  const usingMemory = () => void incrementRateLimit(`${identity}:${operation}`, windowMs);

  if (!redisClientManager.isRedisConnected()) {
    usingMemory();
    return;
  }

  try {
    const { publisher } = redisClientManager.getClients();
    const key = rateLimitKey(identity, operation, windowMs);
    const expireSeconds = Math.ceil(windowMs / 1000);
    await withRedisDeadline(publisher.eval(RATE_LIMIT_SCRIPT, 1, key, expireSeconds.toString()));
  } catch (err) {
    logger.warn('[RateLimit] Redis unavailable, falling back to in-memory:', (err as Error).message);
    usingMemory();
  }
}
