import type { SQLiteDatabase } from 'expo-sqlite';

export type SyncCheckpoint = {
  updatedAt: string;
  syncSeq: string;
};

export function getCheckpointKey(tableName: string, boardType?: string): string {
  return boardType ? `checkpoint:${tableName}:${boardType}` : `checkpoint:${tableName}`;
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
  await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
    key,
    JSON.stringify(checkpoint),
  ]);
}

export async function deleteCheckpoint(db: SQLiteDatabase, key: string): Promise<void> {
  await db.runAsync('DELETE FROM sync_meta WHERE key = ?', [key]);
}

export async function deleteAllCheckpoints(db: SQLiteDatabase): Promise<void> {
  await db.runAsync("DELETE FROM sync_meta WHERE key LIKE 'checkpoint:%'");
}
