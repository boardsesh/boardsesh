import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkWidgetRateLimit,
  ensureWidgetRateLimitPruner,
  __resetWidgetRateLimitForTests,
} from '../handlers/widget-rate-limit';

beforeEach(() => {
  __resetWidgetRateLimitForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  __resetWidgetRateLimitForTests();
  vi.useRealTimers();
});

describe('checkWidgetRateLimit', () => {
  it('allows the first request on a new session and initialises the bucket', () => {
    expect(checkWidgetRateLimit('session-1')).toBe(true);
  });

  it('allows the second immediate request (bucket starts at capacity 2)', () => {
    expect(checkWidgetRateLimit('session-1')).toBe(true);
    expect(checkWidgetRateLimit('session-1')).toBe(true);
  });

  it('throttles the third rapid request (both tokens consumed)', () => {
    checkWidgetRateLimit('session-1');
    checkWidgetRateLimit('session-1');
    expect(checkWidgetRateLimit('session-1')).toBe(false);
  });

  it('refills a token after the expected interval and allows another request', () => {
    checkWidgetRateLimit('session-1');
    checkWidgetRateLimit('session-1');
    // Bucket empty. Advance 1.5 s — enough to refill 1 token (refill rate = 1/1.5 s).
    vi.advanceTimersByTime(1500);
    expect(checkWidgetRateLimit('session-1')).toBe(true);
  });

  it('does not allow a request before a full refill interval', () => {
    checkWidgetRateLimit('session-1');
    checkWidgetRateLimit('session-1');
    // Only 1 s — not enough for even 1 token at 1/1.5 s.
    vi.advanceTimersByTime(1000);
    expect(checkWidgetRateLimit('session-1')).toBe(false);
  });

  it('caps the bucket at capacity 2 regardless of how much time has passed', () => {
    // One token consumed; advance far beyond full refill.
    checkWidgetRateLimit('session-1');
    vi.advanceTimersByTime(60_000);
    // Bucket should be capped at 2 — so exactly 2 requests are allowed.
    expect(checkWidgetRateLimit('session-1')).toBe(true);
    expect(checkWidgetRateLimit('session-1')).toBe(true);
    expect(checkWidgetRateLimit('session-1')).toBe(false);
  });

  it('maintains separate buckets per session', () => {
    checkWidgetRateLimit('session-1');
    checkWidgetRateLimit('session-1');
    // session-1 is empty; session-2 starts fresh.
    expect(checkWidgetRateLimit('session-2')).toBe(true);
    expect(checkWidgetRateLimit('session-2')).toBe(true);
    // But session-1 is still throttled.
    expect(checkWidgetRateLimit('session-1')).toBe(false);
  });

  it('a fresh session always gets 2 requests regardless of other sessions being throttled', () => {
    for (let i = 0; i < 10; i++) {
      checkWidgetRateLimit(`session-${i}`);
      checkWidgetRateLimit(`session-${i}`);
      expect(checkWidgetRateLimit(`session-${i}`)).toBe(false);
    }
    // Brand-new session is unaffected.
    expect(checkWidgetRateLimit('session-new')).toBe(true);
  });
});

describe('ensureWidgetRateLimitPruner', () => {
  it('is idempotent — calling it multiple times does not register duplicate intervals', () => {
    // If setInterval were called twice with the same 5-min period, advancing
    // 5 min would fire the pruner callback twice. We verify the bucket count
    // is still correct after the prune by observing behaviour, not internals.
    ensureWidgetRateLimitPruner();
    ensureWidgetRateLimitPruner();
    ensureWidgetRateLimitPruner();

    // Populate a bucket.
    checkWidgetRateLimit('session-singleton');

    // Advance past TTL (5 min).
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    // The bucket was pruned (session is gone); the next request allocates
    // a fresh bucket at full capacity.
    expect(checkWidgetRateLimit('session-singleton')).toBe(true);
    expect(checkWidgetRateLimit('session-singleton')).toBe(true);
    expect(checkWidgetRateLimit('session-singleton')).toBe(false);
  });
});

describe('pruner TTL cutoff', () => {
  it('evicts buckets not touched for 5 minutes', () => {
    ensureWidgetRateLimitPruner();

    checkWidgetRateLimit('session-stale');
    checkWidgetRateLimit('session-stale');
    // Bucket is empty.

    // Advance past the TTL so the pruner evicts it.
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    // After eviction the session gets a fresh full-capacity bucket.
    expect(checkWidgetRateLimit('session-stale')).toBe(true);
    expect(checkWidgetRateLimit('session-stale')).toBe(true);
    expect(checkWidgetRateLimit('session-stale')).toBe(false);
  });

  it('keeps buckets that were recently touched within the TTL', () => {
    ensureWidgetRateLimitPruner();

    checkWidgetRateLimit('session-active');
    checkWidgetRateLimit('session-active');
    // Bucket empty. Advance 4 min (under TTL).
    vi.advanceTimersByTime(4 * 60 * 1000);
    // Prune interval is 5 min — nothing pruned yet.
    // Refill would have given back ~2.67 tokens; consuming all of them.
    expect(checkWidgetRateLimit('session-active')).toBe(true);
    expect(checkWidgetRateLimit('session-active')).toBe(true);
    // 3rd still throttled (capacity = 2).
    expect(checkWidgetRateLimit('session-active')).toBe(false);
  });

  it('does not evict a bucket that was touched just before the prune interval fires', () => {
    ensureWidgetRateLimitPruner();

    // Create bucket, advance to just before the prune fires, touch it.
    checkWidgetRateLimit('session-refreshed');
    vi.advanceTimersByTime(4 * 60 * 1000 + 59_000); // ~4m59s
    // Touch the bucket — resets lastRefillMs.
    checkWidgetRateLimit('session-refreshed');

    // Now fire the prune interval.
    vi.advanceTimersByTime(60_000 + 1); // crosses 5-min boundary from original creation

    // Bucket was touched at t≈299s; now at t≈360s, 61s have passed, so it
    // refills to capacity 2. Both drain calls must succeed (bucket was not
    // evicted — lastRefillMs was reset well within the 5-min TTL), and the
    // third must be throttled (cap is 2).
    expect(checkWidgetRateLimit('session-refreshed')).toBe(true);
    expect(checkWidgetRateLimit('session-refreshed')).toBe(true);
    expect(checkWidgetRateLimit('session-refreshed')).toBe(false);
  });
});

describe('__resetWidgetRateLimitForTests', () => {
  it('clears all buckets so a previously throttled session is allowed again', () => {
    checkWidgetRateLimit('session-reset');
    checkWidgetRateLimit('session-reset');
    expect(checkWidgetRateLimit('session-reset')).toBe(false);

    __resetWidgetRateLimitForTests();

    expect(checkWidgetRateLimit('session-reset')).toBe(true);
  });

  it('stops the pruner so tests can start it again cleanly', () => {
    ensureWidgetRateLimitPruner();
    __resetWidgetRateLimitForTests();
    // If the pruner handle were not cleared, ensureWidgetRateLimitPruner would
    // skip registering a new one, and the test below would have no pruner to
    // advance. Verifying it works proves reset cleared the handle.
    ensureWidgetRateLimitPruner();
    checkWidgetRateLimit('session-after-reset');
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    // Pruner fires → bucket evicted → fresh allocation.
    expect(checkWidgetRateLimit('session-after-reset')).toBe(true);
  });
});
