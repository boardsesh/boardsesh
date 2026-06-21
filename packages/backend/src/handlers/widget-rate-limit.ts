/**
 * Per-session token bucket shared by the widget write endpoints
 * (`/api/widget/navigate` and `/api/widget/take-control`).
 *
 * Threat model: an iOS widget can fire requests rapidly (e.g. the user mashing
 * the next button or the lightbulb while the lock screen renders). Both widget
 * writes funnel into `setCurrentClimbAndPublish` / `navigateToQueueItem`, whose
 * internal MAX_RETRIES=3 optimistic-lock loop can amplify a burst of taps into a
 * stampede on `roomManager.updateQueueState`. A single shared bucket per session
 * bounds the combined widget write rate.
 *
 * Bucket: 2 capacity, refills at 1 token / 1.5s. So 2 quick taps go through;
 * sustained taps are limited to ~40 req/min per session.
 *
 * In-memory only — the widget endpoints run per-instance and the limit is a
 * defense-in-depth measure, not a hard quota. Across instances the limit is
 * looser, which is acceptable for this threat model.
 */
const RATE_BUCKET_CAPACITY = 2;
const RATE_REFILL_PER_SECOND = 1 / 1.5;

interface RateBucket {
  tokens: number;
  lastRefillMs: number;
}

const rateBuckets = new Map<string, RateBucket>();

/** Returns true when a token was available (request allowed), false to 429. */
export function checkWidgetRateLimit(sessionId: string): boolean {
  const now = Date.now();
  const existing = rateBuckets.get(sessionId);

  if (!existing) {
    rateBuckets.set(sessionId, { tokens: RATE_BUCKET_CAPACITY - 1, lastRefillMs: now });
    return true;
  }

  // Refill tokens based on elapsed time
  const elapsedSeconds = (now - existing.lastRefillMs) / 1000;
  const refilled = Math.min(RATE_BUCKET_CAPACITY, existing.tokens + elapsedSeconds * RATE_REFILL_PER_SECOND);
  existing.lastRefillMs = now;

  if (refilled < 1) {
    existing.tokens = refilled;
    return false;
  }

  existing.tokens = refilled - 1;
  return true;
}

/** Periodically prune buckets that haven't been touched for 5 minutes. */
const RATE_BUCKET_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const RATE_BUCKET_TTL_MS = 5 * 60 * 1000;
let pruneIntervalHandle: ReturnType<typeof setInterval> | null = null;

export function ensureWidgetRateLimitPruner(): void {
  if (pruneIntervalHandle !== null) return;
  pruneIntervalHandle = setInterval(() => {
    const cutoff = Date.now() - RATE_BUCKET_TTL_MS;
    for (const [sessionId, bucket] of rateBuckets) {
      if (bucket.lastRefillMs < cutoff) {
        rateBuckets.delete(sessionId);
      }
    }
  }, RATE_BUCKET_PRUNE_INTERVAL_MS);
  // Don't keep the process alive solely for this timer.
  if (typeof pruneIntervalHandle.unref === 'function') pruneIntervalHandle.unref();
}

/**
 * Reset all buckets and stop the pruner. Not part of the public API; tests
 * import this directly to isolate rate-limit state between cases.
 */
export function __resetWidgetRateLimitForTests(): void {
  rateBuckets.clear();
  if (pruneIntervalHandle !== null) {
    clearInterval(pruneIntervalHandle);
    pruneIntervalHandle = null;
  }
}
