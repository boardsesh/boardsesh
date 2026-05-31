import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';

import { getCheckpointKey, getCheckpoint, setCheckpoint, deleteCheckpoint, deleteAllCheckpoints } from '../checkpoints';
import type { SyncCheckpoint } from '../checkpoints';

function createMockDb() {
  return {
    runAsync: vi.fn().mockResolvedValue(undefined),
    getFirstAsync: vi.fn().mockResolvedValue(null),
  } as unknown as SQLiteDatabase;
}

describe('getCheckpointKey', () => {
  it('returns table name alone for user data', () => {
    expect(getCheckpointKey('boardsesh_ticks')).toBe('checkpoint:boardsesh_ticks');
  });

  it('returns table name with board type for per-board data', () => {
    expect(getCheckpointKey('board_climbs', 'kilter')).toBe('checkpoint:board_climbs:kilter');
  });

  it('omits board type when undefined', () => {
    expect(getCheckpointKey('playlists', undefined)).toBe('checkpoint:playlists');
  });
});

describe('getCheckpoint', () => {
  let db: SQLiteDatabase;

  beforeEach(() => {
    db = createMockDb();
  });

  it('returns null when no checkpoint exists', async () => {
    (db.getFirstAsync as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await getCheckpoint(db, 'checkpoint:boardsesh_ticks');

    expect(result).toBeNull();
    expect(db.getFirstAsync).toHaveBeenCalledWith('SELECT value FROM sync_meta WHERE key = ?', [
      'checkpoint:boardsesh_ticks',
    ]);
  });

  it('returns parsed checkpoint from stored JSON', async () => {
    const stored: SyncCheckpoint = { updatedAt: '2024-06-01T12:00:00Z', syncSeq: '42' };
    (db.getFirstAsync as ReturnType<typeof vi.fn>).mockResolvedValue({
      value: JSON.stringify(stored),
    });

    const result = await getCheckpoint(db, 'checkpoint:boardsesh_ticks');

    expect(result).toEqual(stored);
  });

  it('returns null when stored value is invalid JSON', async () => {
    (db.getFirstAsync as ReturnType<typeof vi.fn>).mockResolvedValue({
      value: 'not-valid-json{',
    });

    const result = await getCheckpoint(db, 'checkpoint:broken');

    expect(result).toBeNull();
  });
});

describe('setCheckpoint', () => {
  it('writes JSON with INSERT OR REPLACE', async () => {
    const db = createMockDb();
    const checkpoint: SyncCheckpoint = { updatedAt: '2024-06-01T12:00:00Z', syncSeq: '99' };

    await setCheckpoint(db, 'checkpoint:boardsesh_ticks', checkpoint);

    expect(db.runAsync).toHaveBeenCalledWith('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      'checkpoint:boardsesh_ticks',
      JSON.stringify(checkpoint),
    ]);
  });
});

describe('deleteCheckpoint', () => {
  it('deletes by key', async () => {
    const db = createMockDb();

    await deleteCheckpoint(db, 'checkpoint:playlists');

    expect(db.runAsync).toHaveBeenCalledWith('DELETE FROM sync_meta WHERE key = ?', ['checkpoint:playlists']);
  });
});

describe('deleteAllCheckpoints', () => {
  it('deletes all entries with checkpoint: prefix', async () => {
    const db = createMockDb();

    await deleteAllCheckpoints(db);

    expect(db.runAsync).toHaveBeenCalledWith("DELETE FROM sync_meta WHERE key LIKE 'checkpoint:%'");
  });
});
