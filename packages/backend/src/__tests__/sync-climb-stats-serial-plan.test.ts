import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { ConnectionContext, SyncResult } from '@boardsesh/shared-schema';
import { syncQueries } from '../graphql/resolvers/sync/queries';

const { database, transactionDatabase, recordedHandles } = vi.hoisted(() => {
  const recordedHandles: string[] = [];
  const transactionDatabase = {
    execute: vi.fn((_statement: unknown) => {
      recordedHandles.push('transaction');
      return Promise.resolve([]);
    }),
  };
  const database = {
    execute: vi.fn((_statement: unknown) => {
      recordedHandles.push('database');
      return Promise.resolve([]);
    }),
    transaction: vi.fn((callback: (transactionDb: typeof transactionDatabase) => unknown) =>
      callback(transactionDatabase),
    ),
  };
  return { database, transactionDatabase, recordedHandles };
});

vi.mock('../db/client', () => ({ db: database }));

const dialect = new PgDialect();
const SERIAL_PLAN_GUARD = /SET LOCAL max_parallel_workers_per_gather\s*=\s*0/i;

function connectionContext(): ConnectionContext {
  return {
    connectionId: 'sync-stats-serial-plan',
    isAuthenticated: true,
    userId: 'user-1',
    sessionId: null,
    boardPath: null,
    controllerId: null,
    controllerApiKey: null,
  } as unknown as ConnectionContext;
}

function renderStatement(statement: unknown): string {
  return dialect.sqlToQuery(statement as SQL).sql;
}

beforeEach(() => {
  vi.clearAllMocks();
  recordedHandles.length = 0;
});

describe('syncClimbStats serial-plan guard', () => {
  it('runs SET LOCAL before the scoped page query on the same transaction', async () => {
    const result = (await syncQueries.syncClimbStats(
      undefined,
      { boardType: 'tension', layoutId: 10, sizeId: 6, cursor: null, limit: 500 },
      connectionContext(),
    )) as SyncResult;

    expect(result).toEqual({
      documents: [],
      cursor: { updatedAt: '1970-01-01T00:00:00.000Z', syncSeq: '0' },
      hasMore: false,
    });
    expect(database.transaction).toHaveBeenCalledTimes(1);
    expect(database.execute).not.toHaveBeenCalled();
    expect(transactionDatabase.execute).toHaveBeenCalledTimes(2);
    expect(recordedHandles).toEqual(['transaction', 'transaction']);
    expect(renderStatement(transactionDatabase.execute.mock.calls[0][0])).toMatch(SERIAL_PLAN_GUARD);
    expect(renderStatement(transactionDatabase.execute.mock.calls[1][0])).toContain('FROM board_climb_stats');
  });
});
