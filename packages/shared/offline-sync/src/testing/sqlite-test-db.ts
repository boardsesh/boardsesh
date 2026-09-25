// Test-only adapter wrapping Node's built-in `node:sqlite` (available since
// Node 22) behind the async OfflineDatabase surface the sync / mutation-queue
// code calls (the same shape expo-sqlite's SQLiteDatabase satisfies). Native
// expo-sqlite cannot load in vitest's node environment, so this gives real
// round-trip coverage of the actual DDL and SQL without mocking the engine.
//
// Only the methods our code under test uses are implemented:
//   execAsync, runAsync, getFirstAsync, getAllAsync, withExclusiveTransactionAsync.

import { DatabaseSync } from 'node:sqlite';
import type { OfflineDatabase } from '../database';

type SqlBindValue = string | number | null | Uint8Array;

// expo-sqlite accepts both `(sql, [a, b])` and `(sql, a, b)`; mirror that so call
// sites (the variadic migration runner and the array-passing offline hooks) both
// work. node:sqlite needs null (not undefined) for missing binds.
function normalizeParams(params: (SqlBindValue | SqlBindValue[])[]): SqlBindValue[] {
  const flattened = params.length === 1 && Array.isArray(params[0]) ? params[0] : (params as SqlBindValue[]);
  return flattened.map((value) => (value === undefined ? null : value));
}

class NodeSqliteAdapter {
  private readonly db: DatabaseSync;
  private readonly location: string;
  private inTransaction = false;

  constructor(db: DatabaseSync, location: string) {
    this.db = db;
    this.location = location;
  }

  async execAsync(source: string): Promise<void> {
    this.db.exec(source);
  }

  async runAsync(
    source: string,
    ...params: (SqlBindValue | SqlBindValue[])[]
  ): Promise<{ changes: number; lastInsertRowId: number }> {
    const statement = this.db.prepare(source);
    const result = statement.run(...normalizeParams(params));
    return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
  }

  async getFirstAsync<T>(source: string, ...params: (SqlBindValue | SqlBindValue[])[]): Promise<T | null> {
    const statement = this.db.prepare(source);
    const row = statement.get(...normalizeParams(params));
    return (row as T | undefined) ?? null;
  }

  async getAllAsync<T>(source: string, ...params: (SqlBindValue | SqlBindValue[])[]): Promise<T[]> {
    const statement = this.db.prepare(source);
    return statement.all(...normalizeParams(params)) as T[];
  }

  async withExclusiveTransactionAsync(task: (txn: NodeSqliteAdapter) => Promise<void>): Promise<void> {
    if (this.inTransaction) {
      await task(this);
      return;
    }

    // File-backed databases mirror expo-sqlite EXACTLY: withExclusiveTransactionAsync
    // opens a NEW native connection (`useNewConnection: true`) for the task, so
    // per-connection state from the main connection — ATTACHed databases, temp
    // tables, PRAGMAs — is NOT visible inside it, and the wrapper's shape is
    // BEGIN → task → COMMIT (ROLLBACK on throw) → close. Snapshot bootstrap
    // shipped with an ATTACH the transaction couldn't see because the old
    // same-connection model here hid the difference (Sentry BOARDSESH-AA) —
    // suites exercising cross-connection behaviour must use a file-backed DB.
    if (this.location !== ':memory:') {
      const transactionDb = new DatabaseSync(this.location);
      const transactionAdapter = new NodeSqliteAdapter(transactionDb, this.location);
      transactionAdapter.inTransaction = true;
      let taskError: unknown;
      try {
        transactionDb.exec('BEGIN');
        await task(transactionAdapter);
        transactionDb.exec('COMMIT');
      } catch (error) {
        // Mirror expo: ROLLBACK runs unconditionally; if it throws (no open
        // transaction), THAT error propagates and masks the task's — the exact
        // behaviour bootstrap's restore-BEGIN guard exists for.
        transactionDb.exec('ROLLBACK');
        taskError = error;
      } finally {
        transactionDb.close();
      }
      if (taskError) throw taskError;
      return;
    }

    // In-memory databases can't be opened from a second connection; model the
    // contract with BEGIN/COMMIT on this connection and roll back on failure.
    this.inTransaction = true;
    this.db.exec('BEGIN');
    try {
      await task(this);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  close(): void {
    this.db.close();
  }
}

export type TestSqliteDb = NodeSqliteAdapter & OfflineDatabase;

/**
 * Opens a database adapted to the OfflineDatabase surface. Defaults to
 * in-memory; pass a file path to get expo-faithful exclusive-transaction
 * semantics (the task runs on a SEPARATE connection — see
 * withExclusiveTransactionAsync above). Any suite touching ATTACH, temp
 * tables, or per-connection PRAGMAs inside a transaction must be file-backed
 * or it tests semantics the device doesn't have.
 */
export function createTestDatabase(location: string = ':memory:'): TestSqliteDb {
  const adapter = new NodeSqliteAdapter(new DatabaseSync(location), location);
  // The adapter's variadic methods satisfy OfflineDatabase's overload pair
  // behaviorally; cast through unknown so call sites get the interface type.
  return adapter as unknown as TestSqliteDb;
}

/** Lists user-defined table names, excluding sqlite internal bookkeeping. */
export async function listTables(db: OfflineDatabase): Promise<string[]> {
  const rows = await db.getAllAsync<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  return rows.map((row) => row.name);
}

/** Returns the column names of a table in definition order. */
export async function tableColumns(db: OfflineDatabase, tableName: string): Promise<string[]> {
  const rows = await db.getAllAsync<{ name: string }>(`SELECT name FROM pragma_table_info('${tableName}')`);
  return rows.map((row) => row.name);
}

/** Returns the primary-key column names of a table, ordered by their PK position. */
export async function primaryKeyColumns(db: OfflineDatabase, tableName: string): Promise<string[]> {
  const rows = await db.getAllAsync<{ name: string; pk: number }>(
    `SELECT name, pk FROM pragma_table_info('${tableName}') WHERE pk > 0 ORDER BY pk`,
  );
  return rows.map((row) => row.name);
}
