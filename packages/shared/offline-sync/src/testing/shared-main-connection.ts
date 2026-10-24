// Test double for the app's MAIN SQLite connection as it really behaves on a
// phone (issue #5851): one long-lived connection that every local read shares,
// in WAL mode with a 5 s busy timeout, while the engine's transactions each run
// on a fresh connection.
//
// What the plain node adapter cannot show is the state a phone's main
// connection is usually in when the engine writes through it. expo runs async
// calls on a concurrent pool, and a convenience query keeps its statement open
// between the native `run` that steps the first row and the `finalize` a JS hop
// later. So the main connection is very often inside a READ transaction, and an
// autocommit write on it is a read→write upgrade. SQLite never runs the busy
// handler for an upgrade: it fails the write at once with SQLITE_BUSY when
// another connection holds the lock, or with SQLITE_BUSY_SNAPSHOT (517, printed
// as "database is locked") when another connection has committed since the read
// began — however long the busy timeout.
//
// Built on real node:sqlite connections over one FILE, so every SQLite answer
// here is the engine's own, not a stub's. The knobs below only decide WHEN a
// read is in flight or a teardown lands.

import { DatabaseSync } from 'node:sqlite';
import type { OfflineDatabase, SqlExecutor, SqlRunResult, SqlValue } from '../database';
import type { TestSqliteDb } from './sqlite-test-db';

type Params = (SqlValue | SqlValue[])[];

function normalizeParams(params: Params): SqlValue[] {
  const flattened = params.length === 1 && Array.isArray(params[0]) ? params[0] : (params as SqlValue[]);
  return flattened.map((value) => (value === undefined ? null : value));
}

/** The error expo raises when a statement lost the write lock. */
export function sqliteLockedError(method: 'execAsync' | 'runAsync' = 'execAsync'): Error {
  const owner = method === 'execAsync' ? 'NativeDatabase' : 'NativeStatement';
  return new Error(
    `Call to function '${owner}.${method}' has been rejected.\n→ Caused by: Error code 5: database is locked`,
  );
}

export type SharedMainConnection = {
  /** The handle to give the engine. */
  db: OfflineDatabase;
  /** Every write the engine sent through the MAIN connection, in order. */
  mainWrites: string[];
  /**
   * Before every main-connection write, put a local read mid-step on the main
   * connection and have ANOTHER connection commit: the condition a phone is in
   * whenever the climb list refetches while anything else writes.
   */
  setReadsInFlight: (enabled: boolean) => void;
  /**
   * Run `teardown` the next time the engine goes for the write lock after
   * `trigger` matches a main-connection read: before its next main write (which
   * then lands after the teardown committed, as a write queued behind it does),
   * or before its next `BEGIN IMMEDIATE` (which then loses that attempt, as one
   * that waited out its busy timeout behind the teardown does).
   */
  armTeardown: (trigger: (sql: string, params: SqlValue[]) => boolean, teardown: () => Promise<void>) => void;
  /**
   * The first time a main-connection read matches `trigger`, open a read on the
   * main connection, then run `concurrentWrite` on another connection. Every
   * main read after that sees the snapshot from before the write, until close().
   */
  holdStaleSnapshot: (
    trigger: (sql: string, params: SqlValue[]) => boolean,
    concurrentWrite: (side: DatabaseSync) => void,
  ) => void;
  close: () => void;
};

/**
 * `transactions` must be a FILE-backed `createTestDatabase` over `filePath`, so
 * each engine transaction runs on its own connection exactly as on a phone.
 */
export function openSharedMainConnection(filePath: string, transactions: TestSqliteDb): SharedMainConnection {
  const main = new DatabaseSync(filePath);
  main.exec('PRAGMA journal_mode = WAL');
  main.exec('PRAGMA busy_timeout = 5000');
  const side = new DatabaseSync(filePath);
  side.exec('PRAGMA busy_timeout = 5000');
  side.exec('CREATE TABLE IF NOT EXISTS test_concurrent_writes (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT)');
  // A read needs a row to stay mid-step on.
  side.exec("INSERT INTO test_concurrent_writes (at) VALUES ('seed'), ('seed')");

  const mainWrites: string[] = [];
  let readsInFlight = false;
  let teardownTrigger: ((sql: string, params: SqlValue[]) => boolean) | null = null;
  let armedTeardown: (() => Promise<void>) | null = null;
  let pendingTeardown: (() => Promise<void>) | null = null;
  let staleTrigger: ((sql: string, params: SqlValue[]) => boolean) | null = null;
  let staleWrite: ((side: DatabaseSync) => void) | null = null;
  let staleRead: IterableIterator<unknown> | null = null;

  const noteRead = (sql: string, params: SqlValue[]): void => {
    if (teardownTrigger && armedTeardown && teardownTrigger(sql, params)) {
      pendingTeardown = armedTeardown;
      teardownTrigger = null;
      armedTeardown = null;
    }
    if (staleTrigger && staleWrite && staleTrigger(sql, params)) {
      staleRead = main.prepare('SELECT id FROM test_concurrent_writes').iterate();
      staleRead.next();
      staleWrite(side);
      staleTrigger = null;
      staleWrite = null;
    }
  };

  const runPendingTeardown = async (): Promise<boolean> => {
    const teardown = pendingTeardown;
    if (!teardown) return false;
    pendingTeardown = null;
    await teardown();
    return true;
  };

  const writeOnMain = async <T>(sql: string, write: () => T): Promise<T> => {
    mainWrites.push(sql);
    await runPendingTeardown();
    if (!readsInFlight) return write();
    const inFlight = main.prepare('SELECT id FROM test_concurrent_writes').iterate();
    inFlight.next();
    side.exec("INSERT INTO test_concurrent_writes (at) VALUES ('concurrent commit')");
    try {
      return write();
    } finally {
      inFlight.return?.();
    }
  };

  const isWrite = (sql: string): boolean => !/^\s*(SELECT|PRAGMA\s+\w+\s*$|DETACH)/i.test(sql);

  const wrapTransaction = (txn: SqlExecutor): SqlExecutor =>
    ({
      execAsync: async (sql: string) => {
        if (/^\s*BEGIN IMMEDIATE\s*$/i.test(sql) && (await runPendingTeardown())) {
          throw sqliteLockedError('execAsync');
        }
        return txn.execAsync(sql);
      },
      runAsync: (sql: string, ...params: Params) => txn.runAsync(sql, normalizeParams(params)),
      getFirstAsync: (sql: string, ...params: Params) => txn.getFirstAsync(sql, normalizeParams(params)),
      getAllAsync: (sql: string, ...params: Params) => txn.getAllAsync(sql, normalizeParams(params)),
    }) as unknown as SqlExecutor;

  const db = {
    execAsync: async (sql: string) => {
      if (isWrite(sql)) return writeOnMain(sql, () => main.exec(sql));
      main.exec(sql);
    },
    runAsync: async (sql: string, ...params: Params): Promise<SqlRunResult> => {
      const bound = normalizeParams(params);
      return writeOnMain(sql, () => {
        const result = main.prepare(sql).run(...bound);
        return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
      });
    },
    getFirstAsync: async <T>(sql: string, ...params: Params): Promise<T | null> => {
      const bound = normalizeParams(params);
      noteRead(sql, bound);
      return (main.prepare(sql).get(...bound) as T | undefined) ?? null;
    },
    getAllAsync: async <T>(sql: string, ...params: Params): Promise<T[]> => {
      const bound = normalizeParams(params);
      noteRead(sql, bound);
      return main.prepare(sql).all(...bound) as T[];
    },
    withExclusiveTransactionAsync: (task: (txn: SqlExecutor) => Promise<void>) =>
      transactions.withExclusiveTransactionAsync((txn) => task(wrapTransaction(txn))),
  } as unknown as OfflineDatabase;

  return {
    db,
    mainWrites,
    setReadsInFlight: (enabled) => {
      readsInFlight = enabled;
    },
    armTeardown: (trigger, teardown) => {
      teardownTrigger = trigger;
      armedTeardown = teardown;
    },
    holdStaleSnapshot: (trigger, concurrentWrite) => {
      staleTrigger = trigger;
      staleWrite = concurrentWrite;
    },
    close: () => {
      staleRead?.return?.();
      main.close();
      side.close();
    },
  };
}
