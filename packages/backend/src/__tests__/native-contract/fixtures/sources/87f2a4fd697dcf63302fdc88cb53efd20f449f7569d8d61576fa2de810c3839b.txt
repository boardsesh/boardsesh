import type { SQLiteDatabase } from 'expo-sqlite';

export type SyncCheckpoint = {
  updatedAt: string;
  syncSeq: string;
};

/**
 * Checkpoint key for a table. For per-board tables `scope` is the encoded board
 * scope key (`"boardType:layoutId:sizeId"`), so each downloaded board resumes from
 * its own cursor — e.g. `checkpoint:board_climbs:kilter:1:5`.
 */
export function getCheckpointKey(tableName: string, scope?: string): string {
  return scope ? `checkpoint:${tableName}:${scope}` : `checkpoint:${tableName}`;
}

// Per-scope "initial download finished" marker. A checkpoint proves only that
// the FIRST page landed — a 40k-climb board pulls for minutes, and serving
// local-first reads from a fraction of the catalog (with stats still empty)
// silently truncates search results while fully online. The marker is written
// once a scope's board_climbs AND board_climb_stats pulls have both reached
// their tail; incremental re-syncs keep the data fresh from then on. It is
// deliberately NOT under the `checkpoint:` prefix so the sign-out checkpoint
// wipe (deleteUserCheckpoints/deleteAllCheckpoints) leaves it alone, matching
// the board rows it describes, which also survive as the shared cache.
const SCOPE_COMPLETE_PREFIX = 'scope-complete:';

export async function markScopeDownloadComplete(db: SQLiteDatabase, scopeKey: string): Promise<void> {
  await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
    `${SCOPE_COMPLETE_PREFIX}${scopeKey}`,
    '1',
  ]);
}

export async function isScopeDownloadComplete(db: SQLiteDatabase, scopeKey: string): Promise<boolean> {
  const row = await db.getFirstAsync<{ key: string }>('SELECT key FROM sync_meta WHERE key = ?', [
    `${SCOPE_COMPLETE_PREFIX}${scopeKey}`,
  ]);
  return row !== null;
}

/**
 * The encoded board scope keys ("boardType:layoutId:sizeId") whose initial
 * download completed — both reference tables pulled to the tail. Used by the
 * My Boards UI as the per-scope "available offline" signal (a completed
 * cycle's global lastSyncedAt can't tell one board from another, and a mere
 * checkpoint only proves the first page landed).
 */
export async function getDownloadedScopeKeys(db: SQLiteDatabase): Promise<string[]> {
  const rows = await db.getAllAsync<{ key: string }>('SELECT key FROM sync_meta WHERE key LIKE ?', [
    `${SCOPE_COMPLETE_PREFIX}%`,
  ]);
  return rows.map((row) => row.key.slice(SCOPE_COMPLETE_PREFIX.length));
}

export async function getCheckpoint(db: SQLiteDatabase, key: string): Promise<SyncCheckpoint | null> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [key]);
  if (!row) return null;
  try {
    return JSON.parse(row.value) as SyncCheckpoint;
  } catch {
    return null;
  }
}

export async function setCheckpoint(db: SQLiteDatabase, key: string, checkpoint: SyncCheckpoint): Promise<void> {
  await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [key, JSON.stringify(checkpoint)]);
}

export async function deleteCheckpoint(db: SQLiteDatabase, key: string): Promise<void> {
  await db.runAsync('DELETE FROM sync_meta WHERE key = ?', [key]);
}

export async function deleteAllCheckpoints(db: SQLiteDatabase): Promise<void> {
  await db.runAsync("DELETE FROM sync_meta WHERE key LIKE 'checkpoint:%'");
}

/**
 * Reset only the user-scoped checkpoints (user tables + deletions), preserving the
 * board reference checkpoints (`checkpoint:board_climbs:*` / `board_climb_stats:*`).
 * Used on sign-out: the board rows survive as the shared cache, so their checkpoints
 * must survive too — otherwise the next sign-in re-crawls 200k+ rows from epoch.
 */
export async function deleteUserCheckpoints(db: SQLiteDatabase): Promise<void> {
  await db.runAsync(
    `DELETE FROM sync_meta
     WHERE key LIKE 'checkpoint:%'
       AND key NOT LIKE 'checkpoint:board_climbs:%'
       AND key NOT LIKE 'checkpoint:board_climb_stats:%'`,
  );
}
