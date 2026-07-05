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
