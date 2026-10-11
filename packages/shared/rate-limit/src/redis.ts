import { RateLimitError } from './memory';

/**
 * Atomic INCR + EXPIRE. Setting the expiry in the same Redis operation avoids
 * leaving a permanent counter if the process exits between two commands.
 */
export const REDIS_RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`;

export type RedisRateLimitEvaluate = (
  script: string,
  numberOfKeys: number,
  key: string,
  expireSeconds: string,
) => Promise<unknown>;

type CheckRedisRateLimitOptions = {
  evaluate?: RedisRateLimitEvaluate;
  fallback?: () => void;
  identity: string;
  maxRequests: number;
  namespace?: string;
  now?: () => number;
  onStoreError?: (error: unknown) => void;
  operation: string;
  windowMs: number;
};

export function buildRedisRateLimitKey(
  identity: string,
  operation: string,
  windowBucket: number,
  namespace?: string,
): string {
  const namespaceSegment = namespace ? `${namespace}:` : '';
  return `ratelimit:${namespaceSegment}${identity}:${operation}:${windowBucket}`;
}

/**
 * Spend one request from a shared Redis fixed window.
 *
 * Redis is injected so backend and web keep their own connection lifecycles.
 * A missing or failed store can invoke a caller-provided local fallback. A
 * RateLimitError is always re-thrown and can never be mistaken for transport
 * failure.
 */
export async function checkRedisRateLimit({
  evaluate,
  fallback,
  identity,
  maxRequests,
  namespace,
  now = Date.now,
  onStoreError,
  operation,
  windowMs,
}: CheckRedisRateLimitOptions): Promise<void> {
  if (!evaluate) {
    fallback?.();
    return;
  }

  const requestTime = now();
  const windowBucket = Math.floor(requestTime / windowMs);
  const key = buildRedisRateLimitKey(identity, operation, windowBucket, namespace);
  const expireSeconds = Math.ceil(windowMs / 1000);

  try {
    const rawCount = await evaluate(REDIS_RATE_LIMIT_SCRIPT, 1, key, expireSeconds.toString());
    const requestCount = parseRedisCount(rawCount);

    if (requestCount > maxRequests) {
      const windowEndsAt = (windowBucket + 1) * windowMs;
      throw new RateLimitError(Math.max(1, Math.ceil((windowEndsAt - now()) / 1000)));
    }
  } catch (error) {
    if (error instanceof RateLimitError) throw error;
    onStoreError?.(error);
    fallback?.();
  }
}

function parseRedisCount(rawCount: unknown): number {
  const requestCount = typeof rawCount === 'number' ? rawCount : Number(rawCount);
  if (!Number.isSafeInteger(requestCount) || requestCount < 1) {
    throw new Error('Redis returned an invalid rate-limit count');
  }
  return requestCount;
}
