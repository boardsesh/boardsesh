import type { SqlExecutor } from '../database';
import { TABLE_CONFIGS } from './table-config';
import { compareCheckpoints, getCheckpoint, getCheckpointKey, setCheckpoint, type SyncCheckpoint } from './checkpoints';

export const SCHEMA_REFRESH_PREFIX = 'schema-refresh:';
export const REFRESH_START_CURSOR: SyncCheckpoint = { updatedAt: '1970-01-01T00:00:00.000Z', syncSeq: '0' };

export type SchemaRefreshState = SyncCheckpoint & {
  revision: number;
  complete: boolean;
  /** A new full download already covers the prefix; an old delta does not. */
  mode: 'download' | 'refresh';
};

export function schemaRefreshKey(tableName: string, scopeKey: string): string {
  return `${SCHEMA_REFRESH_PREFIX}${tableName}:${scopeKey}`;
}

export async function getSchemaRefreshState(
  db: SqlExecutor,
  tableName: string,
  scopeKey: string,
): Promise<SchemaRefreshState | null> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [
    schemaRefreshKey(tableName, scopeKey),
  ]);
  if (!row) return null;
  try {
    const state: unknown = JSON.parse(row.value);
    if (typeof state !== 'object' || state === null) return null;
    if (
      !('revision' in state) ||
      !Number.isSafeInteger(state.revision) ||
      !('complete' in state) ||
      typeof state.complete !== 'boolean' ||
      !('mode' in state) ||
      (state.mode !== 'download' && state.mode !== 'refresh') ||
      !('updatedAt' in state) ||
      typeof state.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(state.updatedAt)) ||
      !('syncSeq' in state) ||
      typeof state.syncSeq !== 'string' ||
      !/^\d+$/.test(state.syncSeq)
    )
      return null;
    return state as SchemaRefreshState;
  } catch {
    return null;
  }
}

export async function writeSchemaRefreshState(
  db: SqlExecutor,
  tableName: string,
  scopeKey: string,
  state: SchemaRefreshState,
): Promise<void> {
  await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
    schemaRefreshKey(tableName, scopeKey),
    JSON.stringify(state),
  ]);
}

/** Called in the same transaction as a complete snapshot/full-download checkpoint. */
export async function markSchemaRefreshComplete(
  db: SqlExecutor,
  tableName: string,
  scopeKey: string,
  cursor: SyncCheckpoint,
  mode: SchemaRefreshState['mode'] = 'download',
): Promise<void> {
  const revision = TABLE_CONFIGS[tableName].refreshRevision;
  if (!revision) return;
  // Refreshes use a separate cursor so ordinary deltas continue on cellular.
  // Completing a refresh must never regress a checkpoint advanced by those deltas.
  if (mode === 'refresh') {
    const key = getCheckpointKey(tableName, scopeKey);
    const current = await getCheckpoint(db, key);
    if (!current || compareCheckpoints(cursor, current) > 0) await setCheckpoint(db, key, cursor);
  }
  await writeSchemaRefreshState(db, tableName, scopeKey, { ...cursor, revision, complete: true, mode });
}
