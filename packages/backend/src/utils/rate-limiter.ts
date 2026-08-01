import { MemoryRateLimiter, RateLimitError } from '@boardsesh/rate-limit';

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS = 60;
const rateLimiter = new MemoryRateLimiter();

export { RateLimitError };

/**
 * Check one per-process fixed-window bucket.
 *
 * This remains the backend's fast Tier 1; the implementation lives in the
 * shared rate-limit package so the Vercel public API and backend cannot drift.
 */
export function checkRateLimit(
  connectionId: string,
  maxRequests: number = DEFAULT_MAX_REQUESTS,
  windowMs: number = DEFAULT_WINDOW_MS,
): void {
  rateLimiter.check(connectionId, maxRequests, windowMs);
}

export function cleanupRateLimit(connectionId: string): void {
  rateLimiter.cleanup(connectionId);
}

export function getRateLimitStatus(connectionId: string): {
  remaining: number;
  resetAt: number | null;
} | null {
  return rateLimiter.getStatus(connectionId, DEFAULT_MAX_REQUESTS);
}

export function resetAllRateLimits(): void {
  rateLimiter.reset();
}
