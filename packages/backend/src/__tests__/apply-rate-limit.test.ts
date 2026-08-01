/**
 * Tests for applyRateLimit helper — specifically the key selection logic
 * that determines how anonymous vs authenticated requests are rate limited.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { GraphQLError } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import {
  applyRateLimit,
  RATE_LIMIT_SESSION,
  RATE_LIMIT_PLAYBACK,
  RATE_LIMIT_JOIN_SESSION,
  RATE_LIMIT_JOIN_SESSION_OP,
  RATE_LIMIT_CREATE_SESSION,
  RATE_LIMIT_CREATE_SESSION_OP,
  RATE_LIMIT_END_SESSION,
  RATE_LIMIT_END_SESSION_OP,
  RATE_LIMIT_CONFIRM_CLIMB_ON_WALL,
  RATE_LIMIT_CONFIRM_CLIMB_ON_WALL_OP,
  RATE_LIMIT_SET_QUEUE,
  RATE_LIMIT_SET_QUEUE_OP,
} from '../graphql/resolvers/shared/helpers';
import { RateLimitError } from '../utils/rate-limiter';

function listResolverFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) return listResolverFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

function stripTypeScriptComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

// Mock rate limiter utilities so we can inspect which keys are used. Spread the
// real module so the genuine RateLimitError class survives — applyRateLimit
// branches on `error instanceof RateLimitError` to build the coded error.
const mockCheckRateLimit = vi.fn();
const mockCheckRateLimitRedis = vi.fn().mockResolvedValue(undefined);

vi.mock('../utils/rate-limiter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/rate-limiter')>();
  return {
    ...actual,
    checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  };
});

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
}));

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
    expect(mockCheckRateLimitRedis).toHaveBeenCalledWith('user-42', 'createSession', 5, 60_000, {
      fallbackToMemory: false,
    });
  });

  it('keeps anonymous HTTP callers on the local tier', async () => {
    // Distributed limiting for the separate HTTP trust boundary is tracked in
    // #3096. This issue only hardens WebSocket upgrade identity.
    const ctx: ConnectionContext = {
      connectionId: 'http-abc-123',
      transport: 'http',
      isAuthenticated: false,
      userId: undefined,
      clientIp: '203.0.113.50',
    };

    await applyRateLimit(ctx, 5, 'createSession');

    expect(mockCheckRateLimit).toHaveBeenCalledWith('ip:203.0.113.50:createSession', 5);
    expect(mockCheckRateLimitRedis).not.toHaveBeenCalled();
  });

  it('adds a high-ceiling distributed TCP-peer bucket for anonymous WebSocket callers', async () => {
    const ctx: ConnectionContext = {
      connectionId: 'ws-anon-123',
      transport: 'ws',
      isAuthenticated: false,
      clientIp: '203.0.113.50',
      socketPeerIp: '10.0.0.8',
    };

    await applyRateLimit(ctx, 5, 'createSession');

    expect(mockCheckRateLimit).toHaveBeenCalledWith('ip:203.0.113.50:createSession', 5);
    expect(mockCheckRateLimitRedis.mock.calls).toEqual([
      ['ip:203.0.113.50', 'createSession', 5, 60_000, { fallbackToMemory: false }],
      ['socket-peer:10.0.0.8', 'createSession', 600, 60_000, { fallbackToMemory: true }],
    ]);
  });

  it('keeps the TCP-peer bucket stable when a direct-origin caller rotates the Cloudflare header', async () => {
    const firstContext: ConnectionContext = {
      connectionId: 'ws-anon-1',
      transport: 'ws',
      isAuthenticated: false,
      clientIp: '203.0.113.1',
      socketPeerIp: '10.0.0.8',
    };
    const secondContext: ConnectionContext = {
      ...firstContext,
      connectionId: 'ws-anon-2',
      clientIp: '203.0.113.2',
    };

    await applyRateLimit(firstContext, 5, 'createSession');
    await applyRateLimit(secondContext, 5, 'createSession');

    const peerCalls = mockCheckRateLimitRedis.mock.calls.filter(([identity]) => identity === 'socket-peer:10.0.0.8');
    expect(peerCalls).toHaveLength(2);
    expect(peerCalls[0]).toEqual(peerCalls[1]);
  });

  it('does not apply the anonymous peer ceiling to authenticated WebSocket callers', async () => {
    const ctx: ConnectionContext = {
      connectionId: 'ws-user-123',
      transport: 'ws',
      isAuthenticated: true,
      userId: 'user-42',
      clientIp: '203.0.113.50',
      socketPeerIp: '10.0.0.8',
    };

    await applyRateLimit(ctx, 5, 'createSession');

    expect(mockCheckRateLimitRedis).toHaveBeenCalledOnce();
    expect(mockCheckRateLimitRedis).toHaveBeenCalledWith('user-42', 'createSession', 5, 60_000, {
      fallbackToMemory: false,
    });
  });

  it('still applies the anonymous peer ceiling when no client identity can be resolved', async () => {
    const ctx: ConnectionContext = {
      connectionId: 'ws-anon-123',
      transport: 'ws',
      isAuthenticated: false,
      clientIp: undefined,
      socketPeerIp: '10.0.0.8',
    };

    await applyRateLimit(ctx, 5, 'createSession');

    expect(mockCheckRateLimit).toHaveBeenCalledWith('ws-anon-123', 5);
    expect(mockCheckRateLimitRedis).toHaveBeenCalledOnce();
    expect(mockCheckRateLimitRedis).toHaveBeenCalledWith('socket-peer:10.0.0.8', 'createSession', 600, 60_000, {
      fallbackToMemory: true,
    });
  });

  it('shares rate limit bucket across anonymous requests from the same IP', async () => {
    const ctx1: ConnectionContext = {
      connectionId: 'ws-request-1',
      transport: 'ws',
      isAuthenticated: false,
      clientIp: '10.0.0.1',
    };
    const ctx2: ConnectionContext = {
      connectionId: 'ws-request-2',
      transport: 'ws',
      isAuthenticated: false,
      clientIp: '10.0.0.1',
    };

    await applyRateLimit(ctx1, 5, 'createSession');
    await applyRateLimit(ctx2, 5, 'createSession');

    // Both should use the same key
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(2);
    expect(mockCheckRateLimit.mock.calls[0][0]).toBe('ip:10.0.0.1:createSession');
    expect(mockCheckRateLimit.mock.calls[1][0]).toBe('ip:10.0.0.1:createSession');
    expect(mockCheckRateLimitRedis).toHaveBeenCalledTimes(2);
  });

  it('shares the local bucket across anonymous HTTP requests from the same IP', async () => {
    const firstContext: ConnectionContext = {
      connectionId: 'http-request-1',
      transport: 'http',
      isAuthenticated: false,
      clientIp: '10.0.0.1',
    };
    const secondContext: ConnectionContext = {
      ...firstContext,
      connectionId: 'http-request-2',
    };

    await applyRateLimit(firstContext, 5, 'createSession');
    await applyRateLimit(secondContext, 5, 'createSession');

    expect(mockCheckRateLimit.mock.calls.map(([identity]) => identity)).toEqual([
      'ip:10.0.0.1:createSession',
      'ip:10.0.0.1:createSession',
    ]);
    expect(mockCheckRateLimitRedis).not.toHaveBeenCalled();
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

describe('applyRateLimit structured RATE_LIMITED error (#2763)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rethrows a coded GraphQLError carrying retryAfterSeconds when a bucket is exceeded', async () => {
    mockCheckRateLimit.mockImplementationOnce(() => {
      throw new RateLimitError(22);
    });
    const ctx: ConnectionContext = { connectionId: 'ws-1', isAuthenticated: true, userId: 'user-1' };

    const error = await applyRateLimit(ctx, RATE_LIMIT_SESSION, 'session').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GraphQLError);
    expect((error as GraphQLError).extensions).toMatchObject({
      code: 'RATE_LIMITED',
      operation: 'session',
      retryAfterSeconds: 22,
    });
    // Message text is preserved for older clients that still string-match.
    expect((error as GraphQLError).message).toMatch(/Rate limit exceeded/);
  });

  it('rejects an anonymous WebSocket request when its TCP-peer ceiling is exceeded', async () => {
    mockCheckRateLimitRedis.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new RateLimitError(17));
    const ctx: ConnectionContext = {
      connectionId: 'ws-anon-1',
      transport: 'ws',
      isAuthenticated: false,
      clientIp: '203.0.113.50',
      socketPeerIp: '10.0.0.8',
    };

    const error = await applyRateLimit(ctx, 5, 'createSession').catch((caughtError: unknown) => caughtError);

    expect(error).toBeInstanceOf(GraphQLError);
    expect((error as GraphQLError).extensions).toMatchObject({
      code: 'RATE_LIMITED',
      operation: 'createSession',
      retryAfterSeconds: 17,
    });
    expect(mockCheckRateLimitRedis).toHaveBeenNthCalledWith(2, 'socket-peer:10.0.0.8', 'createSession', 600, 60_000, {
      fallbackToMemory: true,
    });
  });

  it('passes non-rate-limit errors through untouched', async () => {
    const boom = new Error('redis exploded');
    mockCheckRateLimit.mockImplementationOnce(() => {
      throw boom;
    });
    const ctx: ConnectionContext = { connectionId: 'ws-2', isAuthenticated: false };

    await expect(applyRateLimit(ctx, RATE_LIMIT_SESSION, 'session')).rejects.toBe(boom);
  });

  it('gives interactive session + playback traffic far more headroom than the 60/min default', () => {
    // The crux of the fix: queue/wall mutations and playback no longer share the
    // 60/min `default` bucket that a two-person session exhausted by switching.
    expect(RATE_LIMIT_SESSION).toBeGreaterThanOrEqual(1200);
    expect(RATE_LIMIT_PLAYBACK).toBeGreaterThanOrEqual(3600);
  });

  it('keeps session lifecycle traffic out of the shared default bucket', () => {
    // Native Live Activity keeps its own websocket and rejoins on reconnect.
    // Those joins must not spend the same `default` bucket that createSession
    // previously used, or websocket churn can make a later explicit Start fail.
    expect(RATE_LIMIT_JOIN_SESSION_OP).toBe('joinSession');
    expect(RATE_LIMIT_CREATE_SESSION_OP).toBe('createSession');
    expect(RATE_LIMIT_END_SESSION_OP).toBe('endSession');
    expect(RATE_LIMIT_CONFIRM_CLIMB_ON_WALL_OP).toBe('confirmClimbOnWall');
    expect(RATE_LIMIT_SET_QUEUE_OP).toBe('setQueue');
    expect(
      new Set([
        RATE_LIMIT_JOIN_SESSION_OP,
        RATE_LIMIT_CREATE_SESSION_OP,
        RATE_LIMIT_END_SESSION_OP,
        RATE_LIMIT_CONFIRM_CLIMB_ON_WALL_OP,
        RATE_LIMIT_SET_QUEUE_OP,
      ]).size,
    ).toBe(5);
    expect(RATE_LIMIT_JOIN_SESSION).toBeGreaterThanOrEqual(600);
    expect(RATE_LIMIT_CREATE_SESSION).toBeGreaterThanOrEqual(180);
    expect(RATE_LIMIT_END_SESSION).toBeGreaterThanOrEqual(180);
    expect(RATE_LIMIT_CONFIRM_CLIMB_ON_WALL).toBeGreaterThanOrEqual(600);
    expect(RATE_LIMIT_SET_QUEUE).toBeGreaterThanOrEqual(300);
  });
});

describe('GraphQL resolver rate-limit bucket audit', () => {
  it('requires explicit operation names for every resolver applyRateLimit call', () => {
    const resolversDir = fileURLToPath(new URL('../graphql/resolvers', import.meta.url));
    const implicitCalls = listResolverFiles(resolversDir).flatMap((file) => {
      const source = stripTypeScriptComments(readFileSync(file, 'utf8'));
      const matches = source.match(/applyRateLimit\(\s*ctx\s*(?:,\s*(?:\d+|[A-Z0-9_]+))?\s*\)/g) ?? [];
      return matches.map((match) => `${file.replace(`${resolversDir}/`, '')}: ${match}`);
    });

    expect(implicitCalls).toEqual([]);
  });
});
