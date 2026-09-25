// Structural database + cache-invalidation seams for the offline sync engine.
//
// The engine never imports a concrete SQLite driver: it talks to whatever
// implements these interfaces. expo-sqlite's `SQLiteDatabase` (and the view it
// passes to a `withExclusiveTransactionAsync` task) is structurally assignable
// — mobile call sites pass their handle straight through with no wrapper. The
// node:sqlite adapter in `testing/sqlite-test-db.ts` implements the same
// surface for tests, and a future web consumer would supply a SQLite-WASM/OPFS
// implementation (the engine's SQL is SQLite dialect — `INSERT OR REPLACE`,
// `datetime('now')`, `AUTOINCREMENT` — so a raw IndexedDB adapter cannot back it).
//
// Each statement method is declared twice — array form and variadic form —
// mirroring expo-sqlite's own overload pair. The engine itself always uses the
// array form; the variadic overload exists so expo's `SQLiteDatabase` remains
// structurally assignable.

// Uint8Array is a BLOB, both as a bind and as a column value (expo-sqlite and
// node:sqlite agree). Only the holds index stores blobs.
export type SqlValue = string | number | null | Uint8Array;

export type SqlRunResult = {
  changes: number;
  lastInsertRowId: number;
};

export interface SqlExecutor {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, params: SqlValue[]): Promise<SqlRunResult>;
  runAsync(source: string, ...params: SqlValue[]): Promise<SqlRunResult>;
  getFirstAsync<T>(source: string, params: SqlValue[]): Promise<T | null>;
  getFirstAsync<T>(source: string, ...params: SqlValue[]): Promise<T | null>;
  getAllAsync<T>(source: string, params: SqlValue[]): Promise<T[]>;
  getAllAsync<T>(source: string, ...params: SqlValue[]): Promise<T[]>;
}

export interface OfflineDatabase extends SqlExecutor {
  withExclusiveTransactionAsync(task: (txn: SqlExecutor) => Promise<void>): Promise<void>;
}

/**
 * The one-method slice of TanStack Query's `QueryClient` the engine calls.
 * Declared structurally so the package carries no @tanstack dependency — the
 * app passes its real QueryClient, tests pass a recording fake.
 */
export interface QueryInvalidator {
  invalidateQueries(filters: { queryKey: readonly unknown[] }): unknown;
}
