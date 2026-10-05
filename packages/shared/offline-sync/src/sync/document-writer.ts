import type { SqlExecutor, SqlValue } from '../database';
import { buildMultiRowInsertSql, multiRowChunkSize } from './pull-write';
import { reportExtraColumn, type SchemaDriftReporter } from './schema-compatibility';

/** Coerce canonical JSON using the same representations as the ordinary pull. */
export function toSqliteValue(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return value as SqlValue;
}

/** Shared transaction-level writer for pull pages and canonical saved-climb mirrors. */
export async function writePullDocuments(
  transaction: SqlExecutor,
  tableName: string,
  documents: Record<string, unknown>[],
  allowedColumns: readonly string[],
  transientColumns: readonly string[],
  preserveNewerRows: boolean,
  onSchemaDrift?: SchemaDriftReporter,
): Promise<void> {
  if (documents.length === 0) return;
  // Unknown columns are SKIPPED, not fatal: the backend deploys before OTA
  // clients update, so a newly-added server column must not brick every older
  // client's sync loop. SQL safety is unaffected — the statement's column list
  // below is derived from the allowlist intersection, never from document keys.
  // Drift still surfaces in telemetry (once per table+column per app launch),
  // so a resolver emitting a misnamed column stays observable.
  const allowedColumnSet = new Set(allowedColumns);
  const transientColumnSet = new Set(transientColumns);
  for (const document of documents) {
    const unknownColumns = Object.keys(document).filter(
      (column) => !allowedColumnSet.has(column) && !transientColumnSet.has(column),
    );
    for (const unknownColumn of unknownColumns) {
      reportExtraColumn(onSchemaDrift, { origin: 'pull', tableName, column: unknownColumn });
    }
  }

  // Columns are the union of allowed columns present anywhere in the page (not
  // per-document) — this was already true before batching, since this filter
  // ran once over the whole `documents` array. Batching depends on it: every
  // row in a multi-row VALUES clause must bind the same column list. A
  // document missing a page-wide column binds NULL for it below, same as the
  // single-row INSERT OR REPLACE did (INSERT OR REPLACE still does a whole-row
  // replace, so this matches today's semantics, not just today's SQL shape).
  const columns = allowedColumns.filter((column) =>
    documents.some((document) => Object.prototype.hasOwnProperty.call(document, column)),
  );
  if (columns.length === 0) {
    throw new Error(`Sync document for ${tableName} did not contain any allowed columns`);
  }

  const chunkSize = multiRowChunkSize(columns.length);
  // At most two distinct row counts occur in a page (full chunks + a smaller
  // final chunk), so caching the built SQL by row count avoids rebuilding the
  // same multi-row VALUES string for every full chunk.
  const sqlByRowCount = new Map<number, string>();
  const sqlForRowCount = (rowCount: number): string => {
    let sql = sqlByRowCount.get(rowCount);
    if (!sql) {
      sql = buildMultiRowInsertSql(tableName, columns, rowCount, preserveNewerRows);
      sqlByRowCount.set(rowCount, sql);
    }
    return sql;
  };

  for (let chunkStart = 0; chunkStart < documents.length; chunkStart += chunkSize) {
    const chunk = documents.slice(chunkStart, chunkStart + chunkSize);
    const values: SqlValue[] = [];
    for (const document of chunk) {
      for (const column of columns) {
        values.push(toSqliteValue(document[column]));
      }
    }
    await transaction.runAsync(sqlForRowCount(chunk.length), values);
  }
}
