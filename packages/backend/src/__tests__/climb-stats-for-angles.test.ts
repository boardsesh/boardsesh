import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// Mock the live-stats query: capture what the resolver selects and feed it
// canned rows. The chain mirrors primary db.select().from().where().orderBy().
// The batch resolver's alias lookup (a selection carrying `aliasUuid`) gets its
// own chain ending at where(), so `whereMock` stays the stats query's filter.
const { selectRows, dbMock, dbReadMock, whereMock, aliasWhereMock } = vi.hoisted(() => {
  const state: { rows: unknown[]; aliasRows: unknown[] } = { rows: [], aliasRows: [] };
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn((_whereClause: unknown) => chain),
    orderBy: vi.fn(async () => state.rows),
  };
  const aliasChain = {
    from: vi.fn(() => aliasChain),
    where: vi.fn(async (_whereClause: unknown) => state.aliasRows),
  };
  // Match the alias lookup's exact selection, so a stats selection that ever
  // gains an `aliasUuid` field still routes to the stats chain.
  const isAliasSelection = (selection: unknown) =>
    typeof selection === 'object' &&
    selection !== null &&
    Object.keys(selection).sort().join(',') === 'aliasUuid,canonicalUuid';
  return {
    selectRows: state,
    dbMock: { select: vi.fn((selection: unknown) => (isAliasSelection(selection) ? aliasChain : chain)) },
    dbReadMock: { select: vi.fn() },
    whereMock: chain.where,
    aliasWhereMock: aliasChain.where,
  };
});

vi.mock('../db/client', () => ({
  db: dbMock,
  dbRead: dbReadMock,
}));

// Deterministic grade labels so we assert the mapping, not the grade table.
// Partial mock — keep every other export intact (validation schemas pull
// constants like MAX_SEARCH_PAGE from this module).
vi.mock('@boardsesh/db/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/db/queries')>();
  return {
    ...actual,
    getGradeLabel: (id: number | null) => (id == null ? '' : `V${id}`),
  };
});

// Spy on the shared rate-limit helper (keep validateInput and everything else
// real). Lets us assert the resolver enforces a limit without coupling to the
// limiter's module-global counter or NODE_ENV.
vi.mock('../graphql/resolvers/shared/helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../graphql/resolvers/shared/helpers')>();
  return { ...actual, applyRateLimit: vi.fn(async () => {}) };
});

import { climbQueries } from '../graphql/resolvers/climbs/queries';
import { applyRateLimit } from '../graphql/resolvers/shared/helpers';
import type { ConnectionContext } from '@boardsesh/shared-schema';

const applyRateLimitMock = vi.mocked(applyRateLimit);

// Anonymous HTTP-style context: only the in-memory rate-limit tier runs (the
// Redis tier is gated on authenticated users), so no infra is needed.
const ctx = { isAuthenticated: false, connectionId: 'test-conn' } as unknown as ConnectionContext;
const authenticatedCtx = {
  isAuthenticated: true,
  userId: 'user-1',
  connectionId: 'test-auth-conn',
} as unknown as ConnectionContext;

const callResolver = (boardName: string, climbUuid: string) =>
  climbQueries.climbStatsForAngles(undefined, { boardName, climbUuid }, ctx);
const callBatchResolver = (boardName: string, climbUuids: string[], context = authenticatedCtx) =>
  climbQueries.climbStatsForClimbs(undefined, { boardName, climbUuids }, context);

describe('climbStatsForAngles resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectRows.rows = [];
  });

  it('labels difficulty from rounded displayDifficulty and passes fa fields through', async () => {
    selectRows.rows = [
      {
        angle: 40,
        ascensionistCount: 12,
        qualityAverage: 3.5,
        difficultyAverage: 20.4,
        displayDifficulty: 20.6,
        syncSeq: '90071992547409930',
        faUsername: 'Alice',
        faAt: '2024-01-02T00:00:00Z',
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
        difficulty: 'V21', // round(20.6) -> 21
        syncSeq: '90071992547409930',
        faUsername: 'Alice',
        faAt: '2024-01-02T00:00:00Z',
      },
    ]);
  });

  it('returns null difficulty when displayDifficulty is null', async () => {
    selectRows.rows = [
      {
        angle: 30,
        ascensionistCount: 0,
        qualityAverage: null,
        difficultyAverage: null,
        displayDifficulty: null,
        syncSeq: '2',
        faUsername: null,
        faAt: null,
      },
    ];

    const [entry] = await callResolver('tension', 'CLIMB-2');

    expect(entry.difficulty).toBeNull();
    expect(entry.displayDifficulty).toBeNull();
  });

  it('returns an empty array for a climb with no logged angles', async () => {
    selectRows.rows = [];

    const result = await callResolver('kilter', 'CLIMB-NONE');

    expect(result).toEqual([]);
    expect(dbMock.select).toHaveBeenCalledTimes(1);
  });

  it('applies a 60/min rate limit for this operation before querying', async () => {
    await callResolver('kilter', 'CLIMB-1');

    expect(applyRateLimitMock).toHaveBeenCalledWith(ctx, 60, 'climb-stats-for-angles');
  });

  it('propagates a rate-limit rejection without touching the DB', async () => {
    applyRateLimitMock.mockRejectedValueOnce(new Error('RATE_LIMITED'));

    await expect(callResolver('kilter', 'CLIMB-1')).rejects.toThrow('RATE_LIMITED');
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('rejects an unknown board name', async () => {
    await expect(callResolver('notaboard', 'CLIMB-1')).rejects.toThrow();
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('rejects an empty climb uuid', async () => {
    await expect(callResolver('kilter', '')).rejects.toThrow();
    expect(dbMock.select).not.toHaveBeenCalled();
  });
});

describe('climbStatsForClimbs resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectRows.rows = [];
    selectRows.aliasRows = [];
  });

  it('rejects an empty UUID batch', async () => {
    await expect(callBatchResolver('kilter', [])).rejects.toThrow();
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('rejects a batch above 50 UUIDs', async () => {
    const climbUuids = Array.from({ length: 51 }, (_, index) => `CLIMB-${index}`);
    await expect(callBatchResolver('kilter', climbUuids)).rejects.toThrow();
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('accepts exactly 50 UUIDs in one alias lookup and one stats query', async () => {
    const climbUuids = Array.from({ length: 50 }, (_, index) => `CLIMB-${index}`);

    await expect(callBatchResolver('kilter', climbUuids)).resolves.toEqual([]);

    expect(dbMock.select).toHaveBeenCalledTimes(2);
    expect(aliasWhereMock).toHaveBeenCalledTimes(1);
    expect(whereMock).toHaveBeenCalledTimes(1);
    const { params } = new PgDialect().sqlToQuery(whereMock.mock.calls[0]?.[0] as SQL);
    for (const climbUuid of climbUuids) expect(params).toContain(climbUuid);
  });

  it('requires authentication before spending the shared rate-limit bucket', async () => {
    await expect(callBatchResolver('kilter', ['CLIMB-1'], ctx)).rejects.toThrow('Authentication required');
    expect(applyRateLimitMock).not.toHaveBeenCalled();
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('dedupes UUIDs into one primary IN query', async () => {
    await callBatchResolver('kilter', ['CLIMB-1', 'CLIMB-1', 'CLIMB-2']);

    expect(dbMock.select).toHaveBeenCalledTimes(2);
    expect(dbReadMock.select).not.toHaveBeenCalled();
    expect(whereMock).toHaveBeenCalledTimes(1);
    const { params } = new PgDialect().sqlToQuery(whereMock.mock.calls[0]?.[0] as SQL);
    expect(params.filter((parameter) => parameter === 'CLIMB-1')).toHaveLength(1);
    expect(params.filter((parameter) => parameter === 'CLIMB-2')).toHaveLength(1);
  });

  it('returns climb routing, bigint text, and labelled angle stats', async () => {
    selectRows.rows = [
      {
        climbUuid: 'CLIMB-1',
        angle: 40,
        ascensionistCount: 12,
        qualityAverage: 3.5,
        difficultyAverage: 20.4,
        displayDifficulty: 20.6,
        syncSeq: '90071992547409930',
        faUsername: 'Alice',
        faAt: '2024-01-02T00:00:00Z',
      },
    ];

    await expect(callBatchResolver('kilter', ['CLIMB-1'])).resolves.toEqual([
      expect.objectContaining({
        climbUuid: 'CLIMB-1',
        angle: 40,
        difficulty: 'V21',
        syncSeq: '90071992547409930',
      }),
    ]);

    // calls[0] is the alias lookup; calls[1] is the stats read.
    const selection = dbMock.select.mock.calls[1]?.[0] as { syncSeq: SQL };
    const { sql: syncSeqSql } = new PgDialect().sqlToQuery(selection.syncSeq);
    expect(syncSeqSql).toContain('::text');
  });

  it('uses the legacy climb-stats-for-angles bucket exactly once for the batch', async () => {
    await callBatchResolver('tension', ['CLIMB-1', 'CLIMB-2']);

    expect(applyRateLimitMock).toHaveBeenCalledTimes(1);
    expect(applyRateLimitMock).toHaveBeenCalledWith(authenticatedCtx, 60, 'climb-stats-for-angles');
  });
});
