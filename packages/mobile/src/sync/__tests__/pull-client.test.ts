import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { QueryClient } from '@tanstack/react-query';

vi.mock('../checkpoints', () => ({
  getCheckpoint: vi.fn().mockResolvedValue(null),
  setCheckpoint: vi.fn().mockResolvedValue(undefined),
  getCheckpointKey: vi.fn((tableName: string, boardType?: string) =>
    boardType ? `checkpoint:${tableName}:${boardType}` : `checkpoint:${tableName}`,
  ),
}));

vi.mock('../table-config', async () => {
  const actual = await vi.importActual<typeof import('../table-config')>('../table-config');
  return actual;
});

import { pullSync } from '../pull-client';
import { getCheckpoint, setCheckpoint, getCheckpointKey } from '../checkpoints';
import { TABLE_CONFIGS, USER_DATA_TABLES, BOARD_DATA_TABLES } from '../table-config';

type SqlCall = { sql: string; params: unknown[] };

function createMockDb() {
  const sqlCalls: SqlCall[] = [];
  const mockTxn = {
    runAsync: vi.fn(async (sql: string, params: unknown[]) => {
      sqlCalls.push({ sql, params });
    }),
  };
  const db = {
    runAsync: vi.fn(async (sql: string, params: unknown[]) => {
      sqlCalls.push({ sql, params });
    }),
    getAllAsync: vi.fn().mockResolvedValue([]),
    getFirstAsync: vi.fn().mockResolvedValue(null),
    withExclusiveTransactionAsync: vi.fn(async (callback: (txn: typeof mockTxn) => Promise<void>) => {
      await callback(mockTxn);
    }),
  } as unknown as SQLiteDatabase;
  return { db, sqlCalls, mockTxn };
}

function createMockQueryClient() {
  return {
    invalidateQueries: vi.fn().mockResolvedValue(undefined),
  } as unknown as QueryClient;
}

function makeSyncResult(
  queryName: string,
  documents: Record<string, unknown>[],
  hasMore: boolean,
  cursor = { updatedAt: '2024-06-01T00:00:00Z', syncSeq: '1' },
) {
  return { [queryName]: { documents, cursor, hasMore } };
}

function makeDeletionsResult(
  deletions: Array<{ tableName: string; recordId: string; deletedAt: string }>,
  hasMore: boolean,
  cursor = { updatedAt: '2024-06-01T00:00:00Z', syncSeq: '1' },
) {
  return { syncDeletions: { deletions, cursor, hasMore } };
}

type GraphqlFetchMock = ReturnType<typeof vi.fn> &
  (<T>(query: string, variables?: Record<string, unknown>) => Promise<T>);

describe('pullSync', () => {
  let db: SQLiteDatabase;
  let sqlCalls: SqlCall[];
  let mockTxn: ReturnType<typeof createMockDb>['mockTxn'];
  let queryClient: QueryClient;
  let graphqlFetch: GraphqlFetchMock;

  beforeEach(() => {
    vi.clearAllMocks();
    const mock = createMockDb();
    db = mock.db;
    sqlCalls = mock.sqlCalls;
    mockTxn = mock.mockTxn;
    queryClient = createMockQueryClient();
    graphqlFetch = vi.fn() as unknown as GraphqlFetchMock;
  });

  function setupGraphqlFetchForAllTables(enabledBoards: string[] = []) {
    graphqlFetch.mockImplementation(async (query: string) => {
      const deletionsMatch = query.includes('syncDeletions');
      if (deletionsMatch) {
        return makeDeletionsResult([], false);
      }
      for (const config of Object.values(TABLE_CONFIGS)) {
        if (query.includes(config.queryName)) {
          return makeSyncResult(config.queryName, [], false);
        }
      }
      throw new Error(`Unexpected query: ${query}`);
    });
  }

  it('syncs user data tables first, then board data, then deletions', async () => {
    setupGraphqlFetchForAllTables();

    await pullSync(db, queryClient, graphqlFetch, { enabledBoards: ['kilter'] });

    const callQueries = graphqlFetch.mock.calls.map((args: unknown[]) => args[0] as string);

    const userTableQueryNames = USER_DATA_TABLES.map((t) => TABLE_CONFIGS[t].queryName);
    const boardTableQueryNames = BOARD_DATA_TABLES.map((t) => TABLE_CONFIGS[t].queryName);

    let lastUserIndex = -1;
    for (const queryName of userTableQueryNames) {
      const index = callQueries.findIndex((q: string) => q.includes(queryName));
      expect(index).toBeGreaterThan(lastUserIndex);
      lastUserIndex = index;
    }

    let lastBoardIndex = lastUserIndex;
    for (const queryName of boardTableQueryNames) {
      const index = callQueries.findIndex((q: string) => q.includes(queryName));
      expect(index).toBeGreaterThan(lastBoardIndex);
      lastBoardIndex = index;
    }

    const deletionsIndex = callQueries.findIndex((q: string) => q.includes('syncDeletions'));
    expect(deletionsIndex).toBeGreaterThan(lastBoardIndex);
  });

  it('paginates correctly with cursor updates', async () => {
    const firstCursor = { updatedAt: '2024-06-01T00:00:00Z', syncSeq: '10' };
    const secondCursor = { updatedAt: '2024-06-01T01:00:00Z', syncSeq: '20' };

    graphqlFetch.mockImplementation(async (query: string, variables: Record<string, unknown>) => {
      if (query.includes('syncDeletions')) {
        return makeDeletionsResult([], false);
      }
      if (query.includes('syncTicks')) {
        if (!variables.cursor) {
          return makeSyncResult('syncTicks', [{ uuid: 'tick-1', grade: 5 }], true, firstCursor);
        }
        return makeSyncResult('syncTicks', [{ uuid: 'tick-2', grade: 6 }], false, secondCursor);
      }
      for (const config of Object.values(TABLE_CONFIGS)) {
        if (query.includes(config.queryName)) {
          return makeSyncResult(config.queryName, [], false);
        }
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    await pullSync(db, queryClient, graphqlFetch);

    const ticksCalls = graphqlFetch.mock.calls.filter((args: unknown[]) => (args[0] as string).includes('syncTicks'));
    expect(ticksCalls).toHaveLength(2);
    expect(ticksCalls[0][1]).toEqual(expect.objectContaining({ cursor: undefined }));
    expect(ticksCalls[1][1]).toEqual(
      expect.objectContaining({ cursor: { updatedAt: firstCursor.updatedAt, syncSeq: firstCursor.syncSeq } }),
    );
  });

  it('upserts documents in batches of 50', async () => {
    const documents = Array.from({ length: 120 }, (_, index) => ({
      uuid: `tick-${index}`,
      grade: index,
    }));

    graphqlFetch.mockImplementation(async (query: string) => {
      if (query.includes('syncDeletions')) {
        return makeDeletionsResult([], false);
      }
      if (query.includes('syncTicks')) {
        return makeSyncResult('syncTicks', documents, false);
      }
      for (const config of Object.values(TABLE_CONFIGS)) {
        if (query.includes(config.queryName)) {
          return makeSyncResult(config.queryName, [], false);
        }
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    await pullSync(db, queryClient, graphqlFetch);

    const ticksInsertCalls = sqlCalls.filter((call) => call.sql.includes('INSERT OR REPLACE INTO boardsesh_ticks'));
    expect(ticksInsertCalls).toHaveLength(120);

    const transactionCalls = (db.withExclusiveTransactionAsync as ReturnType<typeof vi.fn>).mock.calls;
    const transactionInsertCounts: number[] = [];
    let currentBatchCount = 0;
    for (const call of ticksInsertCalls) {
      currentBatchCount++;
      if (currentBatchCount === 50 || call === ticksInsertCalls[ticksInsertCalls.length - 1]) {
        transactionInsertCounts.push(currentBatchCount);
        currentBatchCount = 0;
      }
    }

    expect(transactionCalls.length).toBe(3);
    expect(mockTxn.runAsync).toHaveBeenCalledTimes(120);
  });

  it('updates checkpoint after each page', async () => {
    const cursor1 = { updatedAt: '2024-06-01T00:00:00Z', syncSeq: '10' };
    const cursor2 = { updatedAt: '2024-06-01T01:00:00Z', syncSeq: '20' };

    graphqlFetch.mockImplementation(async (query: string, variables: Record<string, unknown>) => {
      if (query.includes('syncDeletions')) {
        return makeDeletionsResult([], false);
      }
      if (query.includes('syncTicks')) {
        if (!variables.cursor) {
          return makeSyncResult('syncTicks', [{ uuid: 'tick-1' }], true, cursor1);
        }
        return makeSyncResult('syncTicks', [{ uuid: 'tick-2' }], false, cursor2);
      }
      for (const config of Object.values(TABLE_CONFIGS)) {
        if (query.includes(config.queryName)) {
          return makeSyncResult(config.queryName, [], false);
        }
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    await pullSync(db, queryClient, graphqlFetch);

    const setCheckpointCalls = (setCheckpoint as ReturnType<typeof vi.fn>).mock.calls;
    const ticksCheckpoints = setCheckpointCalls.filter(
      (args: unknown[]) => (args[1] as string) === 'checkpoint:boardsesh_ticks',
    );
    expect(ticksCheckpoints).toHaveLength(2);
    expect(ticksCheckpoints[0][2]).toEqual(cursor1);
    expect(ticksCheckpoints[1][2]).toEqual(cursor2);
  });

  it('handles empty sync result without errors', async () => {
    setupGraphqlFetchForAllTables();

    await pullSync(db, queryClient, graphqlFetch);

    const insertCalls = sqlCalls.filter((call) => call.sql.includes('INSERT OR REPLACE'));
    expect(insertCalls).toHaveLength(0);
  });

  it('syncs per-board tables with boardType variable', async () => {
    graphqlFetch.mockImplementation(async (query: string) => {
      if (query.includes('syncDeletions')) {
        return makeDeletionsResult([], false);
      }
      for (const config of Object.values(TABLE_CONFIGS)) {
        if (query.includes(config.queryName)) {
          return makeSyncResult(config.queryName, [], false);
        }
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    await pullSync(db, queryClient, graphqlFetch, { enabledBoards: ['kilter'] });

    const climbsCalls = graphqlFetch.mock.calls.filter((args: unknown[]) => (args[0] as string).includes('syncClimbs'));
    expect(climbsCalls).toHaveLength(1);
    expect(climbsCalls[0][1]).toEqual(expect.objectContaining({ boardType: 'kilter' }));

    const statsCalls = graphqlFetch.mock.calls.filter((args: unknown[]) =>
      (args[0] as string).includes('syncClimbStats'),
    );
    expect(statsCalls).toHaveLength(1);
    expect(statsCalls[0][1]).toEqual(expect.objectContaining({ boardType: 'kilter' }));
  });

  it('only syncs enabled boards', async () => {
    graphqlFetch.mockImplementation(async (query: string) => {
      if (query.includes('syncDeletions')) {
        return makeDeletionsResult([], false);
      }
      for (const config of Object.values(TABLE_CONFIGS)) {
        if (query.includes(config.queryName)) {
          return makeSyncResult(config.queryName, [], false);
        }
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    await pullSync(db, queryClient, graphqlFetch, { enabledBoards: ['kilter'] });

    const climbsCalls = graphqlFetch.mock.calls.filter((args: unknown[]) => (args[0] as string).includes('syncClimbs'));
    expect(climbsCalls).toHaveLength(1);
    expect(climbsCalls[0][1]).toEqual(expect.objectContaining({ boardType: 'kilter' }));

    const allBoardTypeVars = graphqlFetch.mock.calls
      .map((args: unknown[]) => (args[1] as Record<string, unknown> | undefined)?.boardType)
      .filter(Boolean);
    for (const boardType of allBoardTypeVars) {
      expect(boardType).toBe('kilter');
    }
  });

  it('processes single-PK deletions', async () => {
    graphqlFetch.mockImplementation(async (query: string) => {
      if (query.includes('syncDeletions')) {
        return makeDeletionsResult(
          [{ tableName: 'boardsesh_ticks', recordId: 'uuid-123', deletedAt: '2024-06-01T00:00:00Z' }],
          false,
        );
      }
      for (const config of Object.values(TABLE_CONFIGS)) {
        if (query.includes(config.queryName)) {
          return makeSyncResult(config.queryName, [], false);
        }
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    await pullSync(db, queryClient, graphqlFetch);

    const deleteCalls = sqlCalls.filter((call) => call.sql.includes('DELETE FROM boardsesh_ticks'));
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].sql).toBe('DELETE FROM boardsesh_ticks WHERE uuid = ?');
    expect(deleteCalls[0].params).toEqual(['uuid-123']);
  });

  it('processes composite-PK deletions', async () => {
    graphqlFetch.mockImplementation(async (query: string) => {
      if (query.includes('syncDeletions')) {
        return makeDeletionsResult(
          [{ tableName: 'board_climb_stats', recordId: 'kilter:climb-uuid:40', deletedAt: '2024-06-01T00:00:00Z' }],
          false,
        );
      }
      for (const config of Object.values(TABLE_CONFIGS)) {
        if (query.includes(config.queryName)) {
          return makeSyncResult(config.queryName, [], false);
        }
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    await pullSync(db, queryClient, graphqlFetch);

    const deleteCalls = sqlCalls.filter((call) => call.sql.includes('DELETE FROM board_climb_stats'));
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].sql).toBe(
      'DELETE FROM board_climb_stats WHERE board_type = ? AND climb_uuid = ? AND angle = ?',
    );
    expect(deleteCalls[0].params).toEqual(['kilter', 'climb-uuid', '40']);
  });

  it('skips deletion when PK part count mismatches', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    graphqlFetch.mockImplementation(async (query: string) => {
      if (query.includes('syncDeletions')) {
        return makeDeletionsResult(
          [{ tableName: 'board_climb_stats', recordId: 'climb-uuid:40', deletedAt: '2024-06-01T00:00:00Z' }],
          false,
        );
      }
      for (const config of Object.values(TABLE_CONFIGS)) {
        if (query.includes(config.queryName)) {
          return makeSyncResult(config.queryName, [], false);
        }
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    await pullSync(db, queryClient, graphqlFetch);

    const deleteCalls = sqlCalls.filter((call) => call.sql.includes('DELETE FROM board_climb_stats'));
    expect(deleteCalls).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Skipping deletion: expected 3 PK parts for board_climb_stats, got 2'),
    );

    warnSpy.mockRestore();
  });

  it('invalidates correct query keys after sync', async () => {
    graphqlFetch.mockImplementation(async (query: string) => {
      if (query.includes('syncDeletions')) {
        return makeDeletionsResult([], false);
      }
      if (query.includes('syncTicks')) {
        return makeSyncResult('syncTicks', [{ uuid: 'tick-1' }], false);
      }
      for (const config of Object.values(TABLE_CONFIGS)) {
        if (query.includes(config.queryName)) {
          return makeSyncResult(config.queryName, [], false);
        }
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    await pullSync(db, queryClient, graphqlFetch);

    const invalidateCalls = (queryClient.invalidateQueries as ReturnType<typeof vi.fn>).mock.calls;
    const invalidatedKeys = invalidateCalls.map((args: unknown[]) => (args[0] as { queryKey: string[] }).queryKey);

    expect(invalidatedKeys).toContainEqual(['ticks']);
    expect(invalidatedKeys).toContainEqual(['logbook']);
  });

  it('reports progress via onProgress callback', async () => {
    const progressUpdates: Array<{ phase: string; currentTable: string | null; documentsProcessed: number }> = [];

    graphqlFetch.mockImplementation(async (query: string) => {
      if (query.includes('syncDeletions')) {
        return makeDeletionsResult(
          [{ tableName: 'boardsesh_ticks', recordId: 'uuid-1', deletedAt: '2024-06-01T00:00:00Z' }],
          false,
        );
      }
      if (query.includes('syncTicks')) {
        return makeSyncResult('syncTicks', [{ uuid: 'tick-1' }, { uuid: 'tick-2' }], false);
      }
      for (const config of Object.values(TABLE_CONFIGS)) {
        if (query.includes(config.queryName)) {
          return makeSyncResult(config.queryName, [], false);
        }
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    await pullSync(db, queryClient, graphqlFetch, {
      onProgress: (progress) => progressUpdates.push({ ...progress }),
    });

    const userDataUpdates = progressUpdates.filter((p) => p.phase === 'user_data');
    expect(userDataUpdates.length).toBeGreaterThan(0);
    expect(userDataUpdates[0].currentTable).toBe('boardsesh_ticks');

    const ticksComplete = userDataUpdates.find(
      (p) => p.currentTable === 'boardsesh_ticks' && p.documentsProcessed === 2,
    );
    expect(ticksComplete).toBeDefined();

    const deletionsUpdates = progressUpdates.filter((p) => p.phase === 'deletions');
    expect(deletionsUpdates.length).toBeGreaterThan(0);

    const idleUpdates = progressUpdates.filter((p) => p.phase === 'idle');
    expect(idleUpdates).toHaveLength(1);
    expect(idleUpdates[0].documentsProcessed).toBe(3);
  });

  it('handles graphqlFetch error by propagating it', async () => {
    const syncError = new Error('Network failure');
    graphqlFetch.mockRejectedValue(syncError);

    await expect(pullSync(db, queryClient, graphqlFetch)).rejects.toThrow('Network failure');
  });

  it('skips unknown table in deletions without error', async () => {
    graphqlFetch.mockImplementation(async (query: string) => {
      if (query.includes('syncDeletions')) {
        return makeDeletionsResult(
          [{ tableName: 'nonexistent_table', recordId: 'some-id', deletedAt: '2024-06-01T00:00:00Z' }],
          false,
        );
      }
      for (const config of Object.values(TABLE_CONFIGS)) {
        if (query.includes(config.queryName)) {
          return makeSyncResult(config.queryName, [], false);
        }
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    await expect(pullSync(db, queryClient, graphqlFetch)).resolves.toBeUndefined();

    const deleteCalls = sqlCalls.filter((call) => call.sql.includes('DELETE FROM nonexistent_table'));
    expect(deleteCalls).toHaveLength(0);
  });

  it('converts boolean values to integers in upserts', async () => {
    graphqlFetch.mockImplementation(async (query: string) => {
      if (query.includes('syncDeletions')) {
        return makeDeletionsResult([], false);
      }
      if (query.includes('syncTicks')) {
        return makeSyncResult(
          'syncTicks',
          [{ uuid: 'tick-bool', is_draft: true, is_listed: false, grade: null }],
          false,
        );
      }
      for (const config of Object.values(TABLE_CONFIGS)) {
        if (query.includes(config.queryName)) {
          return makeSyncResult(config.queryName, [], false);
        }
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    await pullSync(db, queryClient, graphqlFetch);

    const insertCalls = sqlCalls.filter((call) => call.sql.includes('INSERT OR REPLACE INTO boardsesh_ticks'));
    expect(insertCalls).toHaveLength(1);
    const params = insertCalls[0].params;
    expect(params).toContain('tick-bool');
    expect(params).toContain(1);
    expect(params).toContain(0);
    expect(params).toContain(null);
  });

  it('uses existing checkpoint as initial cursor', async () => {
    const existingCheckpoint = { updatedAt: '2024-05-01T00:00:00Z', syncSeq: '42' };
    (getCheckpoint as ReturnType<typeof vi.fn>).mockResolvedValue(existingCheckpoint);

    graphqlFetch.mockImplementation(async (query: string) => {
      if (query.includes('syncDeletions')) {
        return makeDeletionsResult([], false);
      }
      for (const config of Object.values(TABLE_CONFIGS)) {
        if (query.includes(config.queryName)) {
          return makeSyncResult(config.queryName, [], false);
        }
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    await pullSync(db, queryClient, graphqlFetch);

    const ticksCalls = graphqlFetch.mock.calls.filter((args: unknown[]) => (args[0] as string).includes('syncTicks'));
    expect(ticksCalls[0][1]).toEqual(
      expect.objectContaining({
        cursor: { updatedAt: existingCheckpoint.updatedAt, syncSeq: existingCheckpoint.syncSeq },
      }),
    );
  });

  it('syncs multiple board types in sequence', async () => {
    graphqlFetch.mockImplementation(async (query: string) => {
      if (query.includes('syncDeletions')) {
        return makeDeletionsResult([], false);
      }
      for (const config of Object.values(TABLE_CONFIGS)) {
        if (query.includes(config.queryName)) {
          return makeSyncResult(config.queryName, [], false);
        }
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    await pullSync(db, queryClient, graphqlFetch, { enabledBoards: ['kilter', 'tension'] });

    const climbsCalls = graphqlFetch.mock.calls.filter((args: unknown[]) => (args[0] as string).includes('syncClimbs'));
    expect(climbsCalls).toHaveLength(2);
    expect(climbsCalls[0][1]).toEqual(expect.objectContaining({ boardType: 'kilter' }));
    expect(climbsCalls[1][1]).toEqual(expect.objectContaining({ boardType: 'tension' }));
  });

  it('skips board data entirely when enabledBoards is empty', async () => {
    setupGraphqlFetchForAllTables();

    await pullSync(db, queryClient, graphqlFetch, { enabledBoards: [] });

    const boardCalls = graphqlFetch.mock.calls.filter((args: unknown[]) => {
      const q = args[0] as string;
      return q.includes('syncClimbs') || q.includes('syncClimbStats');
    });
    expect(boardCalls).toHaveLength(0);
  });

  it('serializes object values as JSON in upserts', async () => {
    const nestedObject = { frames: [{ position: 1 }] };
    graphqlFetch.mockImplementation(async (query: string) => {
      if (query.includes('syncDeletions')) {
        return makeDeletionsResult([], false);
      }
      if (query.includes('syncTicks')) {
        return makeSyncResult('syncTicks', [{ uuid: 'tick-obj', metadata: nestedObject }], false);
      }
      for (const config of Object.values(TABLE_CONFIGS)) {
        if (query.includes(config.queryName)) {
          return makeSyncResult(config.queryName, [], false);
        }
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    await pullSync(db, queryClient, graphqlFetch);

    const insertCalls = sqlCalls.filter((call) => call.sql.includes('INSERT OR REPLACE INTO boardsesh_ticks'));
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].params).toContain(JSON.stringify(nestedObject));
  });

  it('invalidates deletion-affected query keys only once per key', async () => {
    graphqlFetch.mockImplementation(async (query: string) => {
      if (query.includes('syncDeletions')) {
        return makeDeletionsResult(
          [
            { tableName: 'boardsesh_ticks', recordId: 'uuid-1', deletedAt: '2024-06-01T00:00:00Z' },
            { tableName: 'boardsesh_ticks', recordId: 'uuid-2', deletedAt: '2024-06-01T00:00:01Z' },
          ],
          false,
        );
      }
      for (const config of Object.values(TABLE_CONFIGS)) {
        if (query.includes(config.queryName)) {
          return makeSyncResult(config.queryName, [], false);
        }
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    await pullSync(db, queryClient, graphqlFetch);

    const invalidateCalls = (queryClient.invalidateQueries as ReturnType<typeof vi.fn>).mock.calls;
    const keysFromDeletionPhase = invalidateCalls.map((args: unknown[]) => {
      const first = args[0] as { queryKey: string[] };
      return JSON.stringify(first.queryKey);
    });

    const ticksKeyCount = keysFromDeletionPhase.filter((k: string) => k === '["ticks"]').length;
    const logbookKeyCount = keysFromDeletionPhase.filter((k: string) => k === '["logbook"]').length;

    expect(ticksKeyCount).toBeGreaterThanOrEqual(1);
    expect(logbookKeyCount).toBeGreaterThanOrEqual(1);
  });

  it('calls getCheckpointKey with boardType for per-board tables', async () => {
    setupGraphqlFetchForAllTables();

    await pullSync(db, queryClient, graphqlFetch, { enabledBoards: ['kilter'] });

    expect(getCheckpointKey).toHaveBeenCalledWith('board_climbs', 'kilter');
    expect(getCheckpointKey).toHaveBeenCalledWith('board_climb_stats', 'kilter');
    expect(getCheckpointKey).toHaveBeenCalledWith('boardsesh_ticks', undefined);
  });
});
