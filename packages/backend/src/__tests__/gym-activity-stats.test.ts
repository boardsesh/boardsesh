import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  select: vi.fn(),
  from: vi.fn(),
  transaction: vi.fn(),
  count: vi.fn(),
  rebuild: vi.fn(),
  validateToken: vi.fn(),
  events: [] as string[],
}));

vi.mock('../db/client', () => ({ db: { transaction: mocks.transaction } }));
vi.mock('@boardsesh/db/queries', () => ({
  GYM_ACTIVITY_REFRESH_LOCK_KEY: 0x67796d61,
  countGymsWithActivity: mocks.count,
  rebuildGymActivityStats: mocks.rebuild,
}));
vi.mock('../middleware/auth', () => ({ validateToken: mocks.validateToken }));
// Keep the real HTTP transport, context builder, schema and refresh resolver;
// unrelated domain resolvers do not participate in this job.
vi.mock('../graphql/index', async () => {
  const { makeExecutableSchema } = await import('@graphql-tools/schema');
  const { typeDefs } = await import('@boardsesh/shared-schema');
  const { gymActivityStatsMutations } = await import('../graphql/resolvers/social/gym-activity-stats');
  return { schema: makeExecutableSchema({ typeDefs, resolvers: { Mutation: gymActivityStatsMutations } }) };
});

import { buildHttpConnectionContext, createYogaInstance } from '../graphql/yoga';
import { gymActivityStatsMutations } from '../graphql/resolvers/social/gym-activity-stats';
import { logger } from '../utils/logger';

const tx = { execute: mocks.execute, select: mocks.select };
const yoga = createYogaInstance();
const QUERY = `mutation Refresh($force: Boolean) {
  refreshGymActivityStats(force: $force) {
    gymCount previousGymCount forced scanDurationMs writeDurationMs durationMs timestamp
  }
}`;

function refresh({ token = 'test-secret', force = false }: { token?: string | null; force?: boolean | null } = {}) {
  return yoga.fetch('http://localhost/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/graphql-response+json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ query: QUERY, variables: { force } }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('CRON_SECRET', 'test-secret');
  mocks.events.length = 0;
  mocks.validateToken.mockResolvedValue(null);
  mocks.select.mockReturnValue({ from: mocks.from });
  mocks.from.mockImplementation(async () => {
    mocks.events.push('previous');
    return [{ gymCount: 100 }];
  });
  mocks.execute.mockImplementation(async () => {
    mocks.events.push('lock');
    return [{ locked: true }];
  });
  mocks.count.mockImplementation(async () => {
    mocks.events.push('count');
    return 90;
  });
  mocks.rebuild.mockImplementation(async () => {
    mocks.events.push('write');
    return 90;
  });
  mocks.transaction.mockImplementation(async (callback: (transaction: typeof tx) => Promise<unknown>) => {
    try {
      const result = await callback(tx);
      mocks.events.push('commit');
      return result;
    } catch (error) {
      mocks.events.push('rollback');
      throw error;
    }
  });
  vi.spyOn(logger, 'info').mockImplementation(() => logger);
  vi.spyOn(logger, 'error').mockImplementation(() => logger);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('cron-authenticated gym activity GraphQL refresh', () => {
  it.each([null, 'wrong-token', 'test-secreu'])('rejects token %s before opening a transaction', async (token) => {
    const response = await refresh({ token });
    expect(response.status).toBe(401);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each(['', '   '])('fails closed when CRON_SECRET is blank (%j)', async (secret) => {
    vi.stubEnv('CRON_SECRET', secret);
    expect((await refresh()).status).toBe(401);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('does not grant cron privileges to an authenticated user', async () => {
    mocks.validateToken.mockResolvedValue({ userId: 'user-123', isAuthenticated: true });
    expect((await refresh({ token: 'user-token' })).status).toBe(401);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('does not turn cron credentials into a user session', async () => {
    const context = await buildHttpConnectionContext({
      request: new Request('http://localhost/graphql', {
        headers: { authorization: 'Bearer test-secret' },
      }),
    });
    expect(context).toMatchObject({ transport: 'http', isCronAuthenticated: true, isAuthenticated: false });
    expect(context.userId).toBeUndefined();
    expect(mocks.validateToken).not.toHaveBeenCalled();
  });

  it('rejects WebSocket contexts even with a cron flag', async () => {
    await expect(
      gymActivityStatsMutations.refreshGymActivityStats(
        {},
        {},
        {
          connectionId: 'ws-test',
          transport: 'ws',
          isCronAuthenticated: true,
        },
      ),
    ).rejects.toMatchObject({ extensions: { code: 'UNAUTHENTICATED' } });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('locks before reading either guard input and uses one repeatable snapshot', async () => {
    const response = await refresh();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        refreshGymActivityStats: {
          gymCount: 90,
          previousGymCount: 100,
          forced: false,
        },
      },
    });
    expect(mocks.events).toEqual(['lock', 'previous', 'count', 'write', 'commit']);
    const lockQuery = new PgDialect().sqlToQuery(mocks.execute.mock.calls[0][0] as SQL);
    expect(lockQuery.sql).toContain('pg_try_advisory_xact_lock');
    expect(lockQuery.params).toEqual([0x67796d61]);
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'repeatable read' });
    expect(mocks.count).toHaveBeenCalledWith(tx);
    expect(mocks.rebuild).toHaveBeenCalledWith(tx);
  });

  it.each([false, true])('returns HTTP 409 without scanning on lock contention (force=%s)', async (force) => {
    mocks.execute.mockResolvedValue([{ locked: false }]);
    const response = await refresh({ force });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ errors: [{ extensions: { code: 'CONFLICT', skipped: 'locked' } }] });
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.count).not.toHaveBeenCalled();
    expect(mocks.rebuild).not.toHaveBeenCalled();
  });

  it.each([false, true])('refuses an empty result (force=%s)', async (force) => {
    mocks.count.mockResolvedValue(0);
    const response = await refresh({ force });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ errors: [{ extensions: { skipped: 'empty' } }] });
    expect(mocks.rebuild).not.toHaveBeenCalled();
  });

  it.each([false, null])('refuses a shrink over 50% (force=%s)', async (force) => {
    mocks.count.mockResolvedValue(49);
    const response = await refresh({ force });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ errors: [{ extensions: { skipped: 'shrank', forced: false } }] });
    expect(mocks.rebuild).not.toHaveBeenCalled();
  });

  it.each([
    { previous: 100, counted: 50, force: false },
    { previous: 0, counted: 1, force: false },
    { previous: 100, counted: 1, force: true },
  ])('allows the boundary, first population, or forced shrink: %j', async ({ previous, counted, force }) => {
    mocks.from.mockResolvedValue([{ gymCount: previous }]);
    mocks.count.mockResolvedValue(counted);
    mocks.rebuild.mockResolvedValue(counted);
    const response = await refresh({ force });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { refreshGymActivityStats: { gymCount: counted, forced: force } },
    });
  });

  it('reports scan, write and total time including commit separately', async () => {
    let clockMs = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => clockMs);
    mocks.execute.mockImplementation(async () => {
      clockMs += 10;
      return [{ locked: true }];
    });
    mocks.count.mockImplementation(async () => {
      clockMs += 40;
      return 90;
    });
    mocks.rebuild.mockImplementation(async () => {
      clockMs += 200;
      return 90;
    });
    mocks.transaction.mockImplementation(async (callback: (transaction: typeof tx) => Promise<unknown>) => {
      const result = await callback(tx);
      clockMs += 5;
      return result;
    });
    const response = await refresh();
    expect(await response.json()).toMatchObject({
      data: {
        refreshGymActivityStats: {
          scanDurationMs: 40,
          writeDurationMs: 200,
          durationMs: 255,
        },
      },
    });
    expect(logger.info).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ durationMs: 255 }));
  });

  it.each(['execute', 'from', 'count', 'rebuild'] as const)('rolls back and sanitizes a %s failure', async (phase) => {
    mocks[phase].mockRejectedValue(new Error('private database details'));
    const response = await refresh();
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({ errors: [{ message: 'Gym activity stats refresh failed' }] });
    expect(JSON.stringify(body)).not.toContain('private database details');
    expect(mocks.events).toContain('rollback');
    expect(mocks.events).not.toContain('commit');
  });
});
