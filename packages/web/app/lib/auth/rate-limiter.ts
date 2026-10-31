/**
 * Rate limiter for API endpoints.
 *
 * IMPORTANT: This uses the bounded local tier from @boardsesh/rate-limit,
 * which has limitations:
 * - In serverless environments (Vercel), each function instance has its own memory
 * - Rate limits are not shared across instances
 * - This provides best-effort protection, not guaranteed rate limiting
 *
 * The implementation still provides value by:
 * - Limiting rapid-fire requests within a single function instance
 * - Deterring casual abuse
 * - Providing a framework for upgrading to distributed storage
 */

import { MemoryRateLimiter } from '@boardsesh/rate-limit';

const memoryRateLimiter = new MemoryRateLimiter();

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
  return memoryRateLimiter.consume(identifier, maxRequests, windowMs);
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
