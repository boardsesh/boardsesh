import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OfflineDatabase, QueryInvalidator } from '../../database';

vi.mock('../checkpoints', () => ({
  getCheckpoint: vi.fn().mockResolvedValue(null),
  setCheckpoint: vi.fn().mockResolvedValue(undefined),
  getCheckpointKey: vi.fn((tableName: string, boardType?: string) =>
    boardType ? `checkpoint:${tableName}:${boardType}` : `checkpoint:${tableName}`,
  ),
  markScopeDownloadComplete: vi.fn().mockResolvedValue(undefined),
  isScopeDownloadComplete: vi.fn().mockResolvedValue(false),
  markScopeDownloadStarted: vi.fn().mockResolvedValue(undefined),
  isScopeDownloadStarted: vi.fn().mockResolvedValue(false),
  // Returns the `nowMs` it was handed, i.e. behaves like a first stamp.
  ensureScopeDownloadStartedAt: vi.fn(async (_db: unknown, _scopeKey: string, nowMs: number) => nowMs),
  SCOPE_DOWNLOAD_START_MAX_AGE_MS: 24 * 60 * 60 * 1000,
  rewindDeletionsCheckpoint: vi.fn().mockResolvedValue(undefined),
  compareCheckpoints: vi.fn().mockReturnValue(0),
  DELETIONS_CHECKPOINT_KEY: 'checkpoint:deletions',
  SCOPE_COMPLETE_PREFIX: 'scope-complete:',
}));

vi.mock('../table-config', async () => {
  const actual = await vi.importActual<typeof import('../table-config')>('../table-config');
  return actual;
});

import { pullSync, type SyncProgress, multiRowChunkSize } from '../pull-client';
import { setSigningOut, setBackgrounded, beginGlobalPurge } from '../../mutation-queue/drainer';
import { getCheckpoint, setCheckpoint, getCheckpointKey, markScopeDownloadComplete } from '../checkpoints';
import { TABLE_CONFIGS, USER_DATA_TABLES, BOARD_DATA_TABLES } from '../table-config';

type SqlCall = { sql: string; params: unknown[] };

function createMockDb() {
  const sqlCalls: SqlCall[] = [];
  const mockTxn = {
    runAsync: vi.fn(async (sql: string, params: unknown[]) => {
      sqlCalls.push({ sql, params });
    }),
    // The upsert transaction sets busy_timeout via execAsync first; a no-op that
    // stays out of sqlCalls keeps the runAsync-based assertions unchanged.
    execAsync: vi.fn(async () => {}),
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
  } as unknown as OfflineDatabase;
  return { db, sqlCalls, mockTxn };
}

function createMockQueryClient() {
  return {
    invalidateQueries: vi.fn().mockResolvedValue(undefined),
  } as unknown as QueryInvalidator;
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
  let db: OfflineDatabase;
  let sqlCalls: SqlCall[];
  let mockTxn: ReturnType<typeof createMockDb>['mockTxn'];
  let queryClient: QueryInvalidator;
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

  function setupGraphqlFetchForAllTables() {
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

  it('applies deletions FIRST, then user data tables, then board data', async () => {
    // Deletions-first is what makes a server-side delete-then-recreate
    // converge: the tombstone removes the old local row before the same
    // cycle's table pull upserts the recreated one. Applied last, a tombstone
    // sharing the recreated row's timestamp would delete rows this cycle just
    // wrote — and the strict > cursor would never re-fetch them.
    setupGraphqlFetchForAllTables();

    await pullSync(db, queryClient, graphqlFetch, { enabledBoards: ['kilter:1:5'] });

    const callQueries = graphqlFetch.mock.calls.map((args: unknown[]) => args[0] as string);

    const userTableQueryNames = USER_DATA_TABLES.map((t) => TABLE_CONFIGS[t].queryName);
    const boardTableQueryNames = BOARD_DATA_TABLES.map((t) => TABLE_CONFIGS[t].queryName);

    const deletionsIndex = callQueries.findIndex((q: string) => q.includes('syncDeletions'));
    expect(deletionsIndex).toBe(0);

    let lastUserIndex = deletionsIndex;
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

    // Both board tables pulled to their tail → the scope's "initial download
    // complete" marker is written (the gate for local-first reads).
    expect(markScopeDownloadComplete).toHaveBeenCalledWith(db, 'kilter:1:5');
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
          return makeSyncResult('syncTicks', [{ uuid: 'tick-1', status: 'send' }], true, firstCursor);
        }
        return makeSyncResult('syncTicks', [{ uuid: 'tick-2', status: 'attempt' }], false, secondCursor);
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

  it('upserts a whole page inside one exclusive transaction, batched into multi-row statements', async () => {
    const documents = Array.from({ length: 120 }, (_, index) => ({
      uuid: `tick-${index}`,
      attempt_count: index,
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

    // Only 2 columns are present across the page (uuid, attempt_count), so the
    // chunk size (floor(999/2) = 499) comfortably covers all 120 rows in one
    // multi-row INSERT OR REPLACE statement — one runAsync call, not 120.
    const ticksInsertCalls = sqlCalls.filter((call) => call.sql.includes('INSERT OR REPLACE INTO boardsesh_ticks'));
    expect(ticksInsertCalls).toHaveLength(1);
    expect(ticksInsertCalls[0].params).toHaveLength(120 * 2);

    // One transaction for the 120-row page — per-batch transactions multiplied
    // commit overhead ~10× across a big board download.
    const transactionCalls = (db.withExclusiveTransactionAsync as ReturnType<typeof vi.fn>).mock.calls;
    expect(transactionCalls.length).toBe(1);
    expect(mockTxn.runAsync).toHaveBeenCalledTimes(1);
  });

  it('splits a page into multiple multi-row statements when it exceeds the bind-variable chunk size', async () => {
    // board_climbs' real allowlist is 27 columns → chunkSize = floor(999/27) =
    // 37 rows/statement. Supplying all 27 keys on every document makes the
    // page-wide column union every synced column, so 100 rows must split into
    // several statements inside the one transaction.
    const climbsConfig = TABLE_CONFIGS.board_climbs;
    const documents = Array.from({ length: 100 }, (_, index) =>
      Object.fromEntries(
        climbsConfig.localColumns.map((column) => [column, column === 'uuid' ? `climb-${index}` : `${column}-value`]),
      ),
    );

    graphqlFetch.mockImplementation(async (query: string) => {
      if (query.includes('syncDeletions')) {
        return makeDeletionsResult([], false);
      }
      if (query.includes('syncClimbs')) {
        return makeSyncResult('syncClimbs', documents, false);
      }
      for (const config of Object.values(TABLE_CONFIGS)) {
        if (query.includes(config.queryName)) {
          return makeSyncResult(config.queryName, [], false);
        }
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    await pullSync(db, queryClient, graphqlFetch, { enabledBoards: ['kilter:1:5'] });

    const insertCalls = sqlCalls.filter((call) => call.sql.includes('INSERT OR REPLACE INTO board_climbs'));
    // Rows per statement follow the column count (SQLITE_MAX_BIND_VARIABLES /
    // columns), so derive the split instead of hardcoding it: adding a synced
    // column (v5 added `is_hidden`) must not turn this into a maintenance test.
    const columnCount = climbsConfig.localColumns.length;
    const rowsPerChunk = multiRowChunkSize(columnCount);
    const fullChunks = Math.floor(100 / rowsPerChunk);
    const remainder = 100 % rowsPerChunk;
    expect(fullChunks).toBeGreaterThanOrEqual(2);
    expect(insertCalls).toHaveLength(fullChunks + (remainder > 0 ? 1 : 0));
    for (const call of insertCalls.slice(0, fullChunks)) {
      expect(call.params).toHaveLength(rowsPerChunk * columnCount);
    }
    if (remainder > 0) {
      expect(insertCalls[insertCalls.length - 1]?.params).toHaveLength(remainder * columnCount);
    }

    // Total row count across the chunked statements still matches the page.
    const totalRowsInserted = insertCalls.reduce(
      (sum, call) => sum + call.params.length / climbsConfig.localColumns.length,
      0,
    );
    expect(totalRowsInserted).toBe(100);

    // Still one exclusive transaction for the whole page, batching or not.
    expect((db.withExclusiveTransactionAsync as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
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

    // Two markers are excused, both of which an empty cycle legitimately stamps:
    // deletions-coverage (pinned by the test below) and user_data_complete —
    // "every user table reached its tail" is true of a cycle that moved zero
    // rows, which is exactly when a local reader may start serving. Checkpoints
    // go through the same `INSERT OR REPLACE INTO sync_meta`, so excluding
    // sync_meta wholesale would stop this catching "an empty cycle advanced a
    // cursor".
    const excusedMarkerKeys = new Set(['deletions-coverage', 'checkpoint:user_data_complete']);
    const insertCalls = sqlCalls.filter(
      (call) =>
        call.sql.includes('INSERT OR REPLACE') &&
        !(call.sql.includes('sync_meta') && excusedMarkerKeys.has(String(call.params?.[0]))),
    );
    expect(insertCalls).toHaveLength(0);
  });

  it('seeds the deletions-coverage marker and wipes nothing when the marker is absent', async () => {
    // The mock db's getFirstAsync returns null, so the coverage marker reads as
    // ABSENT — exactly the state of every existing install on the first launch
    // after the OTA that introduces it. Absent must mean "seed it", never
    // "assume the worst and reset": the alternative detonates a fleet-wide
    // user-data wipe on rollout day. This pins that default for the whole suite.
    setupGraphqlFetchForAllTables();

    await pullSync(db, queryClient, graphqlFetch);

    const coverageWrites = sqlCalls.filter(
      (call) => call.sql.includes('INSERT OR REPLACE INTO sync_meta') && call.params?.[0] === 'deletions-coverage',
    );
    expect(coverageWrites.length).toBeGreaterThanOrEqual(1);
    expect(Number(coverageWrites[0].params[1])).toBeGreaterThan(0);

    // No user-table wipe, and the deletions cursor was not dropped.
    const wipeDeletes = sqlCalls.filter((call) => call.sql === 'DELETE FROM boardsesh_ticks');
    expect(wipeDeletes).toHaveLength(0);
    const cursorDeletes = sqlCalls.filter(
      (call) => call.sql.includes('DELETE FROM sync_meta') && call.params?.includes('checkpoint:deletions'),
    );
    expect(cursorDeletes).toHaveLength(0);
  });

  it('syncs per-board tables with boardType + layout/size scope variables', async () => {
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

    await pullSync(db, queryClient, graphqlFetch, { enabledBoards: ['kilter:1:5'] });

    const climbsCalls = graphqlFetch.mock.calls.filter((args: unknown[]) => (args[0] as string).includes('syncClimbs'));
    expect(climbsCalls).toHaveLength(1);
    expect(climbsCalls[0][1]).toEqual(expect.objectContaining({ boardType: 'kilter', layoutId: 1, sizeId: 5 }));

    const statsCalls = graphqlFetch.mock.calls.filter((args: unknown[]) =>
      (args[0] as string).includes('syncClimbStats'),
    );
    expect(statsCalls).toHaveLength(1);
    expect(statsCalls[0][1]).toEqual(expect.objectContaining({ boardType: 'kilter', layoutId: 1, sizeId: 5 }));
  });

  it('skips malformed board scope keys without crashing the pull', async () => {
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

    // 'kilter' (legacy bare board type) and 'a:b:c' (non-numeric) are malformed and
    // must be skipped; only the well-formed key downloads.
    await pullSync(db, queryClient, graphqlFetch, { enabledBoards: ['kilter', 'a:b:c', 'tension:8:10'] });

    const climbsCalls = graphqlFetch.mock.calls.filter((args: unknown[]) => (args[0] as string).includes('syncClimbs'));
    expect(climbsCalls).toHaveLength(1);
    expect(climbsCalls[0][1]).toEqual(expect.objectContaining({ boardType: 'tension', layoutId: 8, sizeId: 10 }));
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

    await pullSync(db, queryClient, graphqlFetch, { enabledBoards: ['kilter:1:5'] });

    const climbsCalls = graphqlFetch.mock.calls.filter((args: unknown[]) => (args[0] as string).includes('syncClimbs'));
    expect(climbsCalls).toHaveLength(1);
    expect(climbsCalls[0][1]).toEqual(expect.objectContaining({ boardType: 'kilter', layoutId: 1, sizeId: 5 }));

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
    // The trailing guard is the resurrection protection: a tombstone must not
    // delete a local row NEWER than the deletion itself.
    expect(deleteCalls[0].sql).toBe(
      'DELETE FROM boardsesh_ticks WHERE uuid = ? AND (updated_at IS NULL OR updated_at <= ?)',
    );
    expect(deleteCalls[0].params).toEqual(['uuid-123', '2024-06-01T00:00:00Z']);
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
      'DELETE FROM board_climb_stats WHERE board_type = ? AND climb_uuid = ? AND angle = ? AND (updated_at IS NULL OR updated_at <= ?)',
    );
    expect(deleteCalls[0].params).toEqual(['kilter', 'climb-uuid', '40', '2024-06-01T00:00:00Z']);
  });

  it('applies a deletion page and its checkpoint in one exclusive transaction', async () => {
    const pageCursor = { updatedAt: '2024-06-01T00:00:02Z', syncSeq: '22' };
    graphqlFetch.mockImplementation(async (query: string) => {
      if (query.includes('syncDeletions')) {
        return makeDeletionsResult(
          [
            { tableName: 'boardsesh_ticks', recordId: 'uuid-1', deletedAt: '2024-06-01T00:00:01Z' },
            { tableName: 'boardsesh_ticks', recordId: 'uuid-2', deletedAt: '2024-06-01T00:00:02Z' },
          ],
          false,
          pageCursor,
        );
      }
      for (const config of Object.values(TABLE_CONFIGS)) {
        if (query.includes(config.queryName)) return makeSyncResult(config.queryName, [], false);
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    await pullSync(db, queryClient, graphqlFetch);

    expect((db.withExclusiveTransactionAsync as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect(mockTxn.runAsync).toHaveBeenCalledTimes(2);
    expect(setCheckpoint).toHaveBeenNthCalledWith(1, mockTxn, 'checkpoint:deletions', {
      updatedAt: '1970-01-01T00:00:00.000Z',
      syncSeq: '0',
    });
    expect(setCheckpoint).toHaveBeenNthCalledWith(2, mockTxn, 'checkpoint:deletions', pageCursor);
  });

  it('abandons a queued deletion page when a global purge finishes before its transaction starts', async () => {
    (db.getFirstAsync as ReturnType<typeof vi.fn>).mockImplementation(async (_sql: string, params: unknown[]) =>
      params[0] === 'deletions-coverage' ? { value: String(Date.now()) } : null,
    );
    (db.withExclusiveTransactionAsync as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (callback: (transaction: typeof mockTxn) => Promise<void>) => {
        // Models the callback waiting behind a global purge's SQLite lock: its
        // post-fetch guard already passed, then the wipe completes before this
        // transaction gets a chance to perform its first write.
        beginGlobalPurge();
        await callback(mockTxn);
      },
    );
    graphqlFetch.mockImplementation(async (query: string) => {
      if (query.includes('syncDeletions')) {
        return makeDeletionsResult(
          [{ tableName: 'boardsesh_ticks', recordId: 'wiped-tick', deletedAt: '2024-06-01T00:00:00Z' }],
          false,
        );
      }
      for (const config of Object.values(TABLE_CONFIGS)) {
        if (query.includes(config.queryName)) return makeSyncResult(config.queryName, [], false);
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    await pullSync(db, queryClient, graphqlFetch);

    expect(mockTxn.runAsync).not.toHaveBeenCalled();
    expect(setCheckpoint).toHaveBeenCalledTimes(1);
    expect(setCheckpoint).not.toHaveBeenCalledWith(mockTxn, 'checkpoint:deletions', {
      updatedAt: '2024-06-01T00:00:00Z',
      syncSeq: '1',
    });
    expect(
      sqlCalls.some(
        (call) => call.sql.includes('INSERT OR REPLACE INTO sync_meta') && call.params[0] === 'deletions-coverage',
      ),
    ).toBe(false);
  });

  it('abandons a deletion page when a global purge lands while its deferred transaction acquires the writer lock', async () => {
    (db.getFirstAsync as ReturnType<typeof vi.fn>).mockImplementation(async (_sql: string, params: unknown[]) =>
      params[0] === 'deletions-coverage' ? { value: String(Date.now()) } : null,
    );
    (setCheckpoint as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      // Models the purge winning the writer-lock race after callback entry. The
      // checkpoint write waits for it, then the post-lock epoch guard must abort
      // before a tombstone or the fetched page cursor can be written.
      beginGlobalPurge();
    });
    graphqlFetch.mockImplementation(async (query: string) => {
      if (query.includes('syncDeletions')) {
        return makeDeletionsResult(
          [{ tableName: 'boardsesh_ticks', recordId: 'wiped-tick', deletedAt: '2024-06-01T00:00:00Z' }],
          false,
        );
      }
      for (const config of Object.values(TABLE_CONFIGS)) {
        if (query.includes(config.queryName)) return makeSyncResult(config.queryName, [], false);
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    await pullSync(db, queryClient, graphqlFetch);

    expect(setCheckpoint).toHaveBeenCalledTimes(1);
    expect(mockTxn.runAsync).not.toHaveBeenCalled();
    expect(
      sqlCalls.some(
        (call) => call.sql.includes('INSERT OR REPLACE INTO sync_meta') && call.params[0] === 'deletions-coverage',
      ),
    ).toBe(false);
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

    expect(invalidatedKeys).toContainEqual(['logbook']);
    expect(invalidatedKeys).toContainEqual(['userTicks']);
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

    // Deletions run FIRST now, so the running total the ticks table finishes at
    // is 1 (the deletion) + 2 (the ticks).
    const ticksComplete = userDataUpdates.find(
      (p) => p.currentTable === 'boardsesh_ticks' && p.documentsProcessed === 3,
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
          [{ uuid: 'tick-bool', is_mirror: true, is_benchmark: false, quality: null }],
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

    await pullSync(db, queryClient, graphqlFetch, { enabledBoards: ['kilter:1:5', 'tension:8:10'] });

    const climbsCalls = graphqlFetch.mock.calls.filter((args: unknown[]) => (args[0] as string).includes('syncClimbs'));
    expect(climbsCalls).toHaveLength(2);
    expect(climbsCalls[0][1]).toEqual(expect.objectContaining({ boardType: 'kilter', layoutId: 1, sizeId: 5 }));
    expect(climbsCalls[1][1]).toEqual(expect.objectContaining({ boardType: 'tension', layoutId: 8, sizeId: 10 }));
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
      if (query.includes('syncClimbs')) {
        return makeSyncResult('syncClimbs', [{ uuid: 'climb-obj', frames: nestedObject }], false);
      }
      for (const config of Object.values(TABLE_CONFIGS)) {
        if (query.includes(config.queryName)) {
          return makeSyncResult(config.queryName, [], false);
        }
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    await pullSync(db, queryClient, graphqlFetch, { enabledBoards: ['kilter:1:5'] });

    const insertCalls = sqlCalls.filter((call) => call.sql.includes('INSERT OR REPLACE INTO board_climbs'));
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

    const logbookKeyCount = keysFromDeletionPhase.filter((k: string) => k === '["logbook"]').length;
    const userTicksKeyCount = keysFromDeletionPhase.filter((k: string) => k === '["userTicks"]').length;

    expect(logbookKeyCount).toBeGreaterThanOrEqual(1);
    expect(userTicksKeyCount).toBeGreaterThanOrEqual(1);
  });

  it('invalidates a committed deletion page before a later page request fails', async () => {
    let deletionRequestCount = 0;
    graphqlFetch.mockImplementation(async (query: string) => {
      if (query.includes('syncDeletions')) {
        deletionRequestCount += 1;
        if (deletionRequestCount === 1) {
          return makeDeletionsResult(
            [{ tableName: 'boardsesh_ticks', recordId: 'uuid-1', deletedAt: '2024-06-01T00:00:00Z' }],
            true,
          );
        }
        throw new Error('page two transport failed');
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    await expect(pullSync(db, queryClient, graphqlFetch)).rejects.toThrow('page two transport failed');

    const invalidatedKeys = (queryClient.invalidateQueries as ReturnType<typeof vi.fn>).mock.calls.map(
      (args: unknown[]) => (args[0] as { queryKey: string[] }).queryKey,
    );
    expect(invalidatedKeys).toContainEqual(['logbook']);
    expect(invalidatedKeys).toContainEqual(['userTicks']);
  });

  it('calls getCheckpointKey with the full scope key for per-board tables', async () => {
    setupGraphqlFetchForAllTables();

    await pullSync(db, queryClient, graphqlFetch, { enabledBoards: ['kilter:1:5'] });

    expect(getCheckpointKey).toHaveBeenCalledWith('board_climbs', 'kilter:1:5');
    expect(getCheckpointKey).toHaveBeenCalledWith('board_climb_stats', 'kilter:1:5');
    expect(getCheckpointKey).toHaveBeenCalledWith('boardsesh_ticks', undefined);
  });

  it('stops pulling while sign-out is wiping local data (no fetches, no writes, no checkpoint advance)', async () => {
    // Mirrors the drainer's sign-out guard: an in-flight pull page landing after
    // clearUserData would resurrect the old user's rows for the next account.
    setupGraphqlFetchForAllTables();
    setSigningOut(true);
    try {
      await pullSync(db, queryClient, graphqlFetch);
      expect(graphqlFetch).not.toHaveBeenCalled();
      expect(sqlCalls.filter((call) => call.sql.startsWith('INSERT OR REPLACE'))).toHaveLength(0);
      expect(setCheckpoint).not.toHaveBeenCalled();
    } finally {
      setSigningOut(false);
    }
  });

  it('discards a page whose fetch was in flight while a wipe started AND finished (epoch guard)', async () => {
    // The old-boolean hole: sign-out sets the flag only for the milliseconds
    // clearUserData takes. A page fetch awaiting the network across that window
    // sees `false` on both sides and would write the signed-out user's rows —
    // and their checkpoints — back into the wiped DB. The monotonic wipe epoch
    // catches it: this fetch simulates a complete wipe cycle mid-flight.
    graphqlFetch.mockImplementation(async (query: string) => {
      if (query.includes('syncDeletions')) {
        return makeDeletionsResult([], false);
      }
      if (query.includes('syncTicks')) {
        // Wipe starts and finishes while this page is "on the wire".
        setSigningOut(true);
        setSigningOut(false);
        return makeSyncResult('syncTicks', [{ uuid: 'old-user-tick' }], false);
      }
      for (const config of Object.values(TABLE_CONFIGS)) {
        if (query.includes(config.queryName)) {
          return makeSyncResult(config.queryName, [], false);
        }
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    await pullSync(db, queryClient, graphqlFetch);

    // The old user's tick page must NOT have been upserted, and the ticks
    // checkpoint must NOT have been re-created after the wipe reset it.
    const tickWrites = sqlCalls.filter((call) => call.params?.some((value) => value === 'old-user-tick'));
    expect(tickWrites).toHaveLength(0);
    const tickCheckpointWrites = (setCheckpoint as ReturnType<typeof vi.fn>).mock.calls.filter((args: unknown[]) =>
      String(args[1]).includes('boardsesh_ticks'),
    );
    expect(tickCheckpointWrites).toHaveLength(0);
  });

  it('stops pulling while the app is backgrounded (no fetches, no writes, no checkpoint advance)', async () => {
    // Sentry BOARDSESH-AN: a SQLite call dispatched right as iOS suspends the
    // process crashed natively. Mirrors the sign-out guard above.
    setupGraphqlFetchForAllTables();
    const progressFrames: SyncProgress[] = [];
    setBackgrounded(true);
    try {
      await pullSync(db, queryClient, graphqlFetch, { onProgress: (progress) => progressFrames.push(progress) });
      expect(graphqlFetch).not.toHaveBeenCalled();
      expect(sqlCalls.filter((call) => call.sql.startsWith('INSERT OR REPLACE'))).toHaveLength(0);
      expect(setCheckpoint).not.toHaveBeenCalled();
      expect(progressFrames.at(-1)).toEqual({
        phase: 'idle',
        currentTable: null,
        documentsProcessed: 0,
        interrupted: true,
      });
      expect(progressFrames.filter((progress) => progress.phase === 'idle')).toHaveLength(1);
    } finally {
      setBackgrounded(false);
    }
  });

  it('stops mid-cycle when the app backgrounds while a page is on the wire', async () => {
    const progressFrames: SyncProgress[] = [];
    graphqlFetch.mockImplementation(async (query: string) => {
      if (query.includes('syncDeletions')) {
        return makeDeletionsResult([], false);
      }
      if (query.includes('syncTicks')) {
        // The app backgrounds while this page is "on the wire".
        setBackgrounded(true);
        return makeSyncResult('syncTicks', [{ uuid: 'some-tick' }], false);
      }
      for (const config of Object.values(TABLE_CONFIGS)) {
        if (query.includes(config.queryName)) {
          return makeSyncResult(config.queryName, [], false);
        }
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    try {
      await pullSync(db, queryClient, graphqlFetch, { onProgress: (progress) => progressFrames.push(progress) });

      // The page already in flight when backgrounding was detected must not be
      // upserted, and its checkpoint must not advance.
      const tickWrites = sqlCalls.filter((call) => call.params?.some((value) => value === 'some-tick'));
      expect(tickWrites).toHaveLength(0);
      const tickCheckpointWrites = (setCheckpoint as ReturnType<typeof vi.fn>).mock.calls.filter((args: unknown[]) =>
        String(args[1]).includes('boardsesh_ticks'),
      );
      expect(tickCheckpointWrites).toHaveLength(0);
      expect(progressFrames.at(-1)).toEqual({
        phase: 'idle',
        currentTable: null,
        documentsProcessed: 0,
        interrupted: true,
      });
      expect(progressFrames.filter((progress) => progress.phase === 'idle')).toHaveLength(1);
    } finally {
      setBackgrounded(false);
    }
  });
});
