// Exercises the connection PRAGMA helpers against the REAL node:sqlite adapter,
// file-backed so WAL (which persists on the file header) actually applies —
// PRAGMA journal_mode = WAL returns "memory" on an in-memory database.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  OFFLINE_DB_BUSY_TIMEOUT_MS,
  OFFLINE_DB_FOREGROUND_WRITE_TIMEOUT_MS,
  OFFLINE_DB_WAL_SWITCH_TIMEOUT_MS,
  OFFLINE_DB_RETRY_BUSY_TIMEOUT_MS,
  OFFLINE_DB_FALLBACK_BUSY_TIMEOUT_MS,
  applyBusyTimeout,
  applyBulkImportPragmas,
  beginImmediateWrite,
  configureMainConnection,
} from '../pragmas';
import { isDatabaseLockedError } from '../lock-errors';
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

  // The retry ladder shortens the wait on later attempts (issue #4315): attempt 1
  // already sat out the full five seconds, so a second full wait buys little.
  it('honours an explicit timeout for a retry attempt', async () => {
    await applyBusyTimeout(db, OFFLINE_DB_RETRY_BUSY_TIMEOUT_MS);

    const after = await db.getFirstAsync<{ timeout: number }>('PRAGMA busy_timeout');
    expect(after?.timeout).toBe(OFFLINE_DB_RETRY_BUSY_TIMEOUT_MS);
    expect(OFFLINE_DB_RETRY_BUSY_TIMEOUT_MS).toBeLessThan(OFFLINE_DB_BUSY_TIMEOUT_MS);
  });

  it('honours the shorter fallback timeout for the last-chance write', async () => {
    await applyBusyTimeout(db, OFFLINE_DB_FALLBACK_BUSY_TIMEOUT_MS);

    const after = await db.getFirstAsync<{ timeout: number }>('PRAGMA busy_timeout');
    expect(after?.timeout).toBe(OFFLINE_DB_FALLBACK_BUSY_TIMEOUT_MS);
    expect(OFFLINE_DB_FALLBACK_BUSY_TIMEOUT_MS).toBeLessThan(OFFLINE_DB_RETRY_BUSY_TIMEOUT_MS);
  });

  // The ladder shortens each rung, and a user-facing first attempt is shorter than
  // the background default because somebody is holding a phone waiting for it.
  it('orders the ladder from the foreground attempt down to the fallback', () => {
    expect(OFFLINE_DB_FOREGROUND_WRITE_TIMEOUT_MS).toBeLessThan(OFFLINE_DB_BUSY_TIMEOUT_MS);
    expect(OFFLINE_DB_RETRY_BUSY_TIMEOUT_MS).toBeLessThan(OFFLINE_DB_FOREGROUND_WRITE_TIMEOUT_MS);
    expect(OFFLINE_DB_FALLBACK_BUSY_TIMEOUT_MS).toBeLessThan(OFFLINE_DB_RETRY_BUSY_TIMEOUT_MS);
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

// #4332: expo's `withExclusiveTransactionAsync` opens a DEFERRED `BEGIN`, so a task
// that reads before it writes — every tick and favorite does, for the owner stamp —
// opens for READING and then has to upgrade. SQLite does not run the busy handler on
// that upgrade, which made `busy_timeout` dead code on every user-facing offline
// write: the pragma said "wait five seconds" and the tick died in about a
// millisecond. These tests assert the WAIT, not the pragma's value. A test that only
// checked "the contended write throws" passes in both worlds, which is exactly how
// this shipped.
describe('beginImmediateWrite', () => {
  // Short enough to keep the suite fast, wide enough that "failed instantly" and
  // "waited out the timeout" cannot be confused on a loaded CI box: a failure has
  // 400ms of scheduling jitter to spend before it reads as a wait, and a wait has
  // 200ms of slack under the timeout it is supposed to sit out.
  const CONTENDED_TIMEOUT_MS = 1000;
  const FAILED_INSTANTLY_MS = 400;
  const WAITED_MS = 800;

  /** Runs a transaction task and hands back what escaped, or null if it committed. */
  async function captureFailure(task: (txn: TestSqliteDb) => Promise<void>): Promise<unknown> {
    try {
      await db.withExclusiveTransactionAsync(task);
      return null;
    } catch (error) {
      return error;
    }
  }

  beforeEach(async () => {
    // WAL, exactly as the device runs it — the snapshot semantics below only exist there.
    await configureMainConnection(db);
    await db.execAsync('CREATE TABLE probe (id INTEGER PRIMARY KEY, note TEXT)');
    await db.runAsync('INSERT INTO probe (id, note) VALUES (?, ?)', [1, 'seed']);
  });

  describe('with another connection holding the write lock', () => {
    let holder: TestSqliteDb;

    beforeEach(async () => {
      // A snapshot import, a scope teardown, a VACUUM. It never releases inside a
      // test: node:sqlite is synchronous, so a holder cannot let go while another
      // connection blocks the same thread. Elapsed time is therefore the assertion.
      holder = createTestDatabase(dbPath);
      await holder.execAsync('BEGIN IMMEDIATE');
      await holder.runAsync('INSERT INTO probe (id, note) VALUES (?, ?)', [2, 'held']);
    });

    afterEach(async () => {
      await holder.execAsync('ROLLBACK').catch(() => {});
      holder.close();
    });

    it('pins the bug: a read-first deferred task never consults busy_timeout', async () => {
      const startedAt = Date.now();
      const error = await captureFailure(async (txn) => {
        await applyBusyTimeout(txn, CONTENDED_TIMEOUT_MS);
        // The owner-stamp read every tick and favorite write starts with.
        await txn.getFirstAsync('SELECT id FROM probe LIMIT 1');
        await txn.runAsync('INSERT INTO probe (id, note) VALUES (?, ?)', [3, 'tick']);
      });

      expect((error as Error | null)?.message).toMatch(/database is locked/i);
      expect(Date.now() - startedAt).toBeLessThan(FAILED_INSTANTLY_MS);
    });

    it('waits out the whole busy_timeout once the transaction opens IMMEDIATE', async () => {
      const startedAt = Date.now();
      const error = await captureFailure(async (txn) => {
        await beginImmediateWrite(txn, CONTENDED_TIMEOUT_MS);
        await txn.getFirstAsync('SELECT id FROM probe LIMIT 1');
        await txn.runAsync('INSERT INTO probe (id, note) VALUES (?, ?)', [3, 'tick']);
      });

      expect((error as Error | null)?.message).toMatch(/database is locked/i);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(WAITED_MS);
    });

    // The catch inside beginImmediateWrite is load-bearing, not defensive dressing.
    it("lets the ORIGINAL lock error escape expo's unconditional ROLLBACK", async () => {
      // Without the guard: a losing `BEGIN IMMEDIATE` leaves no open transaction, so
      // the wrapper's ROLLBACK throws over the top of the lock error. The retry
      // ladder would then see a broken database rather than contention, stop
      // retrying, and file the failure under a brand-new Sentry aggregate.
      const unguarded = await captureFailure(async (txn) => {
        await applyBusyTimeout(txn, CONTENDED_TIMEOUT_MS);
        await txn.execAsync('COMMIT');
        await txn.execAsync('BEGIN IMMEDIATE');
      });
      expect((unguarded as Error | null)?.message).toMatch(/no transaction is active/i);
      expect(isDatabaseLockedError(unguarded)).toBe(false);

      // With the guard: the lock error survives intact and still classifies.
      const guarded = await captureFailure(async (txn) => {
        await beginImmediateWrite(txn, CONTENDED_TIMEOUT_MS);
      });
      expect((guarded as Error | null)?.message).toMatch(/database is locked/i);
      expect(isDatabaseLockedError(guarded)).toBe(true);
    });
  });

  it('commits the write when nothing contends', async () => {
    await db.withExclusiveTransactionAsync(async (txn) => {
      await beginImmediateWrite(txn, OFFLINE_DB_BUSY_TIMEOUT_MS);
      await txn.getFirstAsync('SELECT id FROM probe LIMIT 1');
      await txn.runAsync('INSERT INTO probe (id, note) VALUES (?, ?)', [4, 'landed']);
    });

    const row = await db.getFirstAsync<{ note: string }>('SELECT note FROM probe WHERE id = 4');
    expect(row?.note).toBe('landed');
  });

  // The case no `busy_timeout` can survive at any value: SQLITE_BUSY_SNAPSHOT (517,
  // which prints as a plain "database is locked"). A deferred task takes its WAL read
  // snapshot at the SELECT, and if any other connection commits before the task's
  // INSERT the upgrade is refused OUTRIGHT — not waited on, not retried. Opening
  // IMMEDIATE takes the write lock first, so nothing can move the snapshot underneath.
  it('cannot lose a WAL snapshot race, because the write lock is taken up front', async () => {
    const interloper = createTestDatabase(dbPath);
    // Fail fast rather than block: node:sqlite is synchronous, so an interloper that
    // waited would deadlock the test thread against the transaction it is racing.
    await interloper.execAsync('PRAGMA busy_timeout = 0');

    try {
      const startedAt = Date.now();
      const deferredError = await captureFailure(async (txn) => {
        // The FULL five seconds armed, and it still buys nothing.
        await applyBusyTimeout(txn, OFFLINE_DB_BUSY_TIMEOUT_MS);
        await txn.getFirstAsync('SELECT id FROM probe LIMIT 1');
        await interloper.runAsync('INSERT INTO probe (id, note) VALUES (?, ?)', [5, 'moved the snapshot']);
        await txn.runAsync('INSERT INTO probe (id, note) VALUES (?, ?)', [6, 'tick']);
      });
      expect((deferredError as Error | null)?.message).toMatch(/database is locked/i);
      expect(Date.now() - startedAt).toBeLessThan(FAILED_INSTANTLY_MS);

      await db.withExclusiveTransactionAsync(async (txn) => {
        await beginImmediateWrite(txn, OFFLINE_DB_BUSY_TIMEOUT_MS);
        await txn.getFirstAsync('SELECT id FROM probe LIMIT 1');
        // Same interleaving, opposite outcome: the interloper is the one that loses.
        await expect(
          interloper.runAsync('INSERT INTO probe (id, note) VALUES (?, ?)', [7, 'interloper']),
        ).rejects.toThrow(/database is locked/i);
        await txn.runAsync('INSERT INTO probe (id, note) VALUES (?, ?)', [8, 'tick']);
      });

      const row = await db.getFirstAsync<{ note: string }>('SELECT note FROM probe WHERE id = 8');
      expect(row?.note).toBe('tick');
    } finally {
      interloper.close();
    }
  });
});

describe('applyBulkImportPragmas', () => {
  // The snapshot import commits ~142 times instead of once (issue #4310); under
  // the default FULL every one of those pays an fsync, which would make the
  // batched import slower than the single transaction it replaces.
  it('drops synchronous to NORMAL on this connection only', async () => {
    const before = await db.getFirstAsync<{ synchronous: number }>('PRAGMA synchronous');
    expect(before?.synchronous).toBe(2);

    await applyBulkImportPragmas(db);

    const after = await db.getFirstAsync<{ synchronous: number }>('PRAGMA synchronous');
    expect(after?.synchronous).toBe(1);

    // A SECOND connection to the same file is untouched: `synchronous` is
    // per-connection, unlike `journal_mode`, which persists in the file header.
    const other = createTestDatabase(dbPath);
    const otherSynchronous = await other.getFirstAsync<{ synchronous: number }>('PRAGMA synchronous');
    expect(otherSynchronous?.synchronous).toBe(2);
  });

  it('leaves journal_mode alone', async () => {
    await configureMainConnection(db);
    await applyBulkImportPragmas(db);

    const journal = await db.getFirstAsync<{ journal_mode: string }>('PRAGMA journal_mode');
    expect(journal?.journal_mode).toBe('wal');
  });

  // SQLite REFUSES the pragma inside a transaction rather than silently ignoring
  // it, which is what makes "call it in the autocommit preamble" enforceable
  // rather than a comment nobody checks.
  it('throws when called inside a transaction', async () => {
    await db.execAsync('BEGIN');
    await expect(applyBulkImportPragmas(db)).rejects.toThrow(/Safety level may not be changed/i);
    await db.execAsync('COMMIT');
  });
});
