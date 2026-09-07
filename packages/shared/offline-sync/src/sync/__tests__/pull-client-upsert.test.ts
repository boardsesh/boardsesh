// Focused coverage for the multi-row batching added to upsertDocuments
// (pull-client.ts): the pure chunk-sizing/value-coercion helpers, and the
// row/column mechanics of the batched INSERT OR REPLACE (parameter ordering,
// NULL fill for a page-wide column a given document lacks, and that unknown-
// column drift reporting is unaffected by batching). The sibling
// pull-client.test.ts covers pullSync's overall control flow; this file
// isolates the batching behaviour itself.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OfflineDatabase, QueryInvalidator, SqlValue } from '../../database';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';
import { runMigrations } from '../../db/migrations';

vi.mock('../checkpoints', () => ({
  getCheckpoint: vi.fn().mockResolvedValue(null),
  setCheckpoint: vi.fn().mockResolvedValue(undefined),
  getCheckpointKey: vi.fn((tableName: string, boardType?: string) =>
    boardType ? `checkpoint:${tableName}:${boardType}` : `checkpoint:${tableName}`,
  ),
  markScopeDownloadComplete: vi.fn().mockResolvedValue(undefined),
  rewindDeletionsCheckpoint: vi.fn().mockResolvedValue(undefined),
  compareCheckpoints: vi.fn().mockReturnValue(0),
  DELETIONS_CHECKPOINT_KEY: 'checkpoint:deletions',
  SCOPE_COMPLETE_PREFIX: 'scope-complete:',
}));

import { pullSync, toSqliteValue, multiRowChunkSize, buildMultiRowInsertSql } from '../pull-client';
import { TABLE_CONFIGS } from '../table-config';
import { OFFLINE_DB_BUSY_TIMEOUT_MS } from '../../db/pragmas';

// --- Pure helpers ------------------------------------------------------------

describe('multiRowChunkSize', () => {
  it('27 columns (board_climbs allowlist width) → 37 rows per statement', () => {
    expect(multiRowChunkSize(27)).toBe(37);
  });

  it('1 column → 999 rows per statement (the full bind-variable budget)', () => {
    expect(multiRowChunkSize(1)).toBe(999);
  });

  it('exactly 999 columns → 1 row per statement', () => {
    expect(multiRowChunkSize(999)).toBe(1);
  });

  it('more columns than the bind-variable ceiling → clamps to 1, never 0', () => {
    expect(multiRowChunkSize(1000)).toBe(1);
    expect(multiRowChunkSize(5000)).toBe(1);
  });

  it('12 columns (boardsesh_ticks-shaped) → 83 rows per statement', () => {
    expect(multiRowChunkSize(12)).toBe(83);
  });
});

describe('toSqliteValue', () => {
  it('maps true → 1 and false → 0', () => {
    expect(toSqliteValue(true)).toBe(1);
    expect(toSqliteValue(false)).toBe(0);
  });

  it('passes numbers and strings through unchanged', () => {
    expect(toSqliteValue(42)).toBe(42);
    expect(toSqliteValue(3.14)).toBe(3.14);
    expect(toSqliteValue('hello')).toBe('hello');
    expect(toSqliteValue('')).toBe('');
  });

  it('maps null and undefined to null', () => {
    expect(toSqliteValue(null)).toBeNull();
    expect(toSqliteValue(undefined)).toBeNull();
  });

  it('JSON-stringifies plain objects', () => {
    expect(toSqliteValue({ frames: [{ position: 1 }] })).toBe(JSON.stringify({ frames: [{ position: 1 }] }));
  });

  it('JSON-stringifies arrays', () => {
    expect(toSqliteValue([1, 2, 3])).toBe(JSON.stringify([1, 2, 3]));
    expect(toSqliteValue(['a', 'b'])).toBe(JSON.stringify(['a', 'b']));
  });

  it('stores Date values as ISO strings without JSON quotes', () => {
    expect(toSqliteValue(new Date('2026-07-08T12:34:56.789Z'))).toBe('2026-07-08T12:34:56.789Z');
  });
});

// --- Batched upsert mechanics (driven through pullSync, mirroring the
// sibling suite's mock-db style) ----------------------------------------------

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

function createMockQueryClient(): QueryInvalidator {
  return { invalidateQueries: vi.fn().mockResolvedValue(undefined) } as unknown as QueryInvalidator;
}

function makeSyncResult(
  queryName: string,
  documents: Record<string, unknown>[],
  hasMore: boolean,
  cursor = { updatedAt: '2024-06-01T00:00:00Z', syncSeq: '1' },
) {
  return { [queryName]: { documents, cursor, hasMore } };
}

function makeDeletionsResult(hasMore = false) {
  return { syncDeletions: { deletions: [], cursor: { updatedAt: '2024-06-01T00:00:00Z', syncSeq: '1' }, hasMore } };
}

type GraphqlFetchMock = ReturnType<typeof vi.fn> &
  (<T>(query: string, variables?: Record<string, unknown>) => Promise<T>);

describe('upsertDocuments batching (via pullSync)', () => {
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

  function fetchServingOnly(queryName: string, documents: Record<string, unknown>[]): void {
    graphqlFetch.mockImplementation(async (query: string) => {
      if (query.includes('syncDeletions')) return makeDeletionsResult();
      if (query.includes(queryName)) return makeSyncResult(queryName, documents, false);
      for (const config of Object.values(TABLE_CONFIGS)) {
        if (query.includes(config.queryName)) return makeSyncResult(config.queryName, [], false);
      }
      throw new Error(`Unexpected query: ${query}`);
    });
  }

  it('sets busy_timeout on the transaction connection before inserting', async () => {
    fetchServingOnly('syncTicks', [{ uuid: 'tick-1', attempt_count: 1 }]);

    await pullSync(db, queryClient, graphqlFetch);

    expect(mockTxn.execAsync).toHaveBeenCalledWith(`PRAGMA busy_timeout = ${OFFLINE_DB_BUSY_TIMEOUT_MS}`);
    // Must run before the insert: a fresh transaction connection starts at
    // busy_timeout = 0, so setting it after the first INSERT is too late to
    // protect that statement from an instant SQLITE_BUSY.
    const execOrder = mockTxn.execAsync.mock.invocationCallOrder[0];
    const runOrder = mockTxn.runAsync.mock.invocationCallOrder[0];
    expect(execOrder).toBeLessThan(runOrder);
  });

  it('binds NULL for a document missing a page-wide column another document has', async () => {
    // doc1 carries `quality`; doc2 omits it entirely. The page-wide column
    // union still includes `quality` (present in >=1 document), so doc2's row
    // must bind NULL for it rather than shrinking the column list.
    fetchServingOnly('syncTicks', [
      { uuid: 'tick-1', attempt_count: 1, quality: 5 },
      { uuid: 'tick-2', attempt_count: 2 },
    ]);

    await pullSync(db, queryClient, graphqlFetch);

    const insertCalls = sqlCalls.filter((call) => call.sql.includes('INSERT OR REPLACE INTO boardsesh_ticks'));
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].sql).toBe(
      'INSERT OR REPLACE INTO boardsesh_ticks (uuid, attempt_count, quality) VALUES (?, ?, ?), (?, ?, ?)',
    );
    // Row-major parameter order: doc1's full row, then doc2's full row with
    // NULL in the quality slot — not doc2's two present values compacted.
    expect(insertCalls[0].params).toEqual(['tick-1', 1, 5, 'tick-2', 2, null]);
  });

  it('preserves per-row column ordering within a multi-row chunk (values land in the right row/column)', async () => {
    const documents = [
      { uuid: 'tick-a', attempt_count: 10, comment: 'first' },
      { uuid: 'tick-b', attempt_count: 20, comment: 'second' },
      { uuid: 'tick-c', attempt_count: 30, comment: 'third' },
    ];
    fetchServingOnly('syncTicks', documents);

    await pullSync(db, queryClient, graphqlFetch);

    const insertCalls = sqlCalls.filter((call) => call.sql.includes('INSERT OR REPLACE INTO boardsesh_ticks'));
    expect(insertCalls).toHaveLength(1);
    // columns = [uuid, attempt_count, comment] (table-config declaration order,
    // filtered to columns present anywhere on the page).
    expect(insertCalls[0].params).toEqual(['tick-a', 10, 'first', 'tick-b', 20, 'second', 'tick-c', 30, 'third']);
  });

  it('skips an unknown column and reports schema drift exactly once, unaffected by batching', async () => {
    const onSchemaDrift = vi.fn();
    fetchServingOnly('syncTicks', [
      { uuid: 'tick-drift-1', attempt_count: 1, made_up_column_xyz: 'a' },
      { uuid: 'tick-drift-2', attempt_count: 2, made_up_column_xyz: 'b' },
    ]);

    await pullSync(db, queryClient, graphqlFetch, { onSchemaDrift });

    const driftCalls = onSchemaDrift.mock.calls.filter(([drift]) => drift.column === 'made_up_column_xyz');
    expect(driftCalls).toHaveLength(1);
    expect(driftCalls[0][0]).toEqual({ tableName: 'boardsesh_ticks', column: 'made_up_column_xyz' });

    // The unknown column never reaches the SQL — only allowlisted columns do.
    const insertCalls = sqlCalls.filter((call) => call.sql.includes('INSERT OR REPLACE INTO boardsesh_ticks'));
    expect(insertCalls[0].sql).not.toContain('made_up_column_xyz');
    expect(insertCalls[0].params).not.toContain('a');
  });
});

// The pull is the ONLY writer of every synced table but one. `board_climb_stats`
// also takes the live `climbStatsUpdated` write-through (#5227), and a page
// fetched before a recompute can commit after the stream already wrote the
// newer row — its apply transaction waits behind whatever else holds the lock.
// So that one table upserts under a revision guard; nothing else changes shape.
describe('buildMultiRowInsertSql — the revision guard', () => {
  const guard = { revisionColumn: 'sync_seq', primaryKeyColumns: ['board_type', 'climb_uuid', 'angle'] };

  it('leaves an unguarded table byte for byte as it was', () => {
    expect(buildMultiRowInsertSql('boardsesh_ticks', ['uuid', 'quality'], 2)).toBe(
      'INSERT OR REPLACE INTO boardsesh_ticks (uuid, quality) VALUES (?, ?), (?, ?)',
    );
  });

  it('emits a guarded upsert for the one table with a second writer', () => {
    const sql = buildMultiRowInsertSql(
      'board_climb_stats',
      ['board_type', 'climb_uuid', 'angle', 'ascensionist_count', 'updated_at', 'sync_seq'],
      1,
      guard,
    );

    expect(sql).toContain('INSERT INTO board_climb_stats');
    expect(sql).not.toContain('INSERT OR REPLACE');
    expect(sql).toContain('ON CONFLICT(board_type, climb_uuid, angle) DO UPDATE SET');
    // The primary key is the conflict target, so it is never assigned.
    expect(sql).toContain(
      'DO UPDATE SET ascensionist_count = excluded.ascensionist_count, updated_at = excluded.updated_at, ' +
        'sync_seq = excluded.sync_seq',
    );
    // `>=`, not `>`: see the equal-revision test below.
    expect(sql).toContain('WHERE excluded.sync_seq >= COALESCE(board_climb_stats.sync_seq, -1)');
  });

  it('falls back to the plain form when the page carries no revision column', () => {
    // Nothing to compare against, so the guard would be invalid SQL.
    const sql = buildMultiRowInsertSql('board_climb_stats', ['board_type', 'climb_uuid', 'angle', 'updated_at'], 1, {
      ...guard,
      revisionColumn: 'sync_seq',
    });
    expect(sql).toContain('INSERT OR REPLACE INTO board_climb_stats');
  });

  it('falls back to the plain form when the page carries only key columns', () => {
    const sql = buildMultiRowInsertSql('board_climb_stats', ['board_type', 'climb_uuid', 'angle'], 1, guard);
    expect(sql).toContain('INSERT OR REPLACE INTO board_climb_stats');
  });

  it('is configured for board_climb_stats and for nothing else', () => {
    const guarded = Object.entries(TABLE_CONFIGS)
      .filter(([, config]) => config.revisionColumn !== undefined)
      .map(([tableName]) => tableName);
    expect(guarded).toEqual(['board_climb_stats']);
    expect(TABLE_CONFIGS.board_climb_stats.revisionColumn).toBe('sync_seq');
  });
});

describe('the revision guard against a real SQLite row', () => {
  async function applyPage(database: TestSqliteDb, rows: Record<string, SqlValue>[]) {
    const columns = [
      'board_type',
      'climb_uuid',
      'angle',
      'ascensionist_count',
      'benchmark_difficulty',
      'updated_at',
      'sync_seq',
    ];
    const sql = buildMultiRowInsertSql('board_climb_stats', columns, rows.length, {
      revisionColumn: 'sync_seq',
      primaryKeyColumns: TABLE_CONFIGS.board_climb_stats.primaryKeyColumns,
    });
    await database.runAsync(
      sql,
      rows.flatMap((row) => columns.map((column) => row[column] ?? null)),
    );
  }

  function statsRow(overrides: Record<string, SqlValue> = {}): Record<string, SqlValue> {
    return {
      board_type: 'kilter',
      climb_uuid: 'climb-1',
      angle: 40,
      ascensionist_count: 41,
      benchmark_difficulty: null,
      updated_at: '2026-09-01T00:00:00.000Z',
      sync_seq: 900,
      ...overrides,
    };
  }

  let database: TestSqliteDb;

  beforeEach(async () => {
    database = createTestDatabase();
    await runMigrations(database);
    // The stream's row: newer than the page below, and with the epoch
    // updated_at plus the NULL benchmark the write-through always leaves.
    await applyPage(database, [
      statsRow({ ascensionist_count: 42, sync_seq: 1000, updated_at: '1970-01-01T00:00:00.000Z' }),
    ]);
  });

  afterEach(() => {
    database.close();
  });

  it('cannot walk a newer local row backwards', async () => {
    await applyPage(database, [statsRow({ ascensionist_count: 41, sync_seq: 900 })]);

    const row = await database.getFirstAsync<{ ascensionist_count: number; sync_seq: number }>(
      'SELECT ascensionist_count, sync_seq FROM board_climb_stats WHERE climb_uuid = ?',
      ['climb-1'],
    );
    expect(row).toMatchObject({ ascensionist_count: 42, sync_seq: 1000 });
  });

  it('still applies an EQUAL revision, because it fills what the stream never writes', async () => {
    // The stream leaves updated_at at the epoch (it is the pull cursor) and
    // never writes benchmark_difficulty. A `>` guard would strand both.
    await applyPage(database, [
      statsRow({
        ascensionist_count: 42,
        sync_seq: 1000,
        benchmark_difficulty: 19,
        updated_at: '2026-09-02T10:00:00.000Z',
      }),
    ]);

    const row = await database.getFirstAsync<{
      benchmark_difficulty: number | null;
      updated_at: string;
      sync_seq: number;
    }>('SELECT benchmark_difficulty, updated_at, sync_seq FROM board_climb_stats WHERE climb_uuid = ?', ['climb-1']);
    expect(row).toMatchObject({ benchmark_difficulty: 19, updated_at: '2026-09-02T10:00:00.000Z', sync_seq: 1000 });
  });

  it('applies a newer page row normally', async () => {
    await applyPage(database, [statsRow({ ascensionist_count: 43, sync_seq: 1100 })]);

    const row = await database.getFirstAsync<{ ascensionist_count: number; sync_seq: number }>(
      'SELECT ascensionist_count, sync_seq FROM board_climb_stats WHERE climb_uuid = ?',
      ['climb-1'],
    );
    expect(row).toMatchObject({ ascensionist_count: 43, sync_seq: 1100 });
  });

  it('inserts a row that has no local counterpart at all', async () => {
    await applyPage(database, [statsRow({ climb_uuid: 'climb-new', ascensionist_count: 7, sync_seq: 5 })]);

    const row = await database.getFirstAsync<{ ascensionist_count: number }>(
      'SELECT ascensionist_count FROM board_climb_stats WHERE climb_uuid = ?',
      ['climb-new'],
    );
    expect(row?.ascensionist_count).toBe(7);
  });
});
