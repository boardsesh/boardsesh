import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';

type StoredSummary = { itemCount: number; lastModified: Date | null; computedAt: Date };
const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  select: vi.fn(),
  insert: vi.fn(),
  values: vi.fn(),
  upsert: vi.fn(),
  transaction: vi.fn(),
  configs: vi.fn(),
  query: vi.fn(),
  validateToken: vi.fn(),
  events: [] as string[],
  previous: null as StoredSummary | null,
  pending: null as StoredSummary | null,
}));

vi.mock('../db/client', () => ({ db: { transaction: mocks.transaction } }));
vi.mock('../services/popular-board-configs', () => ({ getPopularConfigs: mocks.configs }));
vi.mock('@boardsesh/db/queries/sitemap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/db/queries/sitemap')>()),
  runSetterSitemapQuery: mocks.query,
}));
vi.mock('../middleware/auth', () => ({ validateToken: mocks.validateToken }));
vi.mock('../graphql/index', async () => {
  const { makeExecutableSchema } = await import('@graphql-tools/schema');
  const { typeDefs } = await import('@boardsesh/shared-schema');
  const { setterSitemapMutations } = await import('../graphql/resolvers/social/setter-sitemap');
  return { schema: makeExecutableSchema({ typeDefs, resolvers: { Mutation: setterSitemapMutations } }) };
});

import { createYogaInstance } from '../graphql/yoga';
import { setterSitemapMutations } from '../graphql/resolvers/social/setter-sitemap';
import { refreshSetterSitemapSummary } from '../services/setter-sitemap-summary';
import { logger } from '../utils/logger';

const dialect = new PgDialect();
const yoga = createYogaInstance();
const tx = { execute: mocks.execute, select: mocks.select, insert: mocks.insert };
const contentClock = new Date('2026-05-04T11:22:33.000Z');
const config = {
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: [1, 20],
  climbCount: 4200,
  boardCount: 12,
};
const mutation = `mutation Refresh($force: Boolean) {
  refreshSetterSitemapSummary(force: $force) {
    refreshed itemCount lastModified computedAt skipped
  }
}`;

function requestRefresh(token: string | null = 'test-secret', force = false) {
  return yoga.fetch('http://localhost/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/graphql-response+json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ query: mutation, variables: { force } }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('CRON_SECRET', 'test-secret');
  mocks.events.length = 0;
  mocks.previous = null;
  mocks.pending = null;
  mocks.validateToken.mockResolvedValue(null);
  mocks.execute.mockImplementation(async (statement: SQL) => {
    mocks.events.push(dialect.sqlToQuery(statement).sql);
    return [{ locked: true }];
  });
  mocks.select.mockReturnValue({
    from: () => ({ where: () => ({ limit: async () => (mocks.previous ? [mocks.previous] : []) }) }),
  });
  mocks.insert.mockReturnValue({ values: mocks.values });
  mocks.values.mockImplementation((summary: StoredSummary) => {
    mocks.pending = summary;
    return { onConflictDoUpdate: mocks.upsert };
  });
  mocks.upsert.mockResolvedValue(undefined);
  mocks.transaction.mockImplementation(async (callback: (transaction: typeof tx) => Promise<unknown>) => {
    try {
      const result = await callback(tx);
      if (mocks.pending) mocks.previous = mocks.pending;
      mocks.events.push('commit');
      return result;
    } catch (error) {
      mocks.events.push('rollback');
      throw error;
    }
  });
  mocks.configs.mockResolvedValue([config]);
  mocks.query.mockImplementation(async (transaction: unknown) => {
    expect(transaction).toBe(tx);
    mocks.events.push('scan');
    return [
      { setter_username: 'alice', last_modified: contentClock.toISOString() },
      { setter_username: 'bob', last_modified: null },
    ];
  });
  vi.spyOn(logger, 'info').mockImplementation(() => logger);
  vi.spyOn(logger, 'error').mockImplementation(() => logger);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('cron-authenticated setters sitemap refresh', () => {
  it.each([null, 'wrong-secret'])('rejects bearer %s before opening a transaction', async (token) => {
    expect((await requestRefresh(token)).status).toBe(401);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('rejects a signed-in user without cron credentials', async () => {
    mocks.validateToken.mockResolvedValue({ userId: 'user-123' });
    expect((await requestRefresh('user-token')).status).toBe(401);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('rejects a WebSocket context even if it claims cron authentication', async () => {
    await expect(
      setterSitemapMutations.refreshSetterSitemapSummary({}, {}, {
        transport: 'ws',
        isCronAuthenticated: true,
      } as ConnectionContext),
    ).rejects.toMatchObject({ extensions: { code: 'UNAUTHENTICATED' } });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('stores the validated list count and actual content clock in the locked transaction', async () => {
    const response = await requestRefresh();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        refreshSetterSitemapSummary: {
          refreshed: true,
          itemCount: 2,
          lastModified: contentClock.toISOString(),
          computedAt: expect.any(String),
          skipped: null,
        },
      },
    });
    expect(mocks.events).toEqual([
      expect.stringContaining('pg_try_advisory_xact_lock'),
      'SET LOCAL max_parallel_workers_per_gather = 0',
      "SET LOCAL statement_timeout = '45s'",
      'scan',
      'commit',
    ]);
    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({
        shardId: 'setters',
        itemCount: 2,
        lastModified: contentClock,
      }),
    );
  });

  it('skips a fresh summary without fetching configs or scanning', async () => {
    mocks.previous = { itemCount: 7, lastModified: contentClock, computedAt: new Date() };
    await expect(refreshSetterSitemapSummary()).resolves.toMatchObject({
      refreshed: false,
      itemCount: 7,
      skipped: 'fresh',
    });
    expect(mocks.configs).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('refreshes a stale summary and lets force refresh one that is still fresh', async () => {
    mocks.previous = {
      itemCount: 7,
      lastModified: contentClock,
      computedAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
    };
    await expect(refreshSetterSitemapSummary()).resolves.toMatchObject({ refreshed: true, itemCount: 2 });
    await expect(refreshSetterSitemapSummary({ force: true })).resolves.toMatchObject({ refreshed: true });
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it.each([null, { itemCount: 7, lastModified: contentClock, computedAt: new Date() }])(
    'skips lock contention without scanning, with or without a previous row',
    async (previous) => {
      mocks.previous = previous;
      mocks.execute.mockResolvedValue([{ locked: false }]);
      await expect(refreshSetterSitemapSummary({ force: true })).resolves.toMatchObject({
        refreshed: false,
        itemCount: previous?.itemCount ?? null,
        skipped: 'locked',
      });
      expect(mocks.query).not.toHaveBeenCalled();
      expect(mocks.insert).not.toHaveBeenCalled();
    },
  );

  it.each([
    { rows: [] },
    { rows: [{ setter_username: '\uD800', last_modified: null }] },
    { rows: [{ setter_username: 'alice', last_modified: 'invalid' }] },
  ])('keeps the last good row when force computes an invalid list', async ({ rows }) => {
    const previous = { itemCount: 7, lastModified: contentClock, computedAt: new Date() };
    mocks.previous = previous;
    mocks.query.mockResolvedValue(rows);
    await expect(refreshSetterSitemapSummary({ force: true })).rejects.toThrow('empty or incomplete');
    expect(mocks.previous).toBe(previous);
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.events).toContain('rollback');
  });

  it('does not overwrite the previous row when the config cache is empty', async () => {
    const previous = { itemCount: 7, lastModified: contentClock, computedAt: new Date() };
    mocks.previous = previous;
    mocks.configs.mockResolvedValue([]);
    await expect(refreshSetterSitemapSummary({ force: true })).rejects.toThrow('public board catalogue');
    expect(mocks.previous).toBe(previous);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it.each(['query', 'upsert'] as const)('rolls back and sanitizes a %s failure', async (phase) => {
    const previous = { itemCount: 7, lastModified: contentClock, computedAt: new Date() };
    mocks.previous = previous;
    mocks[phase].mockRejectedValue(new Error('private database details'));
    const response = await requestRefresh('test-secret', true);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ errors: [{ message: 'Setters sitemap summary refresh failed' }] });
    expect(mocks.previous).toBe(previous);
    expect(mocks.events).toContain('rollback');
    expect(mocks.events).not.toContain('commit');
  });
});
