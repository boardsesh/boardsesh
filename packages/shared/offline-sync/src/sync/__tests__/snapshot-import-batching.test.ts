// The batched snapshot import (issue #4310): does it move exactly the rows the
// single mega-transaction moved, and does it actually let go of the write lock?
//
// EVERY case runs on a FILE-BACKED `createTestDatabase(path)`. The in-memory
// double runs the transaction task on the SAME connection, which hides both
// things this suite is about: per-connection ATTACH/TEMP semantics, and a second
// connection contending for the lock (testing/sqlite-test-db.ts:63-72 says so).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  bootstrapScopeFromSnapshot,
  SnapshotWipedError,
  SNAPSHOT_IMPORT_BATCH_ROWS,
  type SnapshotSource,
} from '../snapshot-bootstrap';
import {
  classifyBootstrapFailure,
  getBootstrapAttempts,
  isTerminal as isBootstrapRetryTerminal,
  readBootstrapRetryState,
  shouldSkipPagedPull,
  MAX_BOOTSTRAP_LOCK_FAILURES,
} from '../bootstrap-retry';
import { pullSync } from '../pull-client';
import { getCheckpoint } from '../checkpoints';
import { removeBoardScopeData } from '../scope-teardown';
import { runMigrations, LATEST_SCHEMA_VERSION } from '../../db/migrations';
import { ensureMutationQueueTable } from '../../mutation-queue/schema';
import { beginScopePurge, __resetDrainerStateForTests } from '../../mutation-queue/drainer';
import { configureMainConnection } from '../../db/pragmas';
import { isDatabaseLockedError } from '../../db/lock-errors';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';
import { SCHEMA_STATEMENTS } from '../../db/schema';
import { climbsScopeFilter } from '../board-scope-sql';
import type { OfflineBoardScope } from '../../offline-board-key';
import type { OfflineDatabase, QueryInvalidator } from '../../database';
import {
  SNAPSHOT_MANIFEST_FORMAT_VERSION,
  type SnapshotManifest,
  type SnapshotManifestEntry,
} from '../snapshot-manifest';

const SNAPSHOT_META_DDL = `
CREATE TABLE IF NOT EXISTS snapshot_meta (
  table_name TEXT PRIMARY KEY,
  watermark_updated_at TEXT,
  watermark_sync_seq TEXT,
  row_count INTEGER,
  built_at TEXT,
  schema_version INTEGER,
  format_version INTEGER
);`;

const BUILT_AT = '2026-08-01T00:00:00.000Z';
const WATERMARK_AT = '2026-07-30T00:00:00.000Z';
const WATERMARK_SEQ = '900';

type ClimbRow = { uuid: string; boardType: string; layoutId: number; compatibleSizeIds: number[] | null };
type StatRow = { climbUuid: string; boardType: string; angle: number };

type ArtifactShape = { climbs: ClimbRow[]; stats: StatRow[] };

/**
 * A fixture artifact carrying several layouts and sizes, plus the two shapes the
 * scope filter has to get right: a climb the artifact holds but this scope does
 * NOT want, and a stats row whose climb is absent from the artifact entirely.
 */
function twoLayoutArtifact(): ArtifactShape {
  const climbs: ClimbRow[] = [];
  const stats: StatRow[] = [];
  // kilter layout 1, size 10 — the scope under test.
  for (let index = 0; index < 14; index += 1) {
    climbs.push({ uuid: `k1-10-${index}`, boardType: 'kilter', layoutId: 1, compatibleSizeIds: [10, 11] });
    for (const angle of [40, 50]) stats.push({ climbUuid: `k1-10-${index}`, boardType: 'kilter', angle });
  }
  // kilter layout 1, a DIFFERENT size — in the artifact, out of this scope.
  for (let index = 0; index < 5; index += 1) {
    climbs.push({ uuid: `k1-7-${index}`, boardType: 'kilter', layoutId: 1, compatibleSizeIds: [7] });
    stats.push({ climbUuid: `k1-7-${index}`, boardType: 'kilter', angle: 40 });
  }
  // kilter layout 2 — same board, different layout.
  for (let index = 0; index < 4; index += 1) {
    climbs.push({ uuid: `k2-${index}`, boardType: 'kilter', layoutId: 2, compatibleSizeIds: [10] });
    stats.push({ climbUuid: `k2-${index}`, boardType: 'kilter', angle: 40 });
  }
  // A climb with NULL compatible_size_ids: excluded exactly as Postgres
  // `NULL @> ARRAY[x]` excludes it.
  climbs.push({ uuid: 'k1-null', boardType: 'kilter', layoutId: 1, compatibleSizeIds: null });
  stats.push({ climbUuid: 'k1-null', boardType: 'kilter', angle: 40 });
  // An ORPHAN stats row: no board_climbs row anywhere in the artifact.
  stats.push({ climbUuid: 'k1-missing-climb', boardType: 'kilter', angle: 40 });
  // moonboard layout 3 — not size-scoped, so no json_each membership at all.
  for (let index = 0; index < 6; index += 1) {
    climbs.push({ uuid: `mb-${index}`, boardType: 'moonboard', layoutId: 3, compatibleSizeIds: null });
    stats.push({ climbUuid: `mb-${index}`, boardType: 'moonboard', angle: 40 });
  }
  return { climbs, stats };
}

function buildArtifact(filePath: string, shape: ArtifactShape): void {
  const artifact = new DatabaseSync(filePath);
  try {
    for (const statement of SCHEMA_STATEMENTS) artifact.exec(statement);
    artifact.exec(SNAPSHOT_META_DDL);
    const insertClimb = artifact.prepare(
      `INSERT OR REPLACE INTO board_climbs
        (uuid, board_type, layout_id, name, is_draft, is_listed, compatible_size_ids, updated_at, sync_seq)
       VALUES (?, ?, ?, ?, 0, 1, ?, ?, ?)`,
    );
    for (const climb of shape.climbs) {
      insertClimb.run(
        climb.uuid,
        climb.boardType,
        climb.layoutId,
        `name-${climb.uuid}`,
        climb.compatibleSizeIds === null ? null : JSON.stringify(climb.compatibleSizeIds),
        WATERMARK_AT,
        Number(WATERMARK_SEQ),
      );
    }
    const insertStat = artifact.prepare(
      `INSERT OR REPLACE INTO board_climb_stats
        (board_type, climb_uuid, angle, display_difficulty, updated_at, sync_seq)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const stat of shape.stats) {
      insertStat.run(stat.boardType, stat.climbUuid, stat.angle, 21.5, WATERMARK_AT, Number(WATERMARK_SEQ));
    }
    const meta = artifact.prepare(
      `INSERT OR REPLACE INTO snapshot_meta
        (table_name, watermark_updated_at, watermark_sync_seq, row_count, built_at, schema_version, format_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    meta.run('board_climbs', WATERMARK_AT, WATERMARK_SEQ, shape.climbs.length, BUILT_AT, LATEST_SCHEMA_VERSION, 1);
    meta.run('board_climb_stats', WATERMARK_AT, WATERMARK_SEQ, shape.stats.length, BUILT_AT, LATEST_SCHEMA_VERSION, 1);
    meta.run('sync_deletions', WATERMARK_AT, '0', 0, BUILT_AT, LATEST_SCHEMA_VERSION, 1);
  } finally {
    artifact.close();
  }
}

/** Every sync query answers with one empty tail page: the crawl is not what this suite is about. */
function emptyPageFetch() {
  const emptyCursor = { updatedAt: '1970-01-01T00:00:00.000Z', syncSeq: '0' };
  const fetch = vi.fn(async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
    const cursor = (variables?.cursor as typeof emptyCursor | undefined) ?? emptyCursor;
    if (query.includes('syncDeletions')) {
      return { syncDeletions: { deletions: [], cursor, hasMore: false } } as T;
    }
    const match = query.match(/\{\s*\n?\s*(sync[A-Za-z]+)\(/);
    return { [match ? match[1] : 'unknown']: { documents: [], cursor, hasMore: false } } as T;
  });
  return fetch as unknown as Parameters<typeof pullSync>[2];
}

const KILTER_SCOPE: OfflineBoardScope = { boardType: 'kilter', layoutId: 1, sizeId: 10 };
const KILTER_SCOPE_KEY = 'kilter:1:10';
const MOONBOARD_SCOPE: OfflineBoardScope = { boardType: 'moonboard', layoutId: 3, sizeId: 1 };
const MOONBOARD_SCOPE_KEY = 'moonboard:3:1';

let workDir: string;
let artifactPath: string;
let openedDatabases: TestSqliteDb[] = [];

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'snapshot-import-batching-'));
  // Deliberately NOT named after a scope: `freshClientDb('kilter-1')` would
  // otherwise land on this exact path and the import would ATTACH its own file.
  artifactPath = join(workDir, 'snapshot-artifact.db');
  buildArtifact(artifactPath, twoLayoutArtifact());
  openedDatabases = [];
  __resetDrainerStateForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetDrainerStateForTests();
  for (const database of openedDatabases) {
    try {
      database.close();
    } catch {
      // Already closed by a case that owns its own lifecycle.
    }
  }
  rmSync(workDir, { recursive: true, force: true });
});

async function freshClientDb(name: string): Promise<{ db: TestSqliteDb; path: string }> {
  const path = join(workDir, `${name}.db`);
  const db = createTestDatabase(path);
  openedDatabases.push(db);
  await configureMainConnection(db);
  await runMigrations(db);
  await ensureMutationQueueTable(db);
  return { db, path };
}

async function readClimbs(db: OfflineDatabase): Promise<unknown[]> {
  return db.getAllAsync('SELECT * FROM board_climbs ORDER BY uuid');
}

async function readStats(db: OfflineDatabase): Promise<unknown[]> {
  return db.getAllAsync('SELECT * FROM board_climb_stats ORDER BY board_type, climb_uuid, angle');
}

describe('SNAPSHOT_IMPORT_BATCH_ROWS', () => {
  // Pinned the way snapshot-bootstrap.test.ts pins the lifetime artifact-download
  // count: the number is a lock-hold budget, so any future loosening should show
  // up in a diff rather than in a Sentry aggregate.
  it('is 5,000 rows per exclusive transaction', () => {
    expect(SNAPSHOT_IMPORT_BATCH_ROWS).toBe(5_000);
  });
});

describe('batched import row-set equivalence', () => {
  // The failure this guards is permanent and silent: an import filter NARROWER
  // than the resolver's scope loses rows forever, because the strict `>` delta
  // pull never revisits anything at or below the stamped watermark.
  it('imports an identical row set at batch size 1, 3 and larger-than-the-table (size-scoped kilter)', async () => {
    const results: Array<{ climbs: unknown[]; stats: unknown[] }> = [];
    for (const batchRows of [1, 3, 10_000]) {
      const { db } = await freshClientDb(`kilter-${batchRows}`);
      await bootstrapScopeFromSnapshot({
        db,
        scope: KILTER_SCOPE,
        scopeKey: KILTER_SCOPE_KEY,
        filePath: artifactPath,
        batchRows,
      });
      results.push({ climbs: await readClimbs(db), stats: await readStats(db) });
    }

    expect(results[0].climbs).toEqual(results[2].climbs);
    expect(results[1].climbs).toEqual(results[2].climbs);
    expect(results[0].stats).toEqual(results[2].stats);
    expect(results[1].stats).toEqual(results[2].stats);
    // And it is the RIGHT set, not merely a consistent one.
    expect(results[2].climbs).toHaveLength(14);
    expect(results[2].stats).toHaveLength(28);
    // 42 single-row transactions across three fresh migrated databases; the
    // default 5s ceiling is about a fast unit test, not about this.
  }, 30_000);

  it('imports an identical row set at every batch size for a non-size-scoped board', async () => {
    const results: Array<{ climbs: unknown[]; stats: unknown[] }> = [];
    for (const batchRows of [1, 3, 10_000]) {
      const { db } = await freshClientDb(`moonboard-${batchRows}`);
      await bootstrapScopeFromSnapshot({
        db,
        scope: MOONBOARD_SCOPE,
        scopeKey: MOONBOARD_SCOPE_KEY,
        filePath: artifactPath,
        batchRows,
      });
      results.push({ climbs: await readClimbs(db), stats: await readStats(db) });
    }

    expect(results[0].climbs).toEqual(results[2].climbs);
    expect(results[1].climbs).toEqual(results[2].climbs);
    expect(results[0].stats).toEqual(results[2].stats);
    expect(results[1].stats).toEqual(results[2].stats);
    expect(results[2].climbs).toHaveLength(6);
    expect(results[2].stats).toHaveLength(6);
  }, 30_000);
});

describe('stats semi-join equivalence', () => {
  // The rewrite swaps a correlated EXISTS over the artifact's board_climbs for a
  // lookup on a staging table. The two are equal by construction — the staging
  // table is populated by exactly `climbsScopeFilter(scope)`, the predicate the
  // old EXISTS inlined — and this runs both against one artifact to prove it.
  it('selects the same (board_type, climb_uuid, angle) set the correlated EXISTS did', async () => {
    const { db } = await freshClientDb('semijoin');
    await bootstrapScopeFromSnapshot({
      db,
      scope: KILTER_SCOPE,
      scopeKey: KILTER_SCOPE_KEY,
      filePath: artifactPath,
      batchRows: 3,
    });
    const imported = (
      await db.getAllAsync<{ board_type: string; climb_uuid: string; angle: number }>(
        'SELECT board_type, climb_uuid, angle FROM board_climb_stats ORDER BY board_type, climb_uuid, angle',
      )
    ).map((row) => `${row.board_type}|${row.climb_uuid}|${row.angle}`);

    // The ORIGINAL predicate, evaluated straight against the artifact.
    const artifact = new DatabaseSync(artifactPath);
    try {
      const original = artifact
        .prepare(
          `SELECT s.board_type AS board_type, s.climb_uuid AS climb_uuid, s.angle AS angle
           FROM board_climb_stats s
           WHERE s.board_type = ?
             AND EXISTS (
               SELECT 1 FROM board_climbs bc
               WHERE bc.uuid = s.climb_uuid AND bc.board_type = ? AND bc.layout_id = ?
                 AND bc.compatible_size_ids IS NOT NULL
                 AND EXISTS (SELECT 1 FROM json_each(bc.compatible_size_ids) WHERE value = ?)
             )
           ORDER BY s.board_type, s.climb_uuid, s.angle`,
        )
        .all('kilter', 'kilter', 1, 10) as Array<{ board_type: string; climb_uuid: string; angle: number }>;
      expect(imported).toEqual(original.map((row) => `${row.board_type}|${row.climb_uuid}|${row.angle}`));
    } finally {
      artifact.close();
    }

    // The two shapes the filter has to get right, spelled out.
    expect(imported.some((key) => key.includes('k1-7-'))).toBe(false);
    expect(imported.some((key) => key.includes('k1-missing-climb'))).toBe(false);
    expect(imported.some((key) => key.includes('k1-null'))).toBe(false);
  });
});

describe('stats keyset query plan', () => {
  // THE ASSERTION A ROW-SET TEST CANNOT MAKE. Measured on SQLite 3.53.3 against
  // board_climb_stats' real PRIMARY KEY (board_type, climb_uuid, angle):
  //   `a > ? OR (a = ? AND b > ?)`  →  SEARCH ... (board_type=?)   [partition rescan]
  //   `(a, b) > (?, ?)`             →  SEARCH ... (board_type=? AND (climb_uuid,angle)>(?,?))
  // With the OR form every batch re-scans the whole board_type partition — ~142
  // passes over 306k rows on a Kilter layout — so the "batched" import would be
  // O(n^2) and SLOWER than the single statement it replaces. Nothing about the
  // rows it returns would differ, which is why this is pinned on the plan.
  it('seeks the PK instead of rescanning the board_type partition', async () => {
    const { db } = await freshClientDb('plan');
    const executedSql: string[] = [];
    const adapterPrototype = Object.getPrototypeOf(db) as { runAsync: typeof db.runAsync };
    const realRunAsync = adapterPrototype.runAsync;
    vi.spyOn(adapterPrototype, 'runAsync').mockImplementation(async function (
      this: unknown,
      source: string,
      ...rest: unknown[]
    ) {
      executedSql.push(source);
      return realRunAsync.call(this, source, ...(rest as never[]));
    } as typeof db.runAsync);

    await bootstrapScopeFromSnapshot({
      db,
      scope: KILTER_SCOPE,
      scopeKey: KILTER_SCOPE_KEY,
      filePath: artifactPath,
      batchRows: 3,
    });

    // The statement the import ACTUALLY ran, not a copy of it.
    const statsInsert = executedSql.find((source) => source.includes('INSERT OR REPLACE INTO main.board_climb_stats'));
    expect(statsInsert).toBeDefined();

    const planDb = new DatabaseSync(':memory:');
    try {
      for (const statement of SCHEMA_STATEMENTS) planDb.exec(statement);
      planDb.exec(`ATTACH DATABASE '${artifactPath}' AS bs_snapshot`);
      planDb.exec('CREATE TEMP TABLE bs_import_climbs (uuid TEXT PRIMARY KEY)');
      const bindCount = (statsInsert as string).split('?').length - 1;
      const plan = planDb
        .prepare(`EXPLAIN QUERY PLAN ${statsInsert as string}`)
        .all(...Array.from({ length: bindCount }, () => null)) as Array<{ detail: string }>;
      const detail = plan.map((row) => row.detail).join(' | ');
      // Whitespace-tolerant, but NOT weakened to a row-set check: SQLite renders
      // the row-value seek without spaces today, and a future release that adds
      // them should not fail this. What must not change is that the plan names a
      // (climb_uuid, angle) range seek under the board_type equality — if SQLite
      // ever stops emitting that shape, this failing loudly is the point.
      expect(detail).toMatch(/\(\s*climb_uuid\s*,\s*angle\s*\)\s*>/);
      expect(detail).toMatch(/board_type\s*=\s*\?/);
    } finally {
      planDb.close();
    }
  });
});

describe('batch accounting', () => {
  it('reports the scoped row count, a finite batch count and a measured lock hold', async () => {
    const { db } = await freshClientDb('accounting');
    const batchProgress: Array<{ rowsImported: number; batches: number }> = [];
    const result = await bootstrapScopeFromSnapshot({
      db,
      scope: KILTER_SCOPE,
      scopeKey: KILTER_SCOPE_KEY,
      filePath: artifactPath,
      batchRows: 3,
      onBatch: (progress) => batchProgress.push({ ...progress }),
    });

    // Rows, not batches: a keyset range over the artifact's stats PK walks
    // ARTIFACT rows, so ceil(scopedStats / B) is NOT the batch count.
    expect(result.climbsImported).toBe(14);
    expect(result.statsImported).toBe(28);
    expect(result.climbsImported + result.statsImported).toBe(42);
    expect(Number.isFinite(result.importBatches)).toBe(true);
    expect(result.importBatches).toBeGreaterThan(1);
    expect(batchProgress).toHaveLength(result.importBatches);
    // Progress only ever moves forward.
    expect(batchProgress.map((progress) => progress.rowsImported)).toEqual(
      batchProgress.map((progress) => progress.rowsImported).sort((left, right) => left - right),
    );
    expect(batchProgress[batchProgress.length - 1].rowsImported).toBe(42);

    // The timings are all real numbers, and the batch loop cannot be shorter
    // than the longest hold inside it.
    for (const timing of [
      result.importVerifyMs,
      result.importReconcileMs,
      result.importRowsMs,
      result.importLockMaxMs,
    ]) {
      expect(Number.isFinite(timing)).toBe(true);
      expect(timing).toBeGreaterThanOrEqual(0);
    }
    expect(result.importRowsMs).toBeGreaterThanOrEqual(result.importLockMaxMs);
  });

  // Dropping the `applyBulkImportPragmas` call would pass every other test in
  // this file and every row-set assertion in it: the import would still move
  // exactly the same rows, just paying ~142 fsyncs to do it, and the regression
  // would surface only as an `importLockMaxMs` shift in the field weeks later.
  // pragmas.test.ts proves the pragma works in isolation; this proves the import
  // asks for it — and that it asks in AUTOCOMMIT, before the first transaction,
  // which is the only place SQLite accepts it.
  it('drops the import connection to synchronous = NORMAL before it takes any lock', async () => {
    const { db } = await freshClientDb('pragma');
    const executedSql: string[] = [];
    const adapterPrototype = Object.getPrototypeOf(db) as { execAsync: typeof db.execAsync };
    const realExecAsync = adapterPrototype.execAsync;
    vi.spyOn(adapterPrototype, 'execAsync').mockImplementation(async function (this: unknown, source: string) {
      executedSql.push(source);
      return realExecAsync.call(this, source);
    } as typeof db.execAsync);

    await bootstrapScopeFromSnapshot({
      db,
      scope: KILTER_SCOPE,
      scopeKey: KILTER_SCOPE_KEY,
      filePath: artifactPath,
      batchRows: 3,
    });

    const pragmaAt = executedSql.findIndex((source) => /PRAGMA\s+synchronous\s*=\s*NORMAL/i.test(source));
    expect(pragmaAt).toBeGreaterThanOrEqual(0);

    const firstExclusiveAt = executedSql.findIndex((source) => /BEGIN\s+EXCLUSIVE/i.test(source));
    expect(firstExclusiveAt).toBeGreaterThanOrEqual(0);
    expect(pragmaAt).toBeLessThan(firstExclusiveAt);
  });
});

describe('the #4314 regression: the lock is released between batches', () => {
  /**
   * The PRE-CHANGE shape, rebuilt here rather than kept as a production flag:
   * one `BEGIN EXCLUSIVE` around both INSERTs. A `singleTransaction: true`
   * option in the engine would be a production branch reachable only from a test
   * that reinstates the exact failure mode this change removes.
   */
  async function importInOneTransaction(
    db: OfflineDatabase,
    scope: OfflineBoardScope,
    filePath: string,
    whileLocked: () => Promise<void>,
  ): Promise<void> {
    await db.withExclusiveTransactionAsync(async (txn) => {
      await txn.execAsync('COMMIT');
      await txn.execAsync(`ATTACH DATABASE '${filePath}' AS bs_snapshot`);
      await txn.execAsync('BEGIN EXCLUSIVE');
      const climbScope = climbsScopeFilter(scope);
      await txn.runAsync(
        `INSERT OR REPLACE INTO main.board_climbs (uuid, board_type, layout_id, compatible_size_ids)
         SELECT uuid, board_type, layout_id, compatible_size_ids
         FROM bs_snapshot.board_climbs WHERE ${climbScope.sql}`,
        climbScope.params,
      );
      await whileLocked();
      await txn.runAsync(
        `INSERT OR REPLACE INTO main.board_climb_stats (board_type, climb_uuid, angle)
         SELECT s.board_type, s.climb_uuid, s.angle FROM bs_snapshot.board_climb_stats s
         WHERE s.board_type = ?
           AND EXISTS (SELECT 1 FROM bs_snapshot.board_climbs bc WHERE bc.uuid = s.climb_uuid)`,
        [scope.boardType],
      );
    });
  }

  it('rejects a concurrent user write for the whole of the pre-change single transaction', async () => {
    const { db, path } = await freshClientDb('single-txn');
    const writer = createTestDatabase(path);
    openedDatabases.push(writer);
    await writer.execAsync('PRAGMA busy_timeout = 10');

    let lockError: unknown = null;
    await importInOneTransaction(db, KILTER_SCOPE, artifactPath, async () => {
      try {
        await writer.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', ['user-write', '1']);
      } catch (error) {
        lockError = error;
      }
    });

    expect(lockError).not.toBeNull();
    expect(isDatabaseLockedError(lockError)).toBe(true);
    expect(await db.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', ['user-write'])).toBeNull();
  });

  it('lets a concurrent user write land while the batched import runs', async () => {
    const { db, path } = await freshClientDb('batched-txn');
    const writer = createTestDatabase(path);
    openedDatabases.push(writer);
    await writer.execAsync('PRAGMA busy_timeout = 10');

    // An INDEPENDENT loop, not an awaited hook. A hook parks the import between
    // batches, which proves only that a released lock is released; this races
    // the import for real. `Promise.resolve()` rather than a timer because
    // node:sqlite is synchronous — the import is a chain of microtasks and a
    // macrotask writer might never be scheduled inside it at all.
    let importFinished = false;
    let writesLanded = 0;
    let writesRejected = 0;
    let writesLandedByFirstBatch: number | null = null;
    const writerLoop = (async () => {
      while (!importFinished) {
        await Promise.resolve();
        try {
          await writer.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
            `user-write-${writesLanded}`,
            '1',
          ]);
          writesLanded += 1;
        } catch (error) {
          if (!isDatabaseLockedError(error)) throw error;
          writesRejected += 1;
        }
      }
    })();

    await bootstrapScopeFromSnapshot({
      db,
      scope: KILTER_SCOPE,
      scopeKey: KILTER_SCOPE_KEY,
      filePath: artifactPath,
      batchRows: 1,
      onBatch: () => {
        writesLandedByFirstBatch ??= writesLanded;
      },
    });
    importFinished = true;
    await writerLoop;

    // Writes landed DURING the row batches, not merely before or after them.
    expect(writesLandedByFirstBatch).not.toBeNull();
    expect(writesLanded).toBeGreaterThan(writesLandedByFirstBatch ?? 0);
    // And the import still did its whole job.
    expect(await readClimbs(db)).toHaveLength(14);
    expect(await getCheckpoint(db, 'checkpoint:board_climbs:kilter:1:10')).not.toBeNull();
    // The rejected count is not asserted: how many attempts collide with an open
    // batch is a scheduling detail, and requiring collisions would make this flaky.
    expect(writesRejected).toBeGreaterThanOrEqual(0);
  });
});

describe('interruption safety', () => {
  it('propagates the injected error verbatim, stamps NO checkpoint, and re-imports idempotently', async () => {
    const injected = new Error('injected mid-import failure');
    const { db: secondDb } = await freshClientDb('interrupted');
    const adapterPrototype = Object.getPrototypeOf(secondDb) as { runAsync: typeof secondDb.runAsync };
    const realRunAsync = adapterPrototype.runAsync;
    let seenClimbBatches = 0;
    vi.spyOn(adapterPrototype, 'runAsync').mockImplementation(async function (
      this: unknown,
      source: string,
      ...rest: unknown[]
    ) {
      if (source.includes('INSERT OR REPLACE INTO main.board_climbs')) {
        seenClimbBatches += 1;
        if (seenClimbBatches === 3) throw injected;
      }
      return realRunAsync.call(this, source, ...(rest as never[]));
    } as typeof secondDb.runAsync);

    // The single easiest way to get this wrong: the wrapper's unconditional
    // ROLLBACK throwing "cannot rollback - no transaction is active" and MASKING
    // the real error, which the caller dispatches on.
    await expect(
      bootstrapScopeFromSnapshot({
        db: secondDb,
        scope: KILTER_SCOPE,
        scopeKey: KILTER_SCOPE_KEY,
        filePath: artifactPath,
        batchRows: 2,
      }),
    ).rejects.toBe(injected);

    vi.restoreAllMocks();

    // Rows from the committed batches survive; NO marker of any kind does.
    expect((await readClimbs(secondDb)).length).toBeGreaterThan(0);
    expect((await readClimbs(secondDb)).length).toBeLessThan(14);
    expect(await getCheckpoint(secondDb, 'checkpoint:board_climbs:kilter:1:10')).toBeNull();
    expect(await getCheckpoint(secondDb, 'checkpoint:board_climb_stats:kilter:1:10')).toBeNull();
    expect(
      await secondDb.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', ['bootstrap-done:kilter:1:10']),
    ).toBeNull();

    // Re-running to completion lands exactly the uninterrupted row set.
    await bootstrapScopeFromSnapshot({
      db: secondDb,
      scope: KILTER_SCOPE,
      scopeKey: KILTER_SCOPE_KEY,
      filePath: artifactPath,
      batchRows: 2,
    });
    const { db: cleanDb } = await freshClientDb('interrupted-clean');
    await bootstrapScopeFromSnapshot({
      db: cleanDb,
      scope: KILTER_SCOPE,
      scopeKey: KILTER_SCOPE_KEY,
      filePath: artifactPath,
      batchRows: 2,
    });
    expect(await readClimbs(secondDb)).toEqual(await readClimbs(cleanDb));
    expect(await readStats(secondDb)).toEqual(await readStats(cleanDb));
  });

  it('a throwing onBatch consumer neither fails the import nor loses a row', async () => {
    const { db } = await freshClientDb('throwing-consumer');
    let calls = 0;

    const result = await bootstrapScopeFromSnapshot({
      db,
      scope: KILTER_SCOPE,
      scopeKey: KILTER_SCOPE_KEY,
      filePath: artifactPath,
      batchRows: 2,
      onBatch: () => {
        calls += 1;
        throw new Error('the progress consumer blew up');
      },
    });

    expect(calls).toBeGreaterThan(1);
    expect(result.climbsImported).toBe(14);
    expect(result.statsImported).toBe(28);
    expect(await getCheckpoint(db, 'checkpoint:board_climbs:kilter:1:10')).not.toBeNull();
  });
});

describe('a throwing progress consumer', () => {
  // `emitSnapshotFrame` calls `onProgress` with no try/catch of its own. The
  // stage-entry frame is emitted OUTSIDE the import's try, so a throw there
  // charges nothing — but the per-batch frames are emitted from INSIDE it, where
  // an escaping throw would look exactly like an import failure: a spent
  // structural-budget slot out of two, and a deleted ~103 MB artifact.
  it('does not fail the import or move the structural counter', async () => {
    const { db } = await freshClientDb('throwing-onprogress');
    const deleteArtifact = vi.fn(async () => {});
    const source: SnapshotSource = {
      fetchManifest: async () => ({
        formatVersion: SNAPSHOT_MANIFEST_FORMAT_VERSION,
        generatedAt: BUILT_AT,
        entries: [
          {
            boardType: 'kilter',
            layoutId: 1,
            key: 'board-snapshots/v1/kilter/1/2026-08-01.db',
            url: 'https://example.test/kilter-1.db',
            bytes: 4096,
            contentEncoding: 'gzip',
            builtAt: BUILT_AT,
            schemaVersion: LATEST_SCHEMA_VERSION,
            tables: {
              board_climbs: { watermarkUpdatedAt: WATERMARK_AT, watermarkSyncSeq: WATERMARK_SEQ, rowCount: 30 },
              board_climb_stats: { watermarkUpdatedAt: WATERMARK_AT, watermarkSyncSeq: WATERMARK_SEQ, rowCount: 40 },
            },
          },
        ],
      }),
      downloadArtifact: async () => ({ filePath: artifactPath }),
      deleteArtifact,
    };
    let framesOffered = 0;

    await pullSync(db, { invalidateQueries: vi.fn() } as unknown as QueryInvalidator, emptyPageFetch(), {
      enabledBoards: [KILTER_SCOPE_KEY],
      snapshotSource: source,
      // Only the frames this change MOVED throw: the per-batch ones and the
      // terminal one, which are emitted from inside the import's try/catch. The
      // stage-entry frame (the first import frame) is emitted outside it and
      // keeps its existing behaviour — a throw there propagates out of
      // `pullSync` and charges nothing, exactly as it did before.
      onProgress: (progress) => {
        if (progress.snapshot?.stage !== 'import') return;
        framesOffered += 1;
        if (framesOffered === 1) return;
        throw new Error('the progress sink blew up');
      },
    });

    expect(framesOffered).toBeGreaterThan(1);
    // The import landed, checkpoints and all.
    expect(await readClimbs(db)).toHaveLength(14);
    expect(await getCheckpoint(db, 'checkpoint:board_climbs:kilter:1:10')).not.toBeNull();
    expect(await getBootstrapAttempts(db, KILTER_SCOPE_KEY)).toBe(0);
    expect(deleteArtifact).toHaveBeenCalledTimes(1); // the release fallback, not the failure arm
  });
});

describe('purge mid-import', () => {
  it('raises SnapshotWipedError, stamps no checkpoint, and leaves the partial rows reachable by teardown', async () => {
    const { db } = await freshClientDb('purged');
    const adapterPrototype = Object.getPrototypeOf(db) as { runAsync: typeof db.runAsync };
    const realRunAsync = adapterPrototype.runAsync;
    let purged = false;
    vi.spyOn(adapterPrototype, 'runAsync').mockImplementation(async function (
      this: unknown,
      source: string,
      ...rest: unknown[]
    ) {
      const result = await realRunAsync.call(this, source, ...(rest as never[]));
      if (!purged && source.includes('INSERT OR REPLACE INTO main.board_climbs')) {
        purged = true;
        // Latch and release: the epoch stays bumped, so `hasPurgeLanded` reads
        // true for every batch after this one.
        beginScopePurge('kilter:1')();
      }
      return result;
    } as typeof db.runAsync);

    await expect(
      bootstrapScopeFromSnapshot({
        db,
        scope: KILTER_SCOPE,
        scopeKey: KILTER_SCOPE_KEY,
        filePath: artifactPath,
        batchRows: 2,
      }),
    ).rejects.toBeInstanceOf(SnapshotWipedError);

    vi.restoreAllMocks();

    expect(await getCheckpoint(db, 'checkpoint:board_climbs:kilter:1:10')).toBeNull();
    expect(await getCheckpoint(db, 'checkpoint:board_climb_stats:kilter:1:10')).toBeNull();
    const partialClimbs = (await readClimbs(db)).length;
    expect(partialClimbs).toBeGreaterThan(0);

    // Invariant 1 of scope-teardown.ts: the partial state a purge leaves behind
    // is reachable by the existing cleanup, so nothing is stranded on disk.
    await removeBoardScopeData({ db, scope: KILTER_SCOPE, scopeKey: KILTER_SCOPE_KEY, retainedScopes: [] });
    expect(await readClimbs(db)).toHaveLength(0);
    expect(await readStats(db)).toHaveLength(0);
  });
});

describe('a lost lock race is not a bad artifact', () => {
  // `classifyBootstrapFailure` returned 'structural-artifact' UNCONDITIONALLY for
  // the import stage. With ~143 acquisitions instead of one, two lost races would
  // have spent the whole structural budget (MAX_BOOTSTRAP_ATTEMPTS is 2) and
  // settled a board onto the paged crawl for the life of the install.
  it('classifies a locked import as database-locked — its own budget, not structural or transport', () => {
    const locked = new Error('Error code 5: database is locked');
    expect(classifyBootstrapFailure({ cause: locked, stage: 'import' })).toBe('database-locked');
    expect(classifyBootstrapFailure({ cause: new Error('quick_check failed'), stage: 'import' })).toBe(
      'structural-artifact',
    );
  });

  it('charges lock-acquisition wait to importLockWaitMs, not to the phase it waited in', async () => {
    // The conflation this PR exists to undo, one level down: `importReconcileMs`
    // and `importRowsMs` used to be stamped around `runExclusive`, which BEGINs
    // first. A reconcile that executes in 1ms behind a `removeBoardScopeData`
    // would then report the whole busy_timeout + ladder wait, and the follow-up
    // trigger for batching reconcileScope (`importReconcileMs` p90 on
    // `bootstrapHealed = true`) would fire on contention rather than on cost.
    const { db } = await freshClientDb('lock-wait-split');
    const adapterPrototype = Object.getPrototypeOf(db) as { execAsync: typeof db.execAsync };
    const realExecAsync = adapterPrototype.execAsync;
    let exclusiveOpens = 0;
    vi.spyOn(adapterPrototype, 'execAsync').mockImplementation(async function (this: unknown, source: string) {
      if (source === 'BEGIN EXCLUSIVE') {
        exclusiveOpens += 1;
        // The FIRST acquisition is the reconcile's, so the whole injected wait
        // below belongs to `importReconcileMs`'s window and nothing else.
        if (exclusiveOpens === 1) throw new Error('Error code 5: database is locked');
      }
      return realExecAsync.call(this, source);
    } as typeof db.execAsync);

    const WAIT_MS = 40;
    // Real wall time, ignoring the requested rung: the ladder's 250ms would make
    // the case slow for no extra signal. Yields rather than a timer so the SQLite
    // double's microtask ordering is untouched.
    const sleep = async (): Promise<void> => {
      const until = Date.now() + WAIT_MS;
      while (Date.now() < until) await Promise.resolve();
    };

    const result = await bootstrapScopeFromSnapshot({
      db,
      scope: KILTER_SCOPE,
      scopeKey: KILTER_SCOPE_KEY,
      filePath: artifactPath,
      batchRows: 4,
      sleep,
    });

    vi.restoreAllMocks();
    expect(result.importLockWaitMs).toBeGreaterThanOrEqual(WAIT_MS);
    // The wait was subtracted, not charged: a 14-climb fixture's reconcile is
    // ~1ms of work, so this can only clear WAIT_MS if the wait leaked in.
    expect(result.importReconcileMs).toBeLessThan(WAIT_MS);
    // And the hold is measured from AFTER the BEGIN succeeded, so it never
    // contains the wait either.
    expect(result.importLockMaxMs).toBeLessThan(result.importLockWaitMs);
  });

  it('retries a batch that loses BEGIN EXCLUSIVE rather than throwing the import away', async () => {
    const { db } = await freshClientDb('lock-ladder');
    const adapterPrototype = Object.getPrototypeOf(db) as { execAsync: typeof db.execAsync };
    const realExecAsync = adapterPrototype.execAsync;
    let exclusiveOpens = 0;
    vi.spyOn(adapterPrototype, 'execAsync').mockImplementation(async function (this: unknown, source: string) {
      if (source === 'BEGIN EXCLUSIVE') {
        exclusiveOpens += 1;
        if (exclusiveOpens === 3) throw new Error('Error code 5: database is locked');
      }
      return realExecAsync.call(this, source);
    } as typeof db.execAsync);

    const result = await bootstrapScopeFromSnapshot({
      db,
      scope: KILTER_SCOPE,
      scopeKey: KILTER_SCOPE_KEY,
      filePath: artifactPath,
      batchRows: 4,
      sleep: async () => {},
    });

    vi.restoreAllMocks();
    expect(result.climbsImported).toBe(14);
    expect(await getCheckpoint(db, 'checkpoint:board_climbs:kilter:1:10')).not.toBeNull();
  });

  it('keeps the artifact and the structural budget when the import loses the lock for good', async () => {
    const { db } = await freshClientDb('lock-terminal');
    const adapterPrototype = Object.getPrototypeOf(db) as { runAsync: typeof db.runAsync };
    const realRunAsync = adapterPrototype.runAsync;
    // Fails on the FIRST stats batch, i.e. after the climbs batch has already
    // committed — a lost race partway through, not a artifact that never opened.
    let statsBatches = 0;
    vi.spyOn(adapterPrototype, 'runAsync').mockImplementation(async function (
      this: unknown,
      source: string,
      ...rest: unknown[]
    ) {
      if (source.includes('INSERT OR REPLACE INTO main.board_climb_stats')) {
        statsBatches += 1;
        if (statsBatches === 1) throw new Error('Error code 5: database is locked');
      }
      return realRunAsync.call(this, source, ...(rest as never[]));
    } as typeof db.runAsync);

    const deleteArtifact = vi.fn(async () => {});
    // Retention-capable, like the mobile adapter: an artifact the phase did not
    // import is RELEASED, not deleted. The `deleteArtifact` this case is about
    // is the failure arm's, not the release fallback a retention-less source gets.
    const releaseArtifact = vi.fn(async () => {});
    const manifestEntry: SnapshotManifestEntry = {
      boardType: 'kilter',
      layoutId: 1,
      key: 'board-snapshots/v1/kilter/1/2026-08-01.db',
      url: 'https://example.test/kilter-1.db',
      bytes: 4096,
      contentEncoding: 'gzip',
      builtAt: BUILT_AT,
      schemaVersion: LATEST_SCHEMA_VERSION,
      tables: {
        board_climbs: { watermarkUpdatedAt: WATERMARK_AT, watermarkSyncSeq: WATERMARK_SEQ, rowCount: 30 },
        board_climb_stats: { watermarkUpdatedAt: WATERMARK_AT, watermarkSyncSeq: WATERMARK_SEQ, rowCount: 40 },
      },
    };
    const manifest: SnapshotManifest = {
      formatVersion: SNAPSHOT_MANIFEST_FORMAT_VERSION,
      generatedAt: BUILT_AT,
      entries: [manifestEntry],
    };
    const source: SnapshotSource = {
      fetchManifest: async () => manifest,
      // `reused: true` is the arm that DELETES the artifact and spends the
      // once-per-build free round.
      downloadArtifact: async () => ({ filePath: artifactPath, reused: true }),
      deleteArtifact,
      releaseArtifact,
    };

    await pullSync(db, { invalidateQueries: vi.fn() } as unknown as QueryInvalidator, emptyPageFetch(), {
      enabledBoards: [KILTER_SCOPE_KEY],
      snapshotSource: source,
    });

    vi.restoreAllMocks();
    // The 103 MB file was released for the next cycle, not thrown away, and the
    // structural budget did not move.
    expect(deleteArtifact).not.toHaveBeenCalled();
    expect(releaseArtifact).toHaveBeenCalledWith(artifactPath, { imported: false });
    expect(existsSync(artifactPath)).toBe(true);
    expect(await getBootstrapAttempts(db, KILTER_SCOPE_KEY)).toBe(0);
    const { state: retryState } = await readBootstrapRetryState(
      db,
      KILTER_SCOPE_KEY,
      { now: Date.now(), random: () => 0 },
      false,
    );
    expect(retryState.structuralFailures).toBe(0);
    expect(retryState.lastFailureKind).toBe('database-locked');
    // Its OWN budget, not transport's: this very cycle handed the artifact back
    // off disk (`reused: true`) and `clearTransportFailures` ran on the way past,
    // so a transport-charged failure would have been reset before it was charged.
    expect(retryState.lockFailures).toBe(1);
    expect(retryState.transportFailures).toBe(0);
  });

  it('settles onto the paged crawl after MAX_BOOTSTRAP_LOCK_FAILURES instead of looping forever', async () => {
    // The failure this case exists for: charge the lock failure to the TRANSPORT
    // budget and a retained artifact resets it every cycle — `downloadArtifact`
    // short-circuits with `reused: true` having moved zero bytes, and the caller
    // still runs `clearTransportFailures`. The counter can then never reach its
    // cap, the scope is never terminal, `markBootstrapPagedFallback` never runs,
    // and `shouldSkipPagedPull` keeps skipping the crawl on the ~2-minute
    // cooldown (well inside BOOTSTRAP_RETRY_GRACE_WINDOW_MS). A device with
    // persistent write-lock contention would re-ATTACH and re-quick_check the
    // artifact every couple of minutes and never get the board by EITHER path —
    // strictly worse than the two structural strikes this escape replaced.
    const { db } = await freshClientDb('lock-budget-bounded');
    const adapterPrototype = Object.getPrototypeOf(db) as { runAsync: typeof db.runAsync };
    const realRunAsync = adapterPrototype.runAsync;
    // Contention that outlives every cycle: the stats batch never lands.
    vi.spyOn(adapterPrototype, 'runAsync').mockImplementation(async function (
      this: unknown,
      source: string,
      ...rest: unknown[]
    ) {
      if (source.includes('INSERT OR REPLACE INTO main.board_climb_stats')) {
        throw new Error('Error code 5: database is locked');
      }
      return realRunAsync.call(this, source, ...(rest as never[]));
    } as typeof db.runAsync);

    const deleteArtifact = vi.fn(async () => {});
    const manifestEntry: SnapshotManifestEntry = {
      boardType: 'kilter',
      layoutId: 1,
      key: 'board-snapshots/v1/kilter/1/2026-08-01.db',
      url: 'https://example.test/kilter-1.db',
      bytes: 4096,
      contentEncoding: 'gzip',
      builtAt: BUILT_AT,
      schemaVersion: LATEST_SCHEMA_VERSION,
      tables: {
        board_climbs: { watermarkUpdatedAt: WATERMARK_AT, watermarkSyncSeq: WATERMARK_SEQ, rowCount: 30 },
        board_climb_stats: { watermarkUpdatedAt: WATERMARK_AT, watermarkSyncSeq: WATERMARK_SEQ, rowCount: 40 },
      },
    };
    const source: SnapshotSource = {
      fetchManifest: async () => ({
        formatVersion: SNAPSHOT_MANIFEST_FORMAT_VERSION,
        generatedAt: BUILT_AT,
        entries: [manifestEntry],
      }),
      // The retained artifact, cycle after cycle: zero bytes moved.
      downloadArtifact: async () => ({ filePath: artifactPath, reused: true }),
      deleteArtifact,
      releaseArtifact: async () => {},
    };

    // Injected clock rather than fake timers, which fight the SQLite double. Each
    // cycle starts past the previous failure's cooldown rung (2 min, then 15 min),
    // so eligibility is never what stops the loop — the budget is.
    let clockMs = 1_800_000_000_000;
    for (let cycle = 0; cycle < MAX_BOOTSTRAP_LOCK_FAILURES; cycle += 1) {
      await pullSync(db, { invalidateQueries: vi.fn() } as unknown as QueryInvalidator, emptyPageFetch(), {
        enabledBoards: [KILTER_SCOPE_KEY],
        snapshotSource: source,
        now: () => clockMs,
        random: () => 0,
      });
      clockMs += 3 * 60 * 60 * 1000;
    }

    vi.restoreAllMocks();
    const { state: retryState } = await readBootstrapRetryState(
      db,
      KILTER_SCOPE_KEY,
      { now: clockMs, random: () => 0 },
      false,
    );
    // Asserted FIRST because it is the defect, not a detail: on the transport
    // budget this reads `false` after three cycles (and after three hundred),
    // and the two lines below it read `true` and no marker at all.
    expect(isBootstrapRetryTerminal(retryState)).toBe(true);
    // The point of going terminal: the board gets served, slowly, instead of not
    // at all. A fresh scope stops skipping its 400-round-trip crawl.
    expect(shouldSkipPagedPull({ retryState, hasBoardCheckpoint: false, now: clockMs })).toBe(false);
    expect(retryState.lockFailures).toBe(MAX_BOOTSTRAP_LOCK_FAILURES);
    // Never laundered into, or out of, either of the other two budgets.
    expect(retryState.transportFailures).toBe(0);
    expect(retryState.structuralFailures).toBe(0);
    const pagedFallback = await db.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [
      `bootstrap-paged-fallback:${KILTER_SCOPE_KEY}`,
    ]);
    expect(pagedFallback?.value).toBe('1');
    // And the ~103 MB file survives all three: contention is not a bad artifact.
    expect(deleteArtifact).not.toHaveBeenCalled();
    expect(existsSync(artifactPath)).toBe(true);
  });
});
