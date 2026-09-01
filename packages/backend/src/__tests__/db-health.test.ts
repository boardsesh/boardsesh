import { describe, expect, it, beforeEach, vi } from 'vite-plus/test';
import type { IncomingMessage, ServerResponse } from 'http';

const pubsubMock = vi.hoisted(() => ({
  isRedisRequired: vi.fn(() => false),
  isRedisConnected: vi.fn(() => true),
}));

vi.mock('../pubsub/index', () => ({ pubsub: pubsubMock }));

import { handleDatabaseHealthCheck, handleHealthCheck } from '../handlers/health';
import { BUILD_RELEASE } from '../build-release';
import { getDbConnectRetryStats, probeDatabase, recordDbConnectRetry, resetDbHealthState } from '../services/db-health';

type FakeQuery = {
  settle: (value: unknown) => void;
  fail: (error: unknown) => void;
  cancelled: boolean;
  promise: Promise<unknown>;
};

function fakePool() {
  const queries: FakeQuery[] = [];
  const pool = {
    unsafe(_statement: string) {
      let settle: (value: unknown) => void = () => {};
      let fail: (error: unknown) => void = () => {};
      const promise = new Promise<unknown>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      });
      const record: FakeQuery = { settle, fail, cancelled: false, promise };
      queries.push(record);
      return {
        then: (onFulfilled: unknown, onRejected: unknown) =>
          promise.then(onFulfilled as (value: unknown) => unknown, onRejected as (reason: unknown) => unknown),
        cancel: () => {
          record.cancelled = true;
          record.fail(Object.assign(new Error('canceling statement due to user request'), { code: '57014' }));
        },
      };
    },
    queries,
  };
  return pool;
}

function fakeResponse() {
  const state = { statusCode: 0, body: '', headers: {} as Record<string, string> };
  const res = {
    setHeader: () => {},
    writeHead: (statusCode: number, headers: Record<string, string> = {}) => {
      state.statusCode = statusCode;
      state.headers = headers;
      return res;
    },
    end: (chunk?: string) => {
      state.body = chunk ?? '';
      return res;
    },
    headersSent: false,
  };
  return { res: res as unknown as ServerResponse, state };
}

const fakeRequest = { method: 'GET', headers: {} } as unknown as IncomingMessage;

beforeEach(() => {
  resetDbHealthState();
  pubsubMock.isRedisRequired.mockReturnValue(false);
  pubsubMock.isRedisConnected.mockReturnValue(true);
});

describe('probeDatabase', () => {
  it('reports the round trip when Postgres answers', async () => {
    const pool = fakePool();
    let clock = 1_000;
    const pending = probeDatabase({ getPool: () => pool as never, now: () => clock });

    clock = 1_012;
    pool.queries[0]!.settle([{ '?column?': 1 }]);

    await expect(pending).resolves.toMatchObject({ reachable: true, latencyMs: 12, error: null });
  });

  it('caches within the TTL and re-probes after it', async () => {
    const pool = fakePool();
    let clock = 0;

    const first = probeDatabase({ getPool: () => pool as never, now: () => clock, ttlMs: 5_000 });
    pool.queries[0]!.settle([]);
    await first;

    clock = 4_000;
    await probeDatabase({ getPool: () => pool as never, now: () => clock, ttlMs: 5_000 });
    expect(pool.queries).toHaveLength(1);

    clock = 6_000;
    const third = probeDatabase({ getPool: () => pool as never, now: () => clock, ttlMs: 5_000 });
    expect(pool.queries).toHaveLength(2);
    pool.queries[1]!.settle([]);
    await third;
  });

  it('de-duplicates concurrent callers into a single query', async () => {
    const pool = fakePool();
    const first = probeDatabase({ getPool: () => pool as never });
    const second = probeDatabase({ getPool: () => pool as never });

    expect(pool.queries).toHaveLength(1);
    pool.queries[0]!.settle([]);

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(secondResult);
  });

  it('gives up on the deadline and cancels the abandoned query', async () => {
    vi.useFakeTimers();
    try {
      const pool = fakePool();
      const pending = probeDatabase({ getPool: () => pool as never, deadlineMs: 2_000 });

      await vi.advanceTimersByTimeAsync(2_000);
      const health = await pending;

      expect(health).toMatchObject({ reachable: false, latencyMs: null });
      expect(health.error).toContain('2000ms');
      // Without cancel() the `select 1` sits in postgres.js's queue forever and
      // fires whenever the pool recovers.
      expect(pool.queries[0]!.cancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports only the error code, never the statement', async () => {
    const pool = fakePool();
    const pending = probeDatabase({ getPool: () => pool as never });
    pool.queries[0]!.fail(
      Object.assign(new Error('write CONNECT_TIMEOUT postgis.railway.internal:5432'), {
        code: 'CONNECT_TIMEOUT',
        query: 'select 1',
      }),
    );

    await expect(pending).resolves.toMatchObject({ reachable: false, error: 'CONNECT_TIMEOUT' });
  });

  it('reports unreachable when the pool itself cannot be built', async () => {
    await expect(
      probeDatabase({
        getPool: () => {
          throw Object.assign(new Error('DATABASE_URL is required'), { code: 'ENOTFOUND' });
        },
      }),
    ).resolves.toMatchObject({ reachable: false, error: 'ENOTFOUND' });
  });
});

describe('connect retry counters', () => {
  it('counts retries and remembers the last code', () => {
    expect(getDbConnectRetryStats()).toEqual({ count: 0, lastRetryAt: null, lastCode: null });

    recordDbConnectRetry({ attempt: 1, maxAttempts: 3, delayMs: 150, elapsedMs: 5, code: 'EAI_AGAIN' }, () => 42);

    expect(getDbConnectRetryStats()).toEqual({ count: 1, lastRetryAt: 42, lastCode: 'EAI_AGAIN' });
  });
});

describe('GET /health', () => {
  it('reports stamped release and Railway deployment identity', async () => {
    const previousDeploymentId = process.env.RAILWAY_DEPLOYMENT_ID;
    const previousRuntimeRelease = process.env.SENTRY_RELEASE;
    try {
      process.env.RAILWAY_DEPLOYMENT_ID = '12345678-1234-4234-8234-123456789abc';
      process.env.SENTRY_RELEASE = 'runtime-settings-cannot-change-the-build';
      const pool = fakePool();
      const probe = probeDatabase({ getPool: () => pool as never });
      pool.queries[0]!.settle([]);
      await probe;

      const { res, state } = fakeResponse();
      await handleHealthCheck(fakeRequest, res);

      expect(JSON.parse(state.body)).toMatchObject({
        deploymentId: '12345678-1234-4234-8234-123456789abc',
        release: BUILD_RELEASE,
      });
      expect(state.headers['Cache-Control']).toBe('no-store');
    } finally {
      if (previousDeploymentId === undefined) delete process.env.RAILWAY_DEPLOYMENT_ID;
      else process.env.RAILWAY_DEPLOYMENT_ID = previousDeploymentId;
      if (previousRuntimeRelease === undefined) delete process.env.SENTRY_RELEASE;
      else process.env.SENTRY_RELEASE = previousRuntimeRelease;
    }
  });

  it('stays 200 with database.reachable false when Postgres is down', async () => {
    const pool = fakePool();
    const probe = probeDatabase({ getPool: () => pool as never });
    pool.queries[0]!.fail(Object.assign(new Error('down'), { code: 'ECONNREFUSED' }));
    await probe;

    const { res, state } = fakeResponse();
    await handleHealthCheck(fakeRequest, res);

    // Regression guard: /health is polled by the e2e workflow, the dev
    // orchestrator and the branch-deploy compose healthcheck. Gating it on
    // Postgres would strand all three on a blip.
    expect(state.statusCode).toBe(200);
    const payload = JSON.parse(state.body);
    expect(payload.status).toBe('healthy');
    expect(payload.database.reachable).toBe(false);
    expect(payload.database.error).toBe('ECONNREFUSED');
  });

  it('still returns 503 when Redis is required and disconnected', async () => {
    const pool = fakePool();
    const probe = probeDatabase({ getPool: () => pool as never });
    pool.queries[0]!.settle([]);
    await probe;

    pubsubMock.isRedisRequired.mockReturnValue(true);
    pubsubMock.isRedisConnected.mockReturnValue(false);

    const { res, state } = fakeResponse();
    await handleHealthCheck(fakeRequest, res);

    expect(state.statusCode).toBe(503);
    expect(JSON.parse(state.body).database.reachable).toBe(true);
  });
});

describe('GET /health/db', () => {
  it('returns 200 when Postgres answers and 503 when it does not', async () => {
    const reachablePool = fakePool();
    const reachableProbe = probeDatabase({ getPool: () => reachablePool as never });
    reachablePool.queries[0]!.settle([]);
    await reachableProbe;

    const healthy = fakeResponse();
    await handleDatabaseHealthCheck(fakeRequest, healthy.res);
    expect(healthy.state.statusCode).toBe(200);
    expect(healthy.state.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(healthy.state.body).status).toBe('healthy');

    resetDbHealthState();
    const deadPool = fakePool();
    const deadProbe = probeDatabase({ getPool: () => deadPool as never });
    deadPool.queries[0]!.fail(Object.assign(new Error('down'), { code: 'EAI_AGAIN' }));
    await deadProbe;

    const unhealthy = fakeResponse();
    await handleDatabaseHealthCheck(fakeRequest, unhealthy.res);
    expect(unhealthy.state.statusCode).toBe(503);
    expect(unhealthy.state.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(unhealthy.state.body).database.error).toBe('EAI_AGAIN');
  });
});
