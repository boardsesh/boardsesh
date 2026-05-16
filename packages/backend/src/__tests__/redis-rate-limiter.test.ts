import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { GraphQLError } from 'graphql';
import { checkRateLimitRedis } from '../utils/redis-rate-limiter';
import { RATE_LIMIT_ERROR_CODE } from '../utils/rate-limit-error';

// Use vi.hoisted() so mock variables are available when vi.mock factories run
const { mockEval, mockIsRedisConnected, mockCheckRateLimit } = vi.hoisted(() => ({
  mockEval: vi.fn(),
  mockIsRedisConnected: vi.fn(),
  mockCheckRateLimit: vi.fn(),
}));

vi.mock('../redis/client', () => ({
  redisClientManager: {
    isRedisConnected: mockIsRedisConnected,
    getClients: () => ({
      publisher: {
        eval: mockEval,
      },
    }),
  },
}));

vi.mock('../utils/rate-limiter', () => ({
  checkRateLimit: mockCheckRateLimit,
}));

describe('checkRateLimitRedis', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('when Redis is connected', () => {
    beforeEach(() => {
      mockIsRedisConnected.mockReturnValue(true);
    });

    it('executes atomic Lua script with correct key and expire', async () => {
      mockEval.mockResolvedValue(1);

      await checkRateLimitRedis('user-1', 'vote', 30, 60_000);

      expect(mockEval).toHaveBeenCalledOnce();
      // eval(script, numKeys, key, expireSeconds)
      const [script, numKeys, key, expireSeconds] = mockEval.mock.calls[0];
      expect(script).toContain('INCR');
      expect(script).toContain('EXPIRE');
      expect(numKeys).toBe(1);
      expect(key).toContain('ratelimit:');
      expect(key).toContain('user-1');
      expect(key).toContain('vote');
      expect(expireSeconds).toBe('60');
    });

    it('allows requests within the limit', async () => {
      mockEval.mockResolvedValue(30); // exactly at limit

      await expect(checkRateLimitRedis('user-1', 'vote', 30, 60_000)).resolves.toBeUndefined();
    });

    it('throws when rate limit is exceeded', async () => {
      mockEval.mockResolvedValue(31); // over limit of 30

      await expect(checkRateLimitRedis('user-1', 'vote', 30, 60_000)).rejects.toThrow('Rate limit exceeded');
    });

    it('throws a GraphQLError with RATE_LIMITED extension when exceeded', async () => {
      mockEval.mockResolvedValue(31);

      try {
        await checkRateLimitRedis('user-1', 'vote', 30, 60_000);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GraphQLError);
        const gqlErr = err as GraphQLError;
        expect(gqlErr.extensions?.code).toBe(RATE_LIMIT_ERROR_CODE);
        expect(typeof gqlErr.extensions?.retryAfterSeconds).toBe('number');
      }
    });

    it('uses correct window bucket based on current time', async () => {
      mockEval.mockResolvedValue(1);

      await checkRateLimitRedis('user-1', 'vote', 30, 60_000);

      const key = mockEval.mock.calls[0][2]; // third arg is key
      const expectedBucket = Math.floor(Date.now() / 60_000);
      expect(key).toBe(`ratelimit:user-1:vote:${expectedBucket}`);
    });

    it('uses different keys for different operations', async () => {
      mockEval.mockResolvedValue(1);

      await checkRateLimitRedis('user-1', 'vote', 30, 60_000);
      await checkRateLimitRedis('user-1', 'comment', 10, 60_000);

      const key1 = mockEval.mock.calls[0][2];
      const key2 = mockEval.mock.calls[1][2];
      expect(key1).toContain('vote');
      expect(key2).toContain('comment');
      expect(key1).not.toBe(key2);
    });

    it('uses different keys for different users', async () => {
      mockEval.mockResolvedValue(1);

      await checkRateLimitRedis('user-1', 'vote', 30, 60_000);
      await checkRateLimitRedis('user-2', 'vote', 30, 60_000);

      const key1 = mockEval.mock.calls[0][2];
      const key2 = mockEval.mock.calls[1][2];
      expect(key1).toContain('user-1');
      expect(key2).toContain('user-2');
      expect(key1).not.toBe(key2);
    });

    it('passes expire seconds as string argument', async () => {
      mockEval.mockResolvedValue(1);

      // 30 second window → ceil(30000 / 1000) = 30
      await checkRateLimitRedis('user-1', 'vote', 10, 30_000);

      const expireSeconds = mockEval.mock.calls[0][3];
      expect(expireSeconds).toBe('30');
    });
  });

  describe('when Redis is not connected', () => {
    beforeEach(() => {
      mockIsRedisConnected.mockReturnValue(false);
    });

    it('falls back to in-memory rate limiter', async () => {
      await checkRateLimitRedis('user-1', 'vote', 30, 60_000);

      expect(mockEval).not.toHaveBeenCalled();
      expect(mockCheckRateLimit).toHaveBeenCalledWith('user-1:vote', 30, 60_000);
    });

    it('re-throws in-memory rate limit errors', async () => {
      mockCheckRateLimit.mockImplementation(() => {
        throw new Error('Rate limit exceeded. Try again in 30 seconds.');
      });

      await expect(checkRateLimitRedis('user-1', 'vote', 30, 60_000)).rejects.toThrow('Rate limit exceeded');
    });
  });

  describe('when Redis throws a connection error', () => {
    beforeEach(() => {
      mockIsRedisConnected.mockReturnValue(true);
    });

    it('falls back to in-memory rate limiter on Redis error', async () => {
      mockEval.mockRejectedValue(new Error('ECONNREFUSED'));

      await checkRateLimitRedis('user-1', 'vote', 30, 60_000);

      expect(mockCheckRateLimit).toHaveBeenCalledWith('user-1:vote', 30, 60_000);
    });

    it('re-throws rate limit errors even when Redis has issues', async () => {
      mockEval.mockRejectedValue(new Error('Rate limit exceeded. Try again in 30 seconds.'));

      await expect(checkRateLimitRedis('user-1', 'vote', 30, 60_000)).rejects.toThrow('Rate limit exceeded');
    });

    it('does not re-throw non-rate-limit errors', async () => {
      mockEval.mockRejectedValue(new Error('Redis cluster timeout'));

      // Should not throw — falls back to in-memory
      await expect(checkRateLimitRedis('user-1', 'vote', 30, 60_000)).resolves.toBeUndefined();
    });
  });
});
