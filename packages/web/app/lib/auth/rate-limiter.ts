/**
 * Rate limiter for API endpoints.
 *
 * IMPORTANT: This uses in-memory storage which has limitations:
 * - In serverless environments (Vercel), each function instance has its own memory
 * - Rate limits are not shared across instances
 * - This provides best-effort protection, not guaranteed rate limiting
 *
 * For production deployments requiring strict rate limiting, consider:
 * - Redis (add ioredis to dependencies and use REDIS_URL)
 * - Vercel KV (@vercel/kv)
 * - Upstash Redis (@upstash/redis)
 *
 * The current implementation still provides value by:
 * - Limiting rapid-fire requests within a single function instance
 * - Deterring casual abuse
 * - Providing a framework for upgrading to distributed storage
 */

// In-memory store for rate limiting
const memoryStore = new Map<string, { count: number; resetAt: number }>();

// Default limits for email endpoints
const DEFAULT_WINDOW_MS = 60_000; // 1 minute
const DEFAULT_MAX_REQUESTS = 5;

/**
 * Check if a request should be rate limited.
 * @param identifier - Unique identifier for the rate limit bucket (e.g., "register:192.168.1.1")
 * @param maxRequests - Maximum requests allowed in the time window
 * @param windowMs - Time window in milliseconds
 * @returns Object with limited flag and retry-after seconds
 */
export function checkRateLimit(
  identifier: string,
  maxRequests: number = DEFAULT_MAX_REQUESTS,
  windowMs: number = DEFAULT_WINDOW_MS,
): { limited: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const entry = memoryStore.get(identifier);

  // If no entry or window expired, create new entry
  if (!entry || now > entry.resetAt) {
    memoryStore.set(identifier, {
      count: 1,
      resetAt: now + windowMs,
    });
    return { limited: false, retryAfterSeconds: 0 };
  }

  // Check if limit exceeded
  if (entry.count >= maxRequests) {
    const retryAfterSeconds = Math.ceil((entry.resetAt - now) / 1000);
    return { limited: true, retryAfterSeconds };
  }

  // Increment counter
  entry.count++;
  return { limited: false, retryAfterSeconds: 0 };
}

/**
 * Gives back one attempt that `checkRateLimit` counted, for a caller that only
 * wants to count attempts that failed. Counting first and giving back on
 * success, rather than counting after a failure, keeps a burst of parallel
 * requests from all passing the check before any of them is counted.
 */
export function releaseRateLimitAttempt(identifier: string): void {
  const entry = memoryStore.get(identifier);
  if (entry && entry.count > 0 && Date.now() <= entry.resetAt) entry.count--;
}

/**
 * Get client IP address from request headers.
 * Handles common proxy headers (x-forwarded-for, x-real-ip).
 */
export function getClientIp(request: Request): string {
  // Check x-forwarded-for first (most common proxy header)
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    // x-forwarded-for can contain multiple IPs; the first is the original client
    return forwarded.split(',')[0].trim();
  }

  // Check x-real-ip (used by some proxies like nginx)
  const realIp = request.headers.get('x-real-ip');
  if (realIp) {
    return realIp.trim();
  }

  // Fallback - still rate limit but with a shared bucket
  return 'unknown';
}

// Cleanup expired entries periodically to prevent memory leaks
// Uses unref() to allow the process to exit even with the interval running
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memoryStore) {
    if (now > entry.resetAt) {
      memoryStore.delete(key);
    }
  }
}, 60_000);

// Allow the Node.js process to exit even if this interval is pending
if (typeof cleanupInterval.unref === 'function') {
  cleanupInterval.unref();
}
