import { MemoryRateLimiter, RateLimitError } from '@boardsesh/rate-limit';

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS = 60;
const UNKNOWN_RATE_LIMIT_IDENTIFIER = 'backend:unknown-connection';
// Deliberately no process-wide timer: cleanup happens on traffic and the
// shared limiter's hard entry cap bounds an idle backend until traffic resumes.
const rateLimiter = new MemoryRateLimiter();

export { RateLimitError };

function normalizeRateLimitIdentifier(identifier: string): string {
  // Production contexts use server-generated UUID/http identifiers, but a
  // malformed or legacy context must still spend a finite shared budget. A
  // stable sentinel preserves the old empty-key behavior without weakening
  // the shared limiter's non-empty-identifier invariant or minting new keys.
  return identifier.trim() ? identifier : UNKNOWN_RATE_LIMIT_IDENTIFIER;
}

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
  rateLimiter.check(normalizeRateLimitIdentifier(connectionId), maxRequests, windowMs);
}

export function cleanupRateLimit(connectionId: string): void {
  rateLimiter.cleanup(normalizeRateLimitIdentifier(connectionId));
}

export function getRateLimitStatus(connectionId: string): {
  remaining: number;
  resetAt: number | null;
} | null {
  return rateLimiter.getStatus(normalizeRateLimitIdentifier(connectionId), DEFAULT_MAX_REQUESTS);
}

export function resetAllRateLimits(): void {
  rateLimiter.reset();
}
