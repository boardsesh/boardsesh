/**
 * Simple in-memory rate limiter for GraphQL mutations.
 * Uses a sliding window algorithm with per-connection tracking.
 */

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

/**
 * Thrown when a caller exceeds its window. Carries `retryAfterSeconds` so the
 * GraphQL layer (`applyRateLimit`) can surface a structured `RATE_LIMITED`
 * error instead of forcing clients to string-match the message. The message
 * text is kept stable for older clients that still read it.
 */
export class RateLimitError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(`Rate limit exceeded. Try again in ${retryAfterSeconds} seconds.`);
    this.name = 'RateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// Store rate limit state per connection
const rateLimitMap = new Map<string, RateLimitEntry>();

// Default limits
const DEFAULT_WINDOW_MS = 60_000; // 1 minute
const DEFAULT_MAX_REQUESTS = 60; // 60 requests per minute per connection

/**
 * Check if a request should be rate limited.
 * @param connectionId - The unique connection identifier
 * @param maxRequests - Maximum requests allowed in the time window
 * @param windowMs - Time window in milliseconds
 * @throws Error if rate limit exceeded
 */
export function checkRateLimit(
  connectionId: string,
  maxRequests: number = DEFAULT_MAX_REQUESTS,
  windowMs: number = DEFAULT_WINDOW_MS,
): void {
  const now = Date.now();
  const entry = rateLimitMap.get(connectionId);

  // If no entry or window expired, create new entry
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(connectionId, {
      count: 1,
      resetAt: now + windowMs,
    });
    return;
  }

  // Check if limit exceeded
  if (entry.count >= maxRequests) {
    const retryAfterSeconds = Math.ceil((entry.resetAt - now) / 1000);
    throw new RateLimitError(retryAfterSeconds);
  }

  // Increment counter
  entry.count++;
}

/**
 * Clean up rate limit entries for a disconnected connection.
 * @param connectionId - The connection to clean up
 */
export function cleanupRateLimit(connectionId: string): void {
  rateLimitMap.delete(connectionId);
}

/**
 * Get current rate limit status for a connection.
 * Useful for debugging and monitoring.
 */
export function getRateLimitStatus(connectionId: string): {
  remaining: number;
  resetAt: number | null;
} | null {
  const entry = rateLimitMap.get(connectionId);
  if (!entry) return null;

  const now = Date.now();
  if (now > entry.resetAt) {
    return { remaining: DEFAULT_MAX_REQUESTS, resetAt: null };
  }

  return {
    remaining: Math.max(0, DEFAULT_MAX_REQUESTS - entry.count),
    resetAt: entry.resetAt,
  };
}

/**
 * Reset all rate limit state. Used in tests to prevent state leaking between test cases.
 */
export function resetAllRateLimits(): void {
  rateLimitMap.clear();
}

// Periodically clean up expired entries to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [connectionId, entry] of rateLimitMap) {
    if (now > entry.resetAt) {
      rateLimitMap.delete(connectionId);
    }
  }
}, 60_000); // Clean up every minute
