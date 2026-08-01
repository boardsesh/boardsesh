import { checkRedisRateLimit, type RedisRateLimitEvaluate } from '@boardsesh/rate-limit';
import { redisClientManager } from '../redis/client';
import { checkRateLimit } from './rate-limiter';
import { logger } from './logger';

/**
 * Distributed fixed-window limiter backed by the backend publisher connection.
 * The shared package owns the Lua, key shape, count parsing, and fallback
 * control flow; this adapter owns only the backend Redis lifecycle and logger.
 */
export async function checkRateLimitRedis(
  identity: string,
  operation: string,
  maxRequests: number,
  windowMs: number,
  options: { fallbackToMemory?: boolean } = {},
): Promise<void> {
  const fallbackToMemory = options.fallbackToMemory ?? true;
  let evaluate: RedisRateLimitEvaluate | undefined;

  if (redisClientManager.isRedisConnected()) {
    evaluate = async (script, numberOfKeys, key, expireSeconds) => {
      // Resolve the client inside the shared error boundary. The manager can
      // disconnect after isRedisConnected() but before this request executes.
      const { publisher } = redisClientManager.getClients();
      return publisher.eval(script, numberOfKeys, key, expireSeconds);
    };
  }

  await checkRedisRateLimit({
    evaluate,
    fallback: fallbackToMemory
      ? () => {
          checkRateLimit(`${identity}:${operation}`, maxRequests, windowMs);
        }
      : undefined,
    identity,
    maxRequests,
    onStoreError: (error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(
        fallbackToMemory
          ? '[RateLimit] Redis unavailable, falling back to in-memory:'
          : '[RateLimit] Redis unavailable; caller in-memory tier remains active:',
        errorMessage,
      );
    },
    operation,
    windowMs,
  });
}
