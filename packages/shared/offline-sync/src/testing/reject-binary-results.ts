import type { OfflineDatabase, SqlExecutor, SqlValue } from '../database';

function assertNoBinaryColumns(row: unknown): void {
  if (row === null || typeof row !== 'object') return;
  for (const [column, columnValue] of Object.entries(row)) {
    if (ArrayBuffer.isView(columnValue) || columnValue instanceof ArrayBuffer) {
      throw new Error(`Native binary result in column ${column}; select hex(BLOB) instead`);
    }
  }
}

function flattenParams(params: (SqlValue | SqlValue[])[]): SqlValue[] {
  // Mirror SQLite's array and variadic overloads without flattening other shapes.
  return params.length === 1 && Array.isArray(params[0]) ? params[0] : (params as SqlValue[]);
}

/** Guard real SQLite results, including getFirstAsync and transaction reads. */
export function rejectBinarySqlResults(executor: SqlExecutor): SqlExecutor {
  return {
    execAsync: (source) => executor.execAsync(source),
    runAsync: (source: string, ...params: (SqlValue | SqlValue[])[]) =>
      executor.runAsync(source, flattenParams(params)),
    async getFirstAsync<T>(source: string, ...params: (SqlValue | SqlValue[])[]): Promise<T | null> {
      const row = await executor.getFirstAsync<T>(source, flattenParams(params));
      assertNoBinaryColumns(row);
      return row;
    },
    async getAllAsync<T>(source: string, ...params: (SqlValue | SqlValue[])[]): Promise<T[]> {
      const rows = await executor.getAllAsync<T>(source, flattenParams(params));
      for (const row of rows) assertNoBinaryColumns(row);
      return rows;
    },
  };
}

/** Keep writes unchanged while rejecting native BLOB values on every read. */
export function rejectBinaryDatabaseResults(db: OfflineDatabase): OfflineDatabase {
  return {
    ...rejectBinarySqlResults(db),
    withExclusiveTransactionAsync: (task) =>
      db.withExclusiveTransactionAsync((txn) => task(rejectBinarySqlResults(txn))),
  };
}
