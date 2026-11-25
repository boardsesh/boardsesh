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
import { logger } from '../utils/logger';

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

  it('shares anonymous HTTP limits through Redis', async () => {
    const ctx: ConnectionContext = {
      connectionId: 'http-abc-123',
      transport: 'http',
      isAuthenticated: false,
      userId: undefined,
      trustedClientIp: '203.0.113.50',
    };

    await applyRateLimit(ctx, 5, 'createSession');

    expect(mockCheckRateLimit).toHaveBeenCalledWith('ip:203.0.113.50:createSession', 5);
    expect(mockCheckRateLimitRedis).toHaveBeenCalledWith('ip:203.0.113.50', 'createSession', 5, 60_000, {
      fallbackToMemory: false,
    });
  });

  it('adds a high-ceiling distributed TCP-peer bucket for anonymous WebSocket callers', async () => {
    const ctx: ConnectionContext = {
      connectionId: 'ws-anon-123',
      transport: 'ws',
      isAuthenticated: false,
      trustedClientIp: '203.0.113.50',
      socketPeerIp: '10.0.0.8',
    };

    await applyRateLimit(ctx, 5, 'createSession');

    expect(mockCheckRateLimit).toHaveBeenCalledWith('ip:203.0.113.50:createSession', 5);
    expect(mockCheckRateLimitRedis.mock.calls).toEqual([
      ['ip:203.0.113.50', 'createSession', 5, 60_000, { fallbackToMemory: false }],
      ['socket-peer:10.0.0.8', 'createSession', 600, 60_000, { fallbackToMemory: true }],
    ]);
  });

  it.each(['http', 'ws'] as const)('ignores forged legacy IPs across %s requests', async (transport) => {
    const firstContext: ConnectionContext = {
      connectionId: 'ws-anon-1',
      transport,
      isAuthenticated: false,
      clientIp: '203.0.113.1',
      trustedClientIp: '198.51.100.10',
      socketPeerIp: '10.0.0.8',
    };
    const secondContext: ConnectionContext = {
      ...firstContext,
      connectionId: 'ws-anon-2',
      clientIp: '203.0.113.2',
    };

    await applyRateLimit(firstContext, 5, 'createSession');
    await applyRateLimit(secondContext, 5, 'createSession');

    expect(mockCheckRateLimit.mock.calls).toEqual([
      ['ip:198.51.100.10:createSession', 5],
      ['ip:198.51.100.10:createSession', 5],
    ]);
    const identityCalls = mockCheckRateLimitRedis.mock.calls.filter(([identity]) => identity === 'ip:198.51.100.10');
    expect(identityCalls).toHaveLength(2);
    expect(identityCalls[0]).toEqual(identityCalls[1]);
  });

  it('attributes server-rendered catalog requests to their verified visitor', async () => {
    await applyRateLimit(
      {
        connectionId: 'ssr-request',
        transport: 'http',
        isAuthenticated: false,
        catalogClientIp: '203.0.113.20',
        trustedClientIp: '198.51.100.10',
      },
      120,
      'search-climbs',
    );
    expect(mockCheckRateLimitRedis).toHaveBeenCalledWith('ip:203.0.113.20', 'search-climbs', 120, 60_000, {
      fallbackToMemory: false,
    });
  });

  it('gives only verified anonymous cache work a bounded service allowance', async () => {
    for (const attribution of ['server-cache', undefined]) {
      await applyRateLimit(
        {
          connectionId: 'cache',
          isAuthenticated: false,
          catalogClientIp: attribution,
          clientIp: 'server-cache',
          trustedClientIp: '203.0.113.20',
        },
        120,
        'search-climbs',
      );
    }
    expect(mockCheckRateLimit.mock.calls).toEqual([
      ['ip:server-cache:search-climbs', 600],
      ['ip:203.0.113.20:search-climbs', 120],
    ]);
  });

  it('does not apply the anonymous peer ceiling to authenticated WebSocket callers', async () => {
    const ctx: ConnectionContext = {
      connectionId: 'ws-user-123',
      transport: 'ws',
      isAuthenticated: true,
      userId: 'user-42',
      trustedClientIp: '203.0.113.50',
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
      trustedClientIp: undefined,
      socketPeerIp: '10.0.0.8',
    };

    await applyRateLimit(ctx, 5, 'createSession');

    expect(mockCheckRateLimit).toHaveBeenCalledWith('ip:10.0.0.8:createSession', 5);
    expect(mockCheckRateLimitRedis).toHaveBeenCalledTimes(2);
    expect(mockCheckRateLimitRedis).toHaveBeenCalledWith('socket-peer:10.0.0.8', 'createSession', 600, 60_000, {
      fallbackToMemory: true,
    });
  });

  it('shares rate limit bucket across anonymous requests from the same IP', async () => {
    const ctx1: ConnectionContext = {
      connectionId: 'ws-request-1',
      transport: 'ws',
      isAuthenticated: false,
      trustedClientIp: '10.0.0.1',
    };
    const ctx2: ConnectionContext = {
      connectionId: 'ws-request-2',
      transport: 'ws',
      isAuthenticated: false,
      trustedClientIp: '10.0.0.1',
    };

    await applyRateLimit(ctx1, 5, 'createSession');
    await applyRateLimit(ctx2, 5, 'createSession');

    // Both should use the same key
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(2);
    expect(mockCheckRateLimit.mock.calls[0][0]).toBe('ip:10.0.0.1:createSession');
    expect(mockCheckRateLimit.mock.calls[1][0]).toBe('ip:10.0.0.1:createSession');
    expect(mockCheckRateLimitRedis).toHaveBeenCalledTimes(2);
  });

  it('shares both tiers across anonymous HTTP requests from the same IP', async () => {
    const firstContext: ConnectionContext = {
      connectionId: 'http-request-1',
      transport: 'http',
      isAuthenticated: false,
      trustedClientIp: '10.0.0.1',
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
    expect(mockCheckRateLimitRedis).toHaveBeenCalledTimes(2);
  });

  it('keeps every bucket key unchanged when a client identity is present', async () => {
    // Client identity is attribution only. Keying on it would give one user a
    // second budget per app, which the owner declined.
    const identityFields: Pick<ConnectionContext, 'clientIdentity' | 'clientIdentityRaw'> = {
      clientIdentity: { name: 'third-party-app', version: '9.9.9', platform: 'ios', build: '1' },
      clientIdentityRaw: 'third-party-app/9.9.9 (ios; build 1)',
    };
    const contexts: ConnectionContext[] = [
      { connectionId: 'ws-user', transport: 'ws', isAuthenticated: true, userId: 'user-42' },
      { connectionId: 'http-anon', transport: 'http', isAuthenticated: false, trustedClientIp: '203.0.113.50' },
      {
        connectionId: 'ws-anon',
        transport: 'ws',
        isAuthenticated: false,
        trustedClientIp: '203.0.113.50',
        socketPeerIp: '10.0.0.8',
      },
      { connectionId: 'ws-no-ip', isAuthenticated: false },
    ];

    const callsFor = async (withIdentity: boolean) => {
      vi.clearAllMocks();
      for (const context of contexts) {
        await applyRateLimit(withIdentity ? { ...context, ...identityFields } : context, 5, 'createSession');
      }
      return { local: [...mockCheckRateLimit.mock.calls], redis: [...mockCheckRateLimitRedis.mock.calls] };
    };

    const withoutIdentity = await callsFor(false);
    const withIdentity = await callsFor(true);

    expect(withIdentity).toEqual(withoutIdentity);
    expect(withIdentity.local.map(([identity]) => identity)).toEqual([
      'user-42:createSession',
      'ip:203.0.113.50:createSession',
      'ip:203.0.113.50:createSession',
      'ip:unknown:createSession',
    ]);
  });

  it('uses a stable unknown bucket when no verified identity is available', async () => {
    const ctx: ConnectionContext = {
      connectionId: 'ws-anon-456',
      isAuthenticated: false,
      userId: undefined,
      trustedClientIp: undefined,
    };

    await applyRateLimit(ctx, 5, 'default');

    expect(mockCheckRateLimit).toHaveBeenCalledWith('ip:unknown:default', 5);
    expect(mockCheckRateLimitRedis).toHaveBeenCalledWith('ip:unknown', 'default', 5, 60_000, {
      fallbackToMemory: false,
    });
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
      trustedClientIp: '203.0.113.50',
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

  it('logs the rejecting client so a noisy app can be traced', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    mockCheckRateLimit.mockImplementationOnce(() => {
      throw new RateLimitError(5);
    });
    const ctx: ConnectionContext = {
      connectionId: 'http-1',
      transport: 'http',
      isAuthenticated: true,
      userId: 'user-1',
      trustedClientIp: '203.0.113.9',
      clientIdentity: { name: 'boardsesh-mobile', version: '2.6.0', platform: 'ios', build: '45' },
      clientIdentityRaw: 'boardsesh-mobile/2.6.0 (ios; build 45)',
    };

    await applyRateLimit(ctx, 5, 'session').catch(() => undefined);

    expect(warnSpy).toHaveBeenCalledWith('[rate-limit] rejected', {
      operation: 'session',
      client: 'boardsesh-mobile/2.6.0 (ios; build 45)',
      userId: 'user-1',
      clientIp: '203.0.113.9',
      transport: 'http',
    });
  });

  it('logs a rejection without a client identity as unknown', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    mockCheckRateLimit.mockImplementationOnce(() => {
      throw new RateLimitError(5);
    });
    const ctx: ConnectionContext = { connectionId: 'ws-9', transport: 'ws', isAuthenticated: false };

    await applyRateLimit(ctx, 5, 'session').catch(() => undefined);

    expect(warnSpy).toHaveBeenCalledWith('[rate-limit] rejected', expect.objectContaining({ client: 'unknown' }));
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
