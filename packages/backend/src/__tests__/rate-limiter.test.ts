import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { GraphQLError } from 'graphql';
import { checkRateLimit, cleanupRateLimit, getRateLimitStatus } from '../utils/rate-limiter';
import { wrapDatabaseOperation } from '../utils/error-handler';
import { createRateLimitError, RATE_LIMIT_ERROR_CODE } from '../utils/rate-limit-error';

describe('In-memory rate limiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T10:00:00.000Z'));
  });

  afterEach(() => {
    // Clean up entries between tests
    cleanupRateLimit('test-conn');
    cleanupRateLimit('conn-1');
    cleanupRateLimit('conn-2');
    vi.useRealTimers();
  });

  describe('checkRateLimit', () => {
    it('allows the first request', () => {
      expect(() => checkRateLimit('test-conn', 5, 60_000)).not.toThrow();
    });

    it('allows requests up to the limit', () => {
      for (let i = 0; i < 5; i++) {
        expect(() => checkRateLimit('test-conn', 5, 60_000)).not.toThrow();
      }
    });

    it('throws when limit is exceeded', () => {
      for (let i = 0; i < 5; i++) {
        checkRateLimit('test-conn', 5, 60_000);
      }
      expect(() => checkRateLimit('test-conn', 5, 60_000)).toThrow('Rate limit exceeded');
    });

    it('includes retry-after in error message', () => {
      for (let i = 0; i < 5; i++) {
        checkRateLimit('test-conn', 5, 60_000);
      }
      // Advance time by 10 seconds, so ~50 seconds remain
      vi.advanceTimersByTime(10_000);

      try {
        checkRateLimit('test-conn', 5, 60_000);
        expect.fail('should have thrown');
      } catch (err) {
        expect((err as Error).message).toMatch(/Try again in \d+ seconds/);
      }
    });

    it('throws a GraphQLError with RATE_LIMITED extension code', () => {
      for (let i = 0; i < 5; i++) {
        checkRateLimit('test-conn', 5, 60_000);
      }
      try {
        checkRateLimit('test-conn', 5, 60_000);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GraphQLError);
        const gqlErr = err as GraphQLError;
        expect(gqlErr.extensions?.code).toBe(RATE_LIMIT_ERROR_CODE);
        expect(typeof gqlErr.extensions?.retryAfterSeconds).toBe('number');
        expect(gqlErr.extensions?.retryAfterSeconds as number).toBeGreaterThan(0);
      }
    });

    it('resets after the time window expires', () => {
      // Exhaust the limit
      for (let i = 0; i < 5; i++) {
        checkRateLimit('test-conn', 5, 60_000);
      }
      expect(() => checkRateLimit('test-conn', 5, 60_000)).toThrow();

      // Advance past the window
      vi.advanceTimersByTime(60_001);

      // Should work again
      expect(() => checkRateLimit('test-conn', 5, 60_000)).not.toThrow();
    });

    it('tracks different connections independently', () => {
      // Exhaust limit for conn-1
      for (let i = 0; i < 3; i++) {
        checkRateLimit('conn-1', 3, 60_000);
      }
      expect(() => checkRateLimit('conn-1', 3, 60_000)).toThrow();

      // conn-2 should still be fine
      expect(() => checkRateLimit('conn-2', 3, 60_000)).not.toThrow();
    });

    it('uses default values when not provided', () => {
      // Default is 60 requests per 60 seconds
      for (let i = 0; i < 60; i++) {
        expect(() => checkRateLimit('test-conn')).not.toThrow();
      }
      expect(() => checkRateLimit('test-conn')).toThrow('Rate limit exceeded');
    });
  });

  describe('cleanupRateLimit', () => {
    it('removes rate limit state for a connection', () => {
      // Use up some limit
      for (let i = 0; i < 5; i++) {
        checkRateLimit('test-conn', 5, 60_000);
      }
      expect(() => checkRateLimit('test-conn', 5, 60_000)).toThrow();

      // Clean up
      cleanupRateLimit('test-conn');

      // Should be fresh now
      expect(() => checkRateLimit('test-conn', 5, 60_000)).not.toThrow();
    });

    it('is safe to call for non-existent connections', () => {
      expect(() => cleanupRateLimit('nonexistent')).not.toThrow();
    });
  });

  describe('wrapDatabaseOperation rate-limit passthrough', () => {
    it('passes GraphQLError instances through unchanged', async () => {
      const original = createRateLimitError(7);
      let caught: unknown;
      try {
        await wrapDatabaseOperation(async () => {
          throw original;
        }, 'test');
        expect.fail('should have thrown');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBe(original);
      expect((caught as GraphQLError).extensions?.code).toBe(RATE_LIMIT_ERROR_CODE);
      expect((caught as GraphQLError).extensions?.retryAfterSeconds).toBe(7);
    });
  });

  describe('getRateLimitStatus', () => {
    it('returns null for unknown connections', () => {
      expect(getRateLimitStatus('unknown')).toBeNull();
    });

    it('returns remaining count for tracked connections', () => {
      checkRateLimit('test-conn', 10, 60_000);
      const status = getRateLimitStatus('test-conn');

      expect(status).not.toBeNull();
      // Default max is 60; we used 1 of our 10 limit, but getRateLimitStatus uses DEFAULT_MAX_REQUESTS (60)
      // So remaining = max(0, 60 - 1) = 59
      expect(status!.remaining).toBe(59);
      expect(status!.resetAt).not.toBeNull();
    });

    it('returns full capacity for expired windows', () => {
      checkRateLimit('test-conn', 5, 60_000);

      // Advance past the window
      vi.advanceTimersByTime(60_001);

      const status = getRateLimitStatus('test-conn');
      expect(status).not.toBeNull();
      expect(status!.remaining).toBe(60); // DEFAULT_MAX_REQUESTS
      expect(status!.resetAt).toBeNull();
    });
  });
});
