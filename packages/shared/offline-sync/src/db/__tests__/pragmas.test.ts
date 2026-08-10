// Exercises the connection PRAGMA helpers against the REAL node:sqlite adapter,
// file-backed so WAL (which persists on the file header) actually applies —
// PRAGMA journal_mode = WAL returns "memory" on an in-memory database.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  OFFLINE_DB_BUSY_TIMEOUT_MS,
  OFFLINE_DB_WAL_SWITCH_TIMEOUT_MS,
  applyBusyTimeout,
  configureMainConnection,
} from '../pragmas';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';

let workDir: string;
let dbPath: string;
let db: TestSqliteDb;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'bs-pragmas-'));
  dbPath = join(workDir, 'boardsesh.db');
  db = createTestDatabase(dbPath);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('applyBusyTimeout', () => {
  it('sets busy_timeout to the shared constant on the connection', async () => {
    const before = await db.getFirstAsync<{ timeout: number }>('PRAGMA busy_timeout');
    expect(before?.timeout).toBe(0);

    await applyBusyTimeout(db);

    const after = await db.getFirstAsync<{ timeout: number }>('PRAGMA busy_timeout');
    expect(after?.timeout).toBe(OFFLINE_DB_BUSY_TIMEOUT_MS);
  });
});

describe('configureMainConnection', () => {
  it('switches the file to WAL and sets busy_timeout', async () => {
    await configureMainConnection(db);

    const journal = await db.getFirstAsync<{ journal_mode: string }>('PRAGMA journal_mode');
    expect(journal?.journal_mode?.toLowerCase()).toBe('wal');
    const busy = await db.getFirstAsync<{ timeout: number }>('PRAGMA busy_timeout');
    expect(busy?.timeout).toBe(OFFLINE_DB_BUSY_TIMEOUT_MS);
  });

  it('persists WAL on the file header for later connections, but not busy_timeout', async () => {
    await configureMainConnection(db);

    // A second connection to the same file — the shape withExclusiveTransactionAsync
    // opens per task (useNewConnection: true). WAL comes from the file header;
    // busy_timeout is per-connection and resets to 0, which is exactly why every
    // ephemeral task must call applyBusyTimeout itself.
    const other = createTestDatabase(dbPath);
    const journal = await other.getFirstAsync<{ journal_mode: string }>('PRAGMA journal_mode');
    expect(journal?.journal_mode?.toLowerCase()).toBe('wal');
    const busy = await other.getFirstAsync<{ timeout: number }>('PRAGMA busy_timeout');
    expect(busy?.timeout).toBe(0);
  });
});

// #4104: the WAL switch used to be the FIRST statement of app startup and ran with
// busy_timeout still at 0, and any failure propagated out of initializeDatabase and
// disabled offline storage for the whole session. These pin both halves of the fix
// against a REAL contending connection rather than a mock.
describe('configureMainConnection under contention', () => {
  // A database still in rollback-journal mode — the only state in which the WAL
  // switch does real work, i.e. the first launch after install or upgrade.
  async function createRollbackJournalDatabase(path: string): Promise<TestSqliteDb> {
    const fresh = createTestDatabase(path);
    await fresh.execAsync('PRAGMA journal_mode = delete');
    await fresh.execAsync('CREATE TABLE probe (id INTEGER PRIMARY KEY)');
    return fresh;
  }

  it('sets busy_timeout before it touches journal_mode', async () => {
    const statements: string[] = [];
    const recorder = {
      execAsync: async (source: string) => {
        statements.push(source);
        await db.execAsync(source);
      },
      getFirstAsync: async <T>(source: string): Promise<T | null> => {
        statements.push(source);
        return db.getFirstAsync<T>(source);
      },
    };

    await configureMainConnection(recorder as unknown as TestSqliteDb);

    const firstBusyTimeout = statements.findIndex((sql) => /busy_timeout/i.test(sql));
    const journalSwitch = statements.findIndex((sql) => /journal_mode\s*=/i.test(sql));
    expect(firstBusyTimeout).toBeGreaterThanOrEqual(0);
    expect(journalSwitch).toBeGreaterThanOrEqual(0);
    // The whole point: no statement runs at busy_timeout = 0 any more.
    expect(firstBusyTimeout).toBeLessThan(journalSwitch);
  });

  it('uses the short window for the switch, then raises it for the rest of init', async () => {
    const timeouts: number[] = [];
    const recorder = {
      execAsync: async (source: string) => {
        const match = /busy_timeout\s*=\s*(\d+)/i.exec(source);
        if (match) timeouts.push(Number(match[1]));
        await db.execAsync(source);
      },
      getFirstAsync: async <T>(source: string): Promise<T | null> => db.getFirstAsync<T>(source),
    };

    await configureMainConnection(recorder as unknown as TestSqliteDb);

    // A contending READER makes the switch wait out the whole timeout before failing,
    // so the switch runs under the short one; everything after it wants the full 5s.
    expect(timeouts).toEqual([OFFLINE_DB_WAL_SWITCH_TIMEOUT_MS, OFFLINE_DB_BUSY_TIMEOUT_MS]);
  });

  it('survives a contending writer refusing the WAL switch, and still arms busy_timeout', async () => {
    const contendedPath = join(workDir, 'contended.db');
    const seed = await createRollbackJournalDatabase(contendedPath);
    seed.close();

    const main = createTestDatabase(contendedPath);
    const contender = createTestDatabase(contendedPath);
    // Hold the write lock, exactly like a VACUUM / snapshot import straddling launch.
    await contender.execAsync('BEGIN IMMEDIATE');
    await contender.execAsync('INSERT INTO probe (id) VALUES (1)');

    try {
      // Before the fix this threw "database is locked" straight out of init.
      await expect(configureMainConnection(main)).resolves.toBeUndefined();

      // The switch lost — the file is still in rollback mode, which is CORRECT and
      // survivable. What matters is that init can carry on from here.
      const journal = await main.getFirstAsync<{ journal_mode: string }>('PRAGMA journal_mode');
      expect(journal?.journal_mode?.toLowerCase()).toBe('delete');
      const busy = await main.getFirstAsync<{ timeout: number }>('PRAGMA busy_timeout');
      expect(busy?.timeout).toBe(OFFLINE_DB_BUSY_TIMEOUT_MS);
    } finally {
      await contender.execAsync('ROLLBACK');
      contender.close();
      main.close();
    }
  });

  it('still switches to WAL when nothing is contending', async () => {
    const quietPath = join(workDir, 'quiet.db');
    const seed = await createRollbackJournalDatabase(quietPath);
    seed.close();

    const main = createTestDatabase(quietPath);
    try {
      await configureMainConnection(main);
      const journal = await main.getFirstAsync<{ journal_mode: string }>('PRAGMA journal_mode');
      expect(journal?.journal_mode?.toLowerCase()).toBe('wal');
    } finally {
      main.close();
    }
  });

  it('is a free no-op on a database already in WAL, even with a writer holding the lock', async () => {
    // Why the switch is a first-launch-only risk: once the file header says WAL the
    // pragma takes no lock at all, so post-#3858 devices never contend on it.
    await configureMainConnection(db);

    const contender = createTestDatabase(dbPath);
    await contender.execAsync('CREATE TABLE probe (id INTEGER PRIMARY KEY)');
    await contender.execAsync('BEGIN IMMEDIATE');
    await contender.execAsync('INSERT INTO probe (id) VALUES (1)');

    try {
      await expect(configureMainConnection(db)).resolves.toBeUndefined();
      const journal = await db.getFirstAsync<{ journal_mode: string }>('PRAGMA journal_mode');
      expect(journal?.journal_mode?.toLowerCase()).toBe('wal');
    } finally {
      await contender.execAsync('ROLLBACK');
      contender.close();
    }
  });
});

describe('ephemeral transaction connection', () => {
  it('has its own busy_timeout of 0 until applyBusyTimeout runs inside the task', async () => {
    await configureMainConnection(db);

    let insideDefault: number | undefined;
    let insideAfterApply: number | undefined;
    await db.withExclusiveTransactionAsync(async (txn) => {
      // The task runs on a separate connection: it inherits WAL from the file but
      // starts at busy_timeout = 0, regardless of the main connection's setting.
      insideDefault = (await txn.getFirstAsync<{ timeout: number }>('PRAGMA busy_timeout'))?.timeout;
      await applyBusyTimeout(txn);
      insideAfterApply = (await txn.getFirstAsync<{ timeout: number }>('PRAGMA busy_timeout'))?.timeout;
    });

    expect(insideDefault).toBe(0);
    expect(insideAfterApply).toBe(OFFLINE_DB_BUSY_TIMEOUT_MS);
  });
});
