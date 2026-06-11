// Test-only adapter wrapping Node's built-in `node:sqlite` (available since
// Node 22) behind the async surface our DB / sync / mutation-queue code calls on
// expo-sqlite's SQLiteDatabase. Native expo-sqlite cannot load in vitest's node
// environment, so this gives real round-trip coverage of the actual DDL and SQL
// without mocking the database engine.
//
// Only the methods our code under test uses are implemented:
//   execAsync, runAsync, getFirstAsync, getAllAsync, withExclusiveTransactionAsync.

import { DatabaseSync } from 'node:sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';

type SqlBindValue = string | number | null;

// expo-sqlite accepts both `(sql, [a, b])` and `(sql, a, b)`; mirror that so call
// sites (the variadic migration runner and the array-passing offline hooks) both
// work. node:sqlite needs null (not undefined) for missing binds.
function normalizeParams(params: (SqlBindValue | SqlBindValue[])[]): SqlBindValue[] {
  const flattened = params.length === 1 && Array.isArray(params[0]) ? params[0] : (params as SqlBindValue[]);
  return flattened.map((value) => (value === undefined ? null : value));
}

class NodeSqliteAdapter {
  private readonly db: DatabaseSync;
  private inTransaction = false;

  constructor(db: DatabaseSync) {
    this.db = db;
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
    // node:sqlite has no separate transaction connection; model the contract with
    // BEGIN/COMMIT on this connection and roll back on failure. Nesting is guarded
    // because our code never nests exclusive transactions.
    if (this.inTransaction) {
      await task(this);
      return;
    }
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

export type TestSqliteDb = NodeSqliteAdapter & SQLiteDatabase;

/** Opens a fresh in-memory database adapted to the SQLiteDatabase surface. */
export function createTestDatabase(): TestSqliteDb {
  const adapter = new NodeSqliteAdapter(new DatabaseSync(':memory:'));
  // The adapter implements only the subset of SQLiteDatabase our code touches;
  // cast through unknown so call sites get the real type without re-declaring it.
  return adapter as unknown as TestSqliteDb;
}

/** Lists user-defined table names, excluding sqlite internal bookkeeping. */
export async function listTables(db: SQLiteDatabase): Promise<string[]> {
  const rows = await db.getAllAsync<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  return rows.map((row) => row.name);
}

/** Returns the column names of a table in definition order. */
export async function tableColumns(db: SQLiteDatabase, tableName: string): Promise<string[]> {
  const rows = await db.getAllAsync<{ name: string }>(`SELECT name FROM pragma_table_info('${tableName}')`);
  return rows.map((row) => row.name);
}

/** Returns the primary-key column names of a table, ordered by their PK position. */
export async function primaryKeyColumns(db: SQLiteDatabase, tableName: string): Promise<string[]> {
  const rows = await db.getAllAsync<{ name: string; pk: number }>(
    `SELECT name, pk FROM pragma_table_info('${tableName}') WHERE pk > 0 ORDER BY pk`,
  );
  return rows.map((row) => row.name);
}
