import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { getTableName, type SQL, type Table } from 'drizzle-orm';

/**
 * `climbStatsHistory` used to read up to twelve months of rows from
 * `board_climb_stats_history` (a mean of 1,320 scattered heap rows per call,
 * 2.9 s cold on a popular Kilter climb), and every live caller kept only the
 * newest row per angle. It now reads the current row per angle from
 * `board_climb_stats`. The GraphQL shape is unchanged, so these pin the shape
 * as well as the table.
 */
const { selectRows, dbMock, fromMock, whereMock } = vi.hoisted(() => {
  const state: { rows: unknown[] } = { rows: [] };
  const chain = {
    from: vi.fn((_table: unknown) => chain),
    where: vi.fn((_whereClause: unknown) => chain),
    orderBy: vi.fn(async () => state.rows),
  };
  return {
    selectRows: state,
    dbMock: { select: vi.fn((_selection: unknown) => chain) },
    fromMock: chain.from,
    whereMock: chain.where,
  };
});

vi.mock('../db/client', () => ({ db: dbMock, dbRead: { select: vi.fn() } }));

vi.mock('../graphql/resolvers/shared/helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../graphql/resolvers/shared/helpers')>();
  return { ...actual, applyRateLimit: vi.fn(async () => {}) };
});

import { climbQueries } from '../graphql/resolvers/climbs/queries';
import { applyRateLimit } from '../graphql/resolvers/shared/helpers';
import type { ConnectionContext } from '@boardsesh/shared-schema';

const applyRateLimitMock = vi.mocked(applyRateLimit);
const ctx = { isAuthenticated: false, connectionId: 'test-conn' } as unknown as ConnectionContext;
const dialect = new PgDialect();

const callResolver = (boardName: string, climbUuid: string) =>
  climbQueries.climbStatsHistory(undefined, { boardName, climbUuid }, ctx);

describe('climbStatsHistory resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectRows.rows = [];
  });

  it('reads the live per-angle stats table, not the history table', async () => {
    await callResolver('kilter', 'CLIMB-1');

    expect(getTableName(fromMock.mock.calls[0][0] as Table)).toBe('board_climb_stats');
    const rendered = dialect.sqlToQuery(whereMock.mock.calls[0][0] as SQL).sql;
    expect(rendered).toContain('"board_climb_stats"."ascensionist_count" >');
    expect(rendered).not.toContain('board_climb_stats_history');
    expect(rendered).not.toContain('created_at');
  });

  it('keeps the spray visibility predicate on the stats row', async () => {
    await callResolver('spray', 'CLIMB-1');

    const rendered = dialect.sqlToQuery(whereMock.mock.calls[0][0] as SQL).sql;
    expect(rendered).toContain('spray_walls');
  });

  it('returns the old entry shape with updated_at as an ISO createdAt', async () => {
    selectRows.rows = [
      {
        angle: 40,
        ascensionistCount: 12,
        qualityAverage: 3.5,
        difficultyAverage: 20.4,
        displayDifficulty: 20.6,
        updatedAt: new Date('2026-09-25T03:00:00.000Z'),
      },
    ];

    const result = await callResolver('kilter', 'CLIMB-1');

    expect(result).toEqual([
      {
        angle: 40,
        ascensionistCount: 12,
        qualityAverage: 3.5,
        difficultyAverage: 20.4,
        displayDifficulty: 20.6,
        createdAt: '2026-09-25T03:00:00.000Z',
      },
    ]);
  });

  it('rate-limits in its own bucket before querying', async () => {
    await callResolver('kilter', 'CLIMB-1');

    expect(applyRateLimitMock).toHaveBeenCalledWith(ctx, 60, 'climb-stats-history');
  });

  it('propagates a rate-limit rejection without touching the DB', async () => {
    applyRateLimitMock.mockRejectedValueOnce(new Error('RATE_LIMITED'));

    await expect(callResolver('kilter', 'CLIMB-1')).rejects.toThrow('RATE_LIMITED');
    expect(dbMock.select).not.toHaveBeenCalled();
  });
});
