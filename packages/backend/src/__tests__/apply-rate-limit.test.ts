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
