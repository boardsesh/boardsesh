import type { SqlExecutor, SqlValue } from '../database';
import { buildMultiRowInsertSql, multiRowChunkSize } from './pull-write';
import { reportExtraColumn, type SchemaDriftReporter } from './schema-compatibility';
import { climbMutationEntityKey } from '../mutation-queue/queue';
import { isQuantumRetirement, quantumRetirementSql } from './quantum-retirement';
import { getCheckpointKey } from './checkpoints';

const QUANTUM_REFERENCE_TABLES = ['board_climb_stats', 'board_climb_grades'] as const;

async function retiredPublicCandidates(
  transaction: SqlExecutor,
  documents: readonly Record<string, unknown>[],
): Promise<string[]> {
  const published = documents
    .filter(
      (document) =>
        document.board_type === 'quantum' &&
        document.is_listed === true &&
        document.is_boardsesh_authored === false &&
        document.user_id === null &&
        typeof document.controller_route_uuid === 'string',
    )
    .map((document) => String(document.uuid));
  if (!published.length) return [];
  const retired = await transaction.getAllAsync<{ uuid: string }>(
    `SELECT uuid FROM board_climbs WHERE ${quantumRetirementSql()}
      AND uuid IN (${published.map(() => '?').join(', ')})`,
    published,
  );
  return retired.map((row) => row.uuid);
}

async function replayRestoredQuantumReferences(transaction: SqlExecutor, previouslyRetired: string[]): Promise<void> {
  if (!previouslyRetired.length) return;
  // Check the persisted row after the cursor guard. A stale public page must
  // neither reopen the route nor clear checkpoints for one still withdrawn.
  const restoredLayouts = await transaction.getAllAsync<{ layout_id: number }>(
    `SELECT DISTINCT layout_id FROM board_climbs
      WHERE board_type = 'quantum' AND is_listed = 1
        AND uuid IN (${previouslyRetired.map(() => '?').join(', ')})`,
    previouslyRetired,
  );
  for (const { layout_id: layoutId } of restoredLayouts) {
    for (const referenceTable of QUANTUM_REFERENCE_TABLES) {
      // The server retains these reference rows during withdrawal. They may
      // have older cursors than the ones this device already walked.
      await transaction.runAsync('DELETE FROM sync_meta WHERE key LIKE ?', [
        getCheckpointKey(referenceTable, `quantum:${layoutId}:%`),
      ]);
    }
  }
}

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
  documents: readonly Record<string, unknown>[],
  allowedColumns: readonly string[],
  transientColumns: readonly string[],
  preserveNewerRows: boolean,
  onSchemaDrift?: SchemaDriftReporter,
  acknowledgedMutationKey?: string,
): Promise<void> {
  if (documents.length === 0) return;
  let writableDocuments = documents;
  if (tableName === 'board_climbs') {
    // Pulls and mirrors share this transaction-level guard. Ignore only the
    // operation being acknowledged: a later queued edit still owns its fields.
    const pendingClimbs = await transaction.getAllAsync<{ entity_key: string }>(
      `SELECT DISTINCT entity_key FROM pending_mutations WHERE table_name = 'board_climbs'
       AND entity_key IS NOT NULL AND (? IS NULL OR idempotency_key <> ?)`,
      [acknowledgedMutationKey ?? null, acknowledgedMutationKey ?? null],
    );
    const protectedClimbs = new Set(pendingClimbs.map((mutation) => mutation.entity_key));
    writableDocuments = documents.filter(
      (document) => !protectedClimbs.has(climbMutationEntityKey(String(document.board_type), String(document.uuid))),
    );
    if (writableDocuments.length === 0) return;
  }
  const previouslyRetired =
    tableName === 'board_climbs' ? await retiredPublicCandidates(transaction, writableDocuments) : [];
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
    writableDocuments.some((document) => Object.prototype.hasOwnProperty.call(document, column)),
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

  for (let chunkStart = 0; chunkStart < writableDocuments.length; chunkStart += chunkSize) {
    let chunk = writableDocuments.slice(chunkStart, chunkStart + chunkSize);
    if (tableName === 'board_climb_stats' || tableName === 'board_climb_grades') {
      const quantumClimbUuids = chunk
        .filter((document) => document.board_type === 'quantum' && typeof document.climb_uuid === 'string')
        .map((document) => String(document.climb_uuid));
      if (quantumClimbUuids.length > 0) {
        const retiredRows = await transaction.getAllAsync<{ uuid: string }>(
          `SELECT uuid FROM board_climbs WHERE ${quantumRetirementSql()}
            AND uuid IN (${quantumClimbUuids.map(() => '?').join(', ')})`,
          quantumClimbUuids,
        );
        const retiredUuids = new Set(retiredRows.map((row) => row.uuid));
        chunk = chunk.filter(
          (document) => document.board_type !== 'quantum' || !retiredUuids.has(String(document.climb_uuid)),
        );
      }
    }
    if (chunk.length === 0) continue;
    const values: SqlValue[] = [];
    for (const document of chunk) {
      for (const column of columns) {
        values.push(toSqliteValue(document[column]));
      }
    }
    await transaction.runAsync(sqlForRowCount(chunk.length), values);
    if (tableName === 'board_climbs') {
      const retirements = chunk.filter(isQuantumRetirement).map((document) => String(document.uuid));
      if (retirements.length === 0) continue;
      for (const referenceTable of QUANTUM_REFERENCE_TABLES) {
        // Read the resulting row: an older page may have lost the cursor guard
        // to a newer public version, whose references must remain intact.
        await transaction.runAsync(
          `DELETE FROM ${referenceTable} WHERE board_type = 'quantum' AND climb_uuid IN (
             SELECT uuid FROM board_climbs WHERE ${quantumRetirementSql()}
               AND uuid IN (${retirements.map(() => '?').join(', ')}))`,
          retirements,
        );
      }
    }
  }
  await replayRestoredQuantumReferences(transaction, previouslyRetired);
}
