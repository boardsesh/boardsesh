import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OfflineDatabase } from '../../database';

import {
  getCheckpointKey,
  getCheckpoint,
  setCheckpoint,
  deleteCheckpoint,
  deleteAllCheckpoints,
  deleteUserCheckpoints,
} from '../checkpoints';
import type { SyncCheckpoint } from '../checkpoints';
import { getDeletionsCoverageAt, setDeletionsCoverageAt } from '../deletions-coverage';
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

describe('deleteAllCheckpoints', () => {
  it('deletes all entries with checkpoint: prefix', async () => {
    const db = createMockDb();

    await deleteAllCheckpoints(db);

    expect(db.runAsync).toHaveBeenCalledWith("DELETE FROM sync_meta WHERE key LIKE 'checkpoint:%'");
  });
});

// Regression coverage for the sign-out checkpoint wipe (reviewer-flagged MAJOR:
// board_climb_grades' checkpoint fell through the old hardcoded NOT-LIKE list — its
// rows are board reference data that survives sign-out, per USER_DATA_TABLES_TO_CLEAR
// in packages/mobile/src/db/connection.ts, but its checkpoint was still deleted,
// forcing a full re-crawl on the next sign-in). Runs against real node:sqlite (not the
// call-recording mock above) because the bug lives in whether SQLite's LIKE matching
// actually preserves the right rows, not just in what SQL string gets built.
describe('deleteUserCheckpoints', () => {
  let db: TestSqliteDb;

  beforeEach(async () => {
    db = createTestDatabase();
    await runMigrations(db);
  });

  it('preserves a board_climb_grades checkpoint while deleting a user-data checkpoint', async () => {
    await setCheckpoint(db, 'checkpoint:board_climb_grades:kilter:1:5', {
      updatedAt: '2026-01-01T00:00:00Z',
      syncSeq: '1',
    });
    await setCheckpoint(db, 'checkpoint:boardsesh_ticks', { updatedAt: '2026-01-01T00:00:00Z', syncSeq: '7' });

    await deleteUserCheckpoints(db);

    expect(await getCheckpoint(db, 'checkpoint:board_climb_grades:kilter:1:5')).not.toBeNull();
    expect(await getCheckpoint(db, 'checkpoint:boardsesh_ticks')).toBeNull();
  });

  it('preserves every BOARD_DATA_TABLES checkpoint, so a future per-board table cannot silently regress', async () => {
    // Derived from BOARD_DATA_TABLES (not hardcoded to today's three tables) so this
    // test keeps proving the guarantee even as isPerBoard entries in table-config.ts
    // change — the whole point of making deleteUserCheckpoints dynamic.
    for (const tableName of BOARD_DATA_TABLES) {
      await setCheckpoint(db, `checkpoint:${tableName}:kilter:1:5`, {
        updatedAt: '2026-01-01T00:00:00Z',
        syncSeq: '1',
      });
    }
    await setCheckpoint(db, 'checkpoint:playlists', { updatedAt: '2026-01-01T00:00:00Z', syncSeq: '1' });

    await deleteUserCheckpoints(db);

    for (const tableName of BOARD_DATA_TABLES) {
      expect(await getCheckpoint(db, `checkpoint:${tableName}:kilter:1:5`)).not.toBeNull();
    }
    expect(await getCheckpoint(db, 'checkpoint:playlists')).toBeNull();
  });

  it('clears the deletions-coverage marker so it cannot leak into the next account', async () => {
    // Sign-out rewinds the deletions cursor to the epoch, so the departing
    // account's coverage marker describes nothing. Left behind and stale, it
    // trips the #3474 guard on the NEXT account's first pull: a wasted probe and
    // a reset of tables sign-out already emptied, reported as a coverage reset
    // with rowsCleared: 0.
    await setDeletionsCoverageAt(db, Date.now() - 100 * 24 * 60 * 60 * 1000);

    await deleteUserCheckpoints(db);

    expect(await getDeletionsCoverageAt(db)).toBeNull();
  });
});
