import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OfflineDatabase } from '../../database';

import {
  getCheckpointKey,
  getCheckpoint,
  setCheckpoint,
  deleteCheckpoint,
  deleteAllCheckpoints,
  deleteUserCheckpoints,
  deleteAllSyncMeta,
  markScopeDownloadComplete,
  isScopeDownloadComplete,
  getDownloadedScopeKeys,
  ensureScopeDownloadStartedAt,
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

// The reset that goes with an explicit sign-out's FULL local wipe (issue #3621),
// where the board rows deleteUserCheckpoints protects are themselves deleted. Runs
// against real node:sqlite for the same reason as the suite above: the guarantee is
// about which rows actually survive, not about which SQL string gets built.
describe('deleteAllSyncMeta', () => {
  let db: TestSqliteDb;

  beforeEach(async () => {
    db = createTestDatabase();
    await runMigrations(db);
  });

  it('leaves no checkpoint behind — user tables and per-board tables alike', async () => {
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

  // Why this is a whole-table DELETE and not a `checkpoint:%` sweep: these markers
  // deliberately live outside that prefix, so a prefix wipe would strand them past
  // the rows they describe — and a stranded `scope-complete:` advertises an empty
  // catalog to local-first search as a whole board.
  it('takes the scope-complete, bootstrap and coverage markers a prefix sweep would strand', async () => {
    await markScopeDownloadComplete(db, 'kilter:1:5');
    await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', ['bootstrap-done:kilter:1:5', '1']);
    await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', ['bootstrap-attempts:kilter:1:5', '2']);
    await setDeletionsCoverageAt(db, Date.now());
    expect(await isScopeDownloadComplete(db, 'kilter:1:5')).toBe(true);

    await deleteAllSyncMeta(db);

    expect(await isScopeDownloadComplete(db, 'kilter:1:5')).toBe(false);
    expect(await getDownloadedScopeKeys(db)).toEqual([]);
    expect(await getDeletionsCoverageAt(db)).toBeNull();
    const remaining = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM sync_meta');
    expect(remaining?.count).toBe(0);
  });

  // schema_version is its own table, not a sync_meta key. If it went too, the next
  // launch would replay every migration over a live database.
  it('leaves the migration state alone', async () => {
    const before = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM schema_version');

    await deleteAllSyncMeta(db);

    const after = await db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM schema_version');
    expect(after?.count).toBe(before?.count);
    expect(after?.count).toBeGreaterThan(0);
  });
});

// The persisted per-scope download start stamp (issue #4310). Before it, the
// start time lived in a Map created per `pullSync` run, so a download that
// spanned cycles — the normal shape for a 100 MB artifact on a phone that
// backgrounds once — reported only the final cycle's slice as `durationMs`.
describe('scope download start stamp', () => {
  let db: TestSqliteDb;

  beforeEach(async () => {
    db = createTestDatabase();
    await runMigrations(db);
  });

  it('records the first start and returns the SAME instant on every later cycle', async () => {
    const first = await ensureScopeDownloadStartedAt(db, 'kilter:1:5', 1_000);
    const second = await ensureScopeDownloadStartedAt(db, 'kilter:1:5', 9_000);

    expect(first).toBe(1_000);
    expect(second).toBe(1_000);
  });

  it('scopes the stamp per board — one download never times another', async () => {
    await ensureScopeDownloadStartedAt(db, 'kilter:1:5', 1_000);

    expect(await ensureScopeDownloadStartedAt(db, 'tension:9:11', 5_000)).toBe(5_000);
  });

  it('is cleared by markScopeDownloadComplete so a later re-download times itself', async () => {
    await ensureScopeDownloadStartedAt(db, 'kilter:1:5', 1_000);

    await markScopeDownloadComplete(db, 'kilter:1:5');

    expect(await ensureScopeDownloadStartedAt(db, 'kilter:1:5', 7_000)).toBe(7_000);
  });

  it('is cleared on sign-out — it is not a `checkpoint:` key, so the wipe must name it', async () => {
    // Left behind, a departing account's stamp is read by the NEXT account
    // months later and reports a multi-week download duration.
    await ensureScopeDownloadStartedAt(db, 'kilter:1:5', 1_000);

    await deleteUserCheckpoints(db);

    expect(await ensureScopeDownloadStartedAt(db, 'kilter:1:5', 7_000)).toBe(7_000);
  });

  it('survives a checkpoint-only wipe, which must not reach past its own prefix', async () => {
    await ensureScopeDownloadStartedAt(db, 'kilter:1:5', 1_000);

    await deleteAllCheckpoints(db);

    expect(await ensureScopeDownloadStartedAt(db, 'kilter:1:5', 7_000)).toBe(1_000);
  });
});
