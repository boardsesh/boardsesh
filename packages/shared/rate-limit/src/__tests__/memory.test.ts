import { describe, expect, it } from 'vite-plus/test';
import { MemoryRateLimiter, RateLimitError } from '../memory';

describe('MemoryRateLimiter', () => {
  it('allows the configured fixed-window budget and returns a positive retry delay', () => {
    let currentTime = 1_000;
    const limiter = new MemoryRateLimiter({ now: () => currentTime });

    expect(limiter.consume('ip:one', 2, 60_000)).toEqual({ limited: false, retryAfterSeconds: 0 });
    expect(limiter.consume('ip:one', 2, 60_000)).toEqual({ limited: false, retryAfterSeconds: 0 });

    currentTime += 10_000;
    expect(limiter.consume('ip:one', 2, 60_000)).toEqual({ limited: true, retryAfterSeconds: 50 });
  });

  it('throws the shared structured error from the check API', () => {
    const limiter = new MemoryRateLimiter({ now: () => 1_000 });
    limiter.check('ip:one', 1, 60_000);

    expect(() => limiter.check('ip:one', 1, 60_000)).toThrow(RateLimitError);
    try {
      limiter.check('ip:one', 1, 60_000);
    } catch (error) {
      expect((error as RateLimitError).retryAfterSeconds).toBe(60);
    }
  });

  it('starts a fresh window after the prior window expires', () => {
    let currentTime = 1_000;
    const limiter = new MemoryRateLimiter({ now: () => currentTime });
    limiter.check('ip:one', 1, 100);
    expect(() => limiter.check('ip:one', 1, 100)).toThrow(RateLimitError);

    currentTime += 101;
    expect(() => limiter.check('ip:one', 1, 100)).not.toThrow();
  });

  it('evicts the oldest identity instead of growing past the configured bound', () => {
    const limiter = new MemoryRateLimiter({ maxEntries: 2, now: () => 1_000 });
    limiter.consume('ip:one', 10, 60_000);
    limiter.consume('ip:two', 10, 60_000);
    limiter.consume('ip:three', 10, 60_000);

    expect(limiter.size).toBe(2);
    expect(limiter.getStatus('ip:one', 10)).toBeNull();
    expect(limiter.getStatus('ip:two', 10)).not.toBeNull();
    expect(limiter.getStatus('ip:three', 10)).not.toBeNull();
  });

  it('prunes expired identities before evicting a live one', () => {
    let currentTime = 1_000;
    const limiter = new MemoryRateLimiter({ maxEntries: 2, now: () => currentTime, pruneIntervalMs: 60_000 });
    limiter.consume('expired:one', 10, 100);
    limiter.consume('expired:two', 10, 100);

    currentTime += 101;
    limiter.consume('ip:new', 10, 60_000);

    expect(limiter.size).toBe(1);
    expect(limiter.getStatus('ip:new', 10)).not.toBeNull();
  });
});
