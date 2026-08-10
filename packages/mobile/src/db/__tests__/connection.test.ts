// Exercises clearUserData against the REAL v1 DDL (via node:sqlite): every
// user-data table plus the mutation queue and sync checkpoints must be wiped on
// sign-out, while the expensive board reference cache is left untouched.
//
// Also guards the #3646 retirement: no bundled-seed machinery may come back into
// the DB lifecycle.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const reportErrorMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/error-reporting', () => ({ reportError: reportErrorMock }));

import type { SQLiteDatabase } from 'expo-sqlite';
import { clearUserData, getDatabaseHandle, initializeDatabase, setDatabaseHandle } from '../connection';
import { resetDatabaseInitializationForTests } from '../testing';
import {
  runMigrations,
  setCheckpoint,
  getCheckpoint,
  getCheckpointKey,
  enqueue,
  getPendingCount,
} from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';

let db: TestSqliteDb & SQLiteDatabase;

async function countRows(table: string): Promise<number> {
  const row = await db.getFirstAsync<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`);
  return row?.count ?? 0;
}

beforeEach(async () => {
  // connection.ts is the expo lifecycle seam, so its API is typed against the
  // real SQLiteDatabase; the node adapter satisfies the used surface.
  db = createTestDatabase() as unknown as TestSqliteDb & SQLiteDatabase;
  await runMigrations(db);
});

describe('clearUserData', () => {
  it('clears every user-data table, the mutation queue, and sync checkpoints', async () => {
    const now = '2024-06-01T00:00:00Z';

    await db.runAsync(`INSERT INTO boardsesh_ticks (uuid, board_type, climb_uuid, angle) VALUES (?, ?, ?, ?)`, [
      'tick-1',
      'kilter',
      'climb-1',
      40,
    ]);
    await db.runAsync(`INSERT INTO playlists (uuid, name) VALUES (?, ?)`, ['pl-1', 'Projects']);
    await db.runAsync(`INSERT INTO playlist_climbs (playlist_uuid, climb_uuid) VALUES (?, ?)`, ['pl-1', 'climb-1']);
    await db.runAsync(`INSERT INTO user_favorites (board_name, climb_uuid, angle) VALUES (?, ?, ?)`, [
      'kilter',
      'climb-1',
      40,
    ]);
    await db.runAsync(`INSERT INTO user_follows (following_id) VALUES (?)`, ['user-2']);
    await db.runAsync(`INSERT INTO setter_follows (setter_username) VALUES (?)`, ['setter-x']);
    await db.runAsync(`INSERT INTO playlist_follows (playlist_uuid) VALUES (?)`, ['pl-9']);
    await enqueue(db, 'boardsesh_ticks', 'create', { climbUuid: 'climb-1' }, 'tick-1');
    await setCheckpoint(db, getCheckpointKey('boardsesh_ticks'), { updatedAt: now, syncSeq: '5' });

    // Board reference data that must survive the wipe.
    await db.runAsync(`INSERT INTO board_climbs (uuid, board_type) VALUES (?, ?)`, ['climb-1', 'kilter']);
    await db.runAsync(
      `INSERT INTO board_climb_stats (board_type, climb_uuid, angle, ascensionist_count) VALUES (?, ?, ?, ?)`,
      ['kilter', 'climb-1', 40, 12],
    );

    await clearUserData(db);

    expect(await countRows('boardsesh_ticks')).toBe(0);
    expect(await countRows('playlists')).toBe(0);
    expect(await countRows('playlist_climbs')).toBe(0);
    expect(await countRows('user_favorites')).toBe(0);
    expect(await countRows('user_follows')).toBe(0);
    expect(await countRows('setter_follows')).toBe(0);
    expect(await countRows('playlist_follows')).toBe(0);
    expect(await getPendingCount(db)).toBe(0);
    expect(await getCheckpoint(db, getCheckpointKey('boardsesh_ticks'))).toBeNull();

    // The expensive shared cache is deliberately retained.
    expect(await countRows('board_climbs')).toBe(1);
    expect(await countRows('board_climb_stats')).toBe(1);
  });

  it('is a no-op on an already-empty database', async () => {
    await clearUserData(db);

    expect(await countRows('boardsesh_ticks')).toBe(0);
    expect(await getPendingCount(db)).toBe(0);
  });
});

// #3646 retired the bundled seed-database import (ATTACH + row copy + cursor
// stamping) from initializeDatabase. A behavioural test cannot guard that: the
// seam always resolved to "no asset" in every shipped build, so restoring the code
// changes nothing observable at runtime. The assertion that does bite on revert is
// a source-level one — the seam file is gone and the lifecycle module mentions no
// seed at all.
describe('bundled seed retirement (#3646)', () => {
  const dbModuleDir = fileURLToPath(new URL('../', import.meta.url));

  it('keeps the seed seam module deleted', () => {
    expect(existsSync(join(dbModuleDir, 'seed-asset.ts'))).toBe(false);
  });

  it('leaves no seed machinery in the database lifecycle', () => {
    const lifecycleSource = readFileSync(join(dbModuleDir, 'connection.ts'), 'utf8');
    // Every name the retired path needed. Restoring any part of it trips one.
    expect(lifecycleSource).not.toMatch(
      /resolveSeedAssetModuleId|loadOptionalSeed|SEEDABLE_BOARD_TABLES|seed_checkpoints|ATTACH DATABASE|expo-asset/,
    );
  });
});

// WAL persists on the file header (so it can't be checked on an in-memory DB —
// PRAGMA journal_mode = WAL returns "memory" there), so these run file-backed.
describe('initializeDatabase connection PRAGMAs', () => {
  let dbDir: string;
  let fileDb: TestSqliteDb & SQLiteDatabase;
  let dbPath: string;

  beforeEach(() => {
    // initializeDatabase is single-flight for the process (see activeInitialization),
    // so each test has to start from a clean lifecycle.
    resetDatabaseInitializationForTests();
    setDatabaseHandle(null);
    reportErrorMock.mockClear();
    dbDir = mkdtempSync(join(tmpdir(), 'bs-conn-'));
    dbPath = join(dbDir, 'boardsesh.db');
    fileDb = createTestDatabase(dbPath) as unknown as TestSqliteDb & SQLiteDatabase;
  });

  afterEach(() => {
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('puts the main connection in WAL mode with a 5s busy_timeout', async () => {
    await initializeDatabase(fileDb);

    const journal = await fileDb.getFirstAsync<{ journal_mode: string }>('PRAGMA journal_mode');
    expect(journal?.journal_mode?.toLowerCase()).toBe('wal');
    const busy = await fileDb.getFirstAsync<{ timeout: number }>('PRAGMA busy_timeout');
    expect(busy?.timeout).toBe(5000);
  });

  it('persists WAL on the file so a fresh connection inherits it', async () => {
    await initializeDatabase(fileDb);

    // A separately-opened connection (mirrors the per-task connection
    // withExclusiveTransactionAsync spins up) reads WAL from the file header,
    // but starts with the default busy_timeout of 0 — hence the per-connection set.
    const other = createTestDatabase(dbPath) as unknown as TestSqliteDb & SQLiteDatabase;
    const journal = await other.getFirstAsync<{ journal_mode: string }>('PRAGMA journal_mode');
    expect(journal?.journal_mode?.toLowerCase()).toBe('wal');
    const busy = await other.getFirstAsync<{ timeout: number }>('PRAGMA busy_timeout');
    expect(busy?.timeout).toBe(0);
  });
});

// #4104: startup DDL needs SQLite's single write lock, so a long writer already
// holding the file (a VACUUM, a snapshot import, a teardown still draining across a
// remount or OTA reload) made initializeDatabase throw. It swallowed the error, never
// published the handle, and never tried again — one transient collision disabled
// offline storage for the whole session. These drive that exact interleaving.
describe('initializeDatabase lock contention (#4104)', () => {
  // Mirrors INIT_RETRY_DELAYS_MS[0] in connection.ts — the gap before the first retry.
  // Advancing the fake clock by exactly this much runs attempt 2 and nothing else; if
  // the production backoff changes, these tests fail loudly instead of flaking.
  const FIRST_RETRY_DELAY_MS = 500;

  let dbDir: string;
  let realDb: TestSqliteDb;

  // Stands in for the contended connection: the mutation-queue DDL — the first write
  // initializeDatabase issues — fails with the real Sentry message until `unlock()`.
  function createContendedDatabase(options: { error?: Error } = {}) {
    const failure =
      options.error ?? new Error("Calling the 'execAsync' function has failed → Error code 5: database is locked");
    let locked = true;
    let failures = 0;

    const wrapper = {
      execAsync: async (source: string): Promise<void> => {
        if (locked && /pending_mutations/i.test(source)) {
          failures += 1;
          throw failure;
        }
        await realDb.execAsync(source);
      },
      getFirstAsync: <T>(source: string, ...params: unknown[]): Promise<T | null> =>
        realDb.getFirstAsync<T>(source, ...(params as never[])),
      runAsync: (source: string, ...params: unknown[]) => realDb.runAsync(source, ...(params as never[])),
      withExclusiveTransactionAsync: (task: (txn: unknown) => Promise<void>) =>
        realDb.withExclusiveTransactionAsync(task as never),
    };

    return {
      db: wrapper as unknown as SQLiteDatabase,
      unlock: () => {
        locked = false;
      },
      failures: () => failures,
    };
  }

  beforeEach(() => {
    resetDatabaseInitializationForTests();
    setDatabaseHandle(null);
    reportErrorMock.mockClear();
    dbDir = mkdtempSync(join(tmpdir(), 'bs-lock-'));
    realDb = createTestDatabase(join(dbDir, 'boardsesh.db'));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('does not block app launch on the retry, leaving the handle unpublished for now', async () => {
    // This test deliberately walks away mid-chain, so the retry it leaves pending must
    // sit on the fake clock: afterEach's useRealTimers() discards it, instead of a real
    // timer firing into a later test and publishing a handle or reporting an error there.
    vi.useFakeTimers();
    const contended = createContendedDatabase();

    // Resolves as soon as the FIRST attempt settles — SQLiteProvider renders nothing
    // until onInit resolves, so waiting for retries here would be a black screen.
    await expect(initializeDatabase(contended.db)).resolves.toBeUndefined();

    expect(contended.failures()).toBe(1);
    expect(getDatabaseHandle()).toBeNull();
    // A launch that is still retrying is not yet newsworthy.
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it('publishes the handle once a retry wins, instead of staying dead for the session', async () => {
    // Fake timers, not a real sleep: the gap before the first retry is exactly
    // FIRST_RETRY_DELAY_MS, and a real wait would race the attempt itself under CI load.
    vi.useFakeTimers();
    const contended = createContendedDatabase();

    await initializeDatabase(contended.db);
    expect(getDatabaseHandle()).toBeNull();

    // The contending writer finishes (VACUUM done, import committed).
    contended.unlock();
    await vi.advanceTimersByTimeAsync(FIRST_RETRY_DELAY_MS);

    expect(getDatabaseHandle()).toBe(contended.db);
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it('shares one lifecycle across a remount mid-retry rather than starting a second chain', async () => {
    vi.useFakeTimers();
    const first = createContendedDatabase();
    const second = createContendedDatabase();

    const initial = initializeDatabase(first.db);
    await initial;

    // A remount lands while the retry chain is still pending. SQLiteProvider has no
    // re-entrancy guard, so without the single-flight this would run a second chain —
    // two migration transactions against the one file, i.e. more of the contention
    // being fixed.
    const remount = initializeDatabase(second.db);
    expect(remount).toBe(initial);

    first.unlock();
    await vi.advanceTimersByTimeAsync(FIRST_RETRY_DELAY_MS);

    expect(getDatabaseHandle()).toBe(first.db);
    // The second database was never touched.
    expect(second.failures()).toBe(0);
  });

  it('gives up after the bounded attempt window and reports once, tagged with the phase', async () => {
    vi.useFakeTimers();
    const contended = createContendedDatabase();

    await initializeDatabase(contended.db);
    // Drive the whole backoff chain (500 + 2000 + 5000 + 10000 = 17.5s, inside the 30s ceiling).
    await vi.advanceTimersByTimeAsync(30_000);

    expect(contended.failures()).toBe(5);
    expect(getDatabaseHandle()).toBeNull();
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    const [, context] = reportErrorMock.mock.calls[0];
    expect(context.tags).toMatchObject({ source: 'offline-sync', kind: 'sqlite-init', phase: 'queue-table' });
    expect(context.extra).toMatchObject({ attempts: 5, retryable: true });
  });

  it('does not retry a failure that is not lock contention', async () => {
    // A full disk or a corrupt file fails identically forever; burning the window on
    // it would just delay the report.
    const contended = createContendedDatabase({ error: new Error('disk I/O error') });

    await initializeDatabase(contended.db);

    expect(contended.failures()).toBe(1);
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    const [, context] = reportErrorMock.mock.calls[0];
    expect(context.extra).toMatchObject({ attempts: 1, retryable: false });
  });

  it('lets a later mount try again after the window is exhausted', async () => {
    const exhausted = createContendedDatabase({ error: new Error('disk I/O error') });
    const initial = initializeDatabase(exhausted.db);
    await initial;

    // The chain is over, so the guard must not pin a dead lifecycle for the process.
    const healthy = createContendedDatabase();
    healthy.unlock();
    const retryMount = initializeDatabase(healthy.db);
    expect(retryMount).not.toBe(initial);
    await retryMount;

    expect(getDatabaseHandle()).toBe(healthy.db);
  });
});
