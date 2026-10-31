export type RateLimitResult = { limited: false; retryAfterSeconds: 0 } | { limited: true; retryAfterSeconds: number };

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

export class RateLimitError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    const positiveRetryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
    super(`Rate limit exceeded. Try again in ${positiveRetryAfterSeconds} seconds.`);
    this.name = 'RateLimitError';
    this.retryAfterSeconds = positiveRetryAfterSeconds;
  }
}

type MemoryRateLimiterOptions = {
  maxEntries?: number;
  now?: () => number;
  pruneIntervalMs?: number;
};

const DEFAULT_MAX_ENTRIES = 50_000;
const DEFAULT_PRUNE_INTERVAL_MS = 60_000;

/**
 * Per-process fixed-window limiter used as the fast first tier before Redis.
 *
 * The map is bounded even when an attacker keeps presenting new identities.
 * Expired entries are pruned opportunistically, so consumers do not need a
 * process-wide interval that keeps short-lived serverless workers alive.
 */
export class MemoryRateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly pruneIntervalMs: number;
  private nextPruneAt = 0;

  constructor(options: MemoryRateLimiterOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? (() => Date.now());
    this.pruneIntervalMs = options.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;

    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new RangeError('maxEntries must be a positive safe integer');
    }
    if (!Number.isFinite(this.pruneIntervalMs) || this.pruneIntervalMs < 1) {
      throw new RangeError('pruneIntervalMs must be positive');
    }
  }

  consume(identifier: string, maxRequests: number, windowMs: number): RateLimitResult {
    assertRateLimitArguments(identifier, maxRequests, windowMs);

    const requestTime = this.now();
    this.pruneExpired(requestTime);

    const entry = this.entries.get(identifier);
    if (!entry || requestTime > entry.resetAt) {
      if (!entry) this.evictOldestAtCapacity(requestTime);
      this.entries.set(identifier, { count: 1, resetAt: requestTime + windowMs });
      return { limited: false, retryAfterSeconds: 0 };
    }

    if (entry.count >= maxRequests) {
      return {
        limited: true,
        retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - requestTime) / 1000)),
      };
    }

    entry.count += 1;
    return { limited: false, retryAfterSeconds: 0 };
  }

  check(identifier: string, maxRequests: number, windowMs: number): void {
    const result = this.consume(identifier, maxRequests, windowMs);
    if (result.limited) throw new RateLimitError(result.retryAfterSeconds);
  }

  cleanup(identifier: string): void {
    this.entries.delete(identifier);
  }

  getStatus(
    identifier: string,
    maxRequests: number,
  ): {
    remaining: number;
    resetAt: number | null;
  } | null {
    const entry = this.entries.get(identifier);
    if (!entry) return null;

    const requestTime = this.now();
    if (requestTime > entry.resetAt) {
      this.entries.delete(identifier);
      return { remaining: maxRequests, resetAt: null };
    }

    return {
      remaining: Math.max(0, maxRequests - entry.count),
      resetAt: entry.resetAt,
    };
  }

  reset(): void {
    this.entries.clear();
    this.nextPruneAt = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  private pruneExpired(requestTime: number, force = false): void {
    if (!force && requestTime < this.nextPruneAt) return;

    for (const [identifier, entry] of this.entries) {
      if (requestTime > entry.resetAt) this.entries.delete(identifier);
    }
    this.nextPruneAt = requestTime + this.pruneIntervalMs;
  }

  private evictOldestAtCapacity(requestTime: number): void {
    if (this.entries.size < this.maxEntries) return;

    this.pruneExpired(requestTime, true);
    if (this.entries.size < this.maxEntries) return;

    // Map order makes this the insertion-oldest live identity. This is an O(1)
    // bounded-memory fallback, not an expiry-priority queue; Redis remains the
    // authoritative cross-instance tier when configured.
    const oldestIdentifier = this.entries.keys().next().value;
    if (typeof oldestIdentifier === 'string') this.entries.delete(oldestIdentifier);
  }
}

function assertRateLimitArguments(identifier: string, maxRequests: number, windowMs: number): void {
  if (!identifier) throw new RangeError('identifier must not be empty');
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) {
    throw new RangeError('maxRequests must be a positive safe integer');
  }
  if (!Number.isFinite(windowMs) || windowMs < 1) throw new RangeError('windowMs must be positive');
}
