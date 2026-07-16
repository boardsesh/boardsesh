import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OfflineDatabase } from '../../database';

import {
  getCheckpointKey,
  getCheckpoint,
  setCheckpoint,
  deleteCheckpoint,
  deleteAllSyncMeta,
  markScopeDownloadComplete,
  isScopeDownloadComplete,
} from '../checkpoints';
import type { SyncCheckpoint } from '../checkpoints';
import { BOARD_DATA_TABLES } from '../table-config';
import { runMigrations } from '../../db/migrations';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';

function createMockDb() {
  return {
    runAsync: vi.fn().mockResolvedValue(undefined),
    getFirstAsync: vi.fn().mockResolvedValue(null),
  } as unknown as OfflineDatabase;
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
  let db: OfflineDatabase;

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

// Sign-out's reset. Runs against real node:sqlite (not the call-recording mock
// above) because the guarantee is about which rows actually survive, not about what
// SQL string gets built.
describe('deleteAllSyncMeta', () => {
  let db: TestSqliteDb;

  beforeEach(async () => {
    db = createTestDatabase();
    await runMigrations(db);
  });

  it('leaves nothing behind — no checkpoint of any table, user or per-board', async () => {
    // Derived from BOARD_DATA_TABLES rather than hardcoded to today's three tables,
    // so a future isPerBoard entry in table-config.ts is covered automatically.
    for (const tableName of BOARD_DATA_TABLES) {
      await setCheckpoint(db, `checkpoint:${tableName}:kilter:1:5`, {
        updatedAt: '2026-01-01T00:00:00Z',
        syncSeq: '1',
      });
    }
    await setCheckpoint(db, 'checkpoint:boardsesh_ticks', { updatedAt: '2026-01-01T00:00:00Z', syncSeq: '7' });
    await setCheckpoint(db, 'checkpoint:deletions', { updatedAt: '2026-01-01T00:00:00Z', syncSeq: '3' });

    await deleteAllSyncMeta(db);

    for (const tableName of BOARD_DATA_TABLES) {
      expect(await getCheckpoint(db, `checkpoint:${tableName}:kilter:1:5`)).toBeNull();
    }
    expect(await getCheckpoint(db, 'checkpoint:boardsesh_ticks')).toBeNull();
    expect(await getCheckpoint(db, 'checkpoint:deletions')).toBeNull();
  });

  // The reason this is a whole-table DELETE and not a `checkpoint:%` sweep: these
  // markers deliberately live outside that prefix, so a prefix wipe would strand
  // them past the rows they describe.
  it('takes the scope-complete and bootstrap markers a prefix sweep would strand', async () => {
    await markScopeDownloadComplete(db, 'kilter:1:5');
    await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', ['bootstrap-done:kilter:1:5', '1']);
    await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', ['bootstrap-attempts:kilter:1:5', '2']);

    await deleteAllSyncMeta(db);

    expect(await isScopeDownloadComplete(db, 'kilter:1:5')).toBe(false);
    const remaining = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM sync_meta');
    expect(remaining?.count).toBe(0);
  });
});
