/**
 * Tests for applyRateLimit helper — specifically the key selection logic
 * that determines how anonymous vs authenticated requests are rate limited.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ConnectionContext } from '@boardsesh/shared-schema';

// Mock rate limiter utilities so we can inspect which keys are used
const mockCheckRateLimit = vi.fn();
const mockCheckRateLimitRedis = vi.fn().mockResolvedValue(undefined);

vi.mock('../utils/rate-limiter', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

vi.mock('../utils/redis-rate-limiter', () => ({
  checkRateLimitRedis: (...args: unknown[]) => mockCheckRateLimitRedis(...args),
}));

// Mock getContext (imported by helpers.ts)
vi.mock('../graphql/context', () => ({
  getContext: vi.fn(),
}));

// Mock distributed-state (imported by helpers.ts)
vi.mock('../services/distributed-state', () => ({
  getDistributedState: vi.fn().mockReturnValue(null),
}));

// Mock db client to avoid DATABASE_URL requirement
vi.mock('../db/client', () => ({
  db: {},
  createRequestDb: () => ({}),
  withTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
}));

import { applyRateLimit } from '../graphql/resolvers/shared/helpers';

describe('applyRateLimit key selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses userId for authenticated users', async () => {
    const ctx: ConnectionContext = {
      connectionId: 'ws-123',
      isAuthenticated: true,
      userId: 'user-42',
    };

    await applyRateLimit(ctx, 5, 'createSession');

    expect(mockCheckRateLimit).toHaveBeenCalledWith('user-42:createSession', 5);
    // Also hits Redis for authenticated users
    expect(mockCheckRateLimitRedis).toHaveBeenCalledWith('user-42', 'createSession', 5, 60_000);
  });

  it('uses clientIp for anonymous HTTP requests', async () => {
    const ctx: ConnectionContext = {
      connectionId: 'http-abc-123',
      isAuthenticated: false,
      userId: undefined,
      clientIp: '203.0.113.50',
    };

    await applyRateLimit(ctx, 5, 'createSession');

    expect(mockCheckRateLimit).toHaveBeenCalledWith('ip:203.0.113.50:createSession', 5);
    // No Redis for anonymous users
    expect(mockCheckRateLimitRedis).not.toHaveBeenCalled();
  });

  it('shares rate limit bucket across anonymous requests from the same IP', async () => {
    const ctx1: ConnectionContext = {
      connectionId: 'http-request-1',
      isAuthenticated: false,
      clientIp: '10.0.0.1',
    };
    const ctx2: ConnectionContext = {
      connectionId: 'http-request-2',
      isAuthenticated: false,
      clientIp: '10.0.0.1',
    };

    await applyRateLimit(ctx1, 5, 'createSession');
    await applyRateLimit(ctx2, 5, 'createSession');

    // Both should use the same key
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(2);
    expect(mockCheckRateLimit.mock.calls[0][0]).toBe('ip:10.0.0.1:createSession');
    expect(mockCheckRateLimit.mock.calls[1][0]).toBe('ip:10.0.0.1:createSession');
  });

  it('falls back to connectionId when no clientIp and not authenticated', async () => {
    const ctx: ConnectionContext = {
      connectionId: 'ws-anon-456',
      isAuthenticated: false,
      userId: undefined,
      clientIp: undefined,
    };

    await applyRateLimit(ctx, 5, 'default');

    expect(mockCheckRateLimit).toHaveBeenCalledWith('ws-anon-456', 5);
    expect(mockCheckRateLimitRedis).not.toHaveBeenCalled();
  });
});
