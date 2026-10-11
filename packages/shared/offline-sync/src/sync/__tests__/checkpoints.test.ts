import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OfflineDatabase } from '../../database';

import {
  getCheckpointKey,
  getCheckpoint,
  setCheckpoint,
  getProtectedCheckpoint,
  setProtectedCheckpoint,
  isScopeProtectedComplete,
  resetProtectedSyncState,
  resetScopeProtectedSyncState,
  deleteCheckpoint,
  deleteAllCheckpoints,
  deleteUserCheckpoints,
  deleteAllSyncMeta,
  markScopeDownloadComplete,
  isScopeDownloadComplete,
  getDownloadedScopeKeys,
  ensureScopeDownloadStartedAt,
  LEGACY_FIRST_ASCENT_SCRUB_KEY,
} from '../checkpoints';
import type { ProtectedCheckpoint, SyncCheckpoint } from '../checkpoints';
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
  it('binds the key and the cursor as JSON, and nothing else of what it was handed', async () => {
    const db = createMockDb();
    const checkpoint = { updatedAt: '2024-06-01T12:00:00Z', syncSeq: '99', revision: 3 } as SyncCheckpoint;

    await setCheckpoint(db, 'checkpoint:boardsesh_ticks', checkpoint);

    expect(db.runAsync).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO sync_meta (key, value)'), [
      'checkpoint:boardsesh_ticks',
      JSON.stringify({ updatedAt: '2024-06-01T12:00:00Z', syncSeq: '99' }),
    ]);
  });
});

// Issue #6306. A board table is pulled as two streams, and both cursors live in
// one `sync_meta` row: the reference cursor at the top level, in the shape every
// earlier bundle wrote, and the protected cursor nested under `protected`.
// Against real node:sqlite, because the guarantee is in what the JSON functions
// do to a stored row.
describe('two cursors in one checkpoint row', () => {
  const CLIMBS_KEY = 'checkpoint:board_climbs:kilter:1:10';
  const REFERENCE: SyncCheckpoint = { updatedAt: '2026-06-01T00:00:00.000Z', syncSeq: '900' };
  const PROTECTED: ProtectedCheckpoint = {
    updatedAt: '2026-05-01T00:00:00.000Z',
    syncSeq: '40',
    complete: true,
    revision: 1,
  };
  let db: TestSqliteDb;

  beforeEach(async () => {
    db = createTestDatabase();
    await runMigrations(db);
  });

  const rawValue = async (key: string): Promise<string | null> =>
    (await db.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [key]))?.value ?? null;
  const rawRow = async (key: string): Promise<Record<string, unknown> | null> => {
    const value = await rawValue(key);
    return value === null ? null : (JSON.parse(value) as Record<string, unknown>);
  };
  /** `setCheckpoint` as every bundle before the split wrote it: the whole row, replaced. */
  const olderBundleSetCheckpoint = (key: string, checkpoint: SyncCheckpoint) =>
    db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [key, JSON.stringify(checkpoint)]);

  it('keeps each cursor when the other one is written, in either order', async () => {
    await setCheckpoint(db, CLIMBS_KEY, REFERENCE);
    await setProtectedCheckpoint(db, CLIMBS_KEY, PROTECTED);
    expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(REFERENCE);
    expect(await getProtectedCheckpoint(db, CLIMBS_KEY)).toEqual(PROTECTED);

    const laterReference = { updatedAt: '2026-06-02T00:00:00.000Z', syncSeq: '950' };
    await setCheckpoint(db, CLIMBS_KEY, laterReference);
    expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(laterReference);
    expect(await getProtectedCheckpoint(db, CLIMBS_KEY)).toEqual(PROTECTED);

    const laterProtected = { ...PROTECTED, syncSeq: '41' };
    await setProtectedCheckpoint(db, CLIMBS_KEY, laterProtected);
    expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(laterReference);
    expect(await getProtectedCheckpoint(db, CLIMBS_KEY)).toEqual(laterProtected);
  });

  it('returns the reference cursor alone, never the protected one riding in the row', async () => {
    await setCheckpoint(db, CLIMBS_KEY, REFERENCE);
    await setProtectedCheckpoint(db, CLIMBS_KEY, PROTECTED);

    expect(Object.keys((await getCheckpoint(db, CLIMBS_KEY)) ?? {}).sort()).toEqual(['syncSeq', 'updatedAt']);
  });

  it('reads an absent protected cursor as null: replay from the epoch, not complete', async () => {
    expect(await getProtectedCheckpoint(db, CLIMBS_KEY)).toBeNull();
    await setCheckpoint(db, CLIMBS_KEY, REFERENCE);
    expect(await getProtectedCheckpoint(db, CLIMBS_KEY)).toBeNull();
  });

  describe('a row that only carries a protected cursor', () => {
    it('has no reference cursor for this bundle, and the epoch for an older one', async () => {
      await setProtectedCheckpoint(db, CLIMBS_KEY, PROTECTED);

      // This bundle: the reference stream has consumed nothing.
      expect(await getCheckpoint(db, CLIMBS_KEY)).toBeNull();
      // An older bundle reads the top level as its cursor and replays the table.
      expect(await rawRow(CLIMBS_KEY)).toMatchObject({ updatedAt: '1970-01-01T00:00:00.000Z', syncSeq: '0' });
    });

    it('becomes an ordinary row once the reference stream writes its first cursor', async () => {
      await setProtectedCheckpoint(db, CLIMBS_KEY, PROTECTED);
      await setCheckpoint(db, CLIMBS_KEY, REFERENCE);

      expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(REFERENCE);
      expect(await getProtectedCheckpoint(db, CLIMBS_KEY)).toEqual(PROTECTED);
      expect(await rawRow(CLIMBS_KEY)).not.toHaveProperty('referenceUnset');
    });

    it('is told apart from a reference cursor genuinely stamped at the epoch', async () => {
      // What an import of an artifact with no row for the scope stamps.
      const epoch = { updatedAt: '1970-01-01T00:00:00.000Z', syncSeq: '0' };
      await setCheckpoint(db, CLIMBS_KEY, epoch);
      await setProtectedCheckpoint(db, CLIMBS_KEY, PROTECTED);

      expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(epoch);
    });
  });

  // The rollback half. An older bundle knows one cursor per row and nothing of
  // `protected`. Whatever it does to the row has to leave this bundle with a
  // cursor that is either right or absent.
  describe('after an older bundle touched the row', () => {
    beforeEach(async () => {
      await setCheckpoint(db, CLIMBS_KEY, REFERENCE);
      await setProtectedCheckpoint(db, CLIMBS_KEY, PROTECTED);
    });

    it('finds a cursor it can use in a row this bundle wrote', async () => {
      // Its `getCheckpoint` was `JSON.parse(value) as SyncCheckpoint`.
      const asOlderBundleReadsIt = JSON.parse((await rawValue(CLIMBS_KEY)) ?? '') as SyncCheckpoint;
      expect(asOlderBundleReadsIt.updatedAt).toBe(REFERENCE.updatedAt);
      expect(asOlderBundleReadsIt.syncSeq).toBe(REFERENCE.syncSeq);
    });

    it('loses the protected cursor to its rewrite, so this bundle replays', async () => {
      const unionCursor = { updatedAt: '2026-06-03T00:00:00.000Z', syncSeq: '990' };
      await olderBundleSetCheckpoint(CLIMBS_KEY, unionCursor);

      expect(await getProtectedCheckpoint(db, CLIMBS_KEY)).toBeNull();
      expect(await isScopeProtectedComplete(db, 'kilter:1:10')).toBe(false);
      // What it wrote is a position in the one stream it pulls, which carries
      // every reference row, so it is a valid place to resume the reference stream.
      expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(unionCursor);
    });

    it('loses both cursors to its revalidation, which deleted every board checkpoint', async () => {
      await db.runAsync('DELETE FROM sync_meta WHERE key LIKE ?', ['checkpoint:board_climbs:%']);

      expect(await getCheckpoint(db, CLIMBS_KEY)).toBeNull();
      expect(await getProtectedCheckpoint(db, CLIMBS_KEY)).toBeNull();
    });
  });

  describe('a row neither cursor can be read from', () => {
    it.each(['not-valid-json{', '1', '[]', 'null'])('replaces %s when either cursor is written', async (garbage) => {
      await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [CLIMBS_KEY, garbage]);
      expect(await getCheckpoint(db, CLIMBS_KEY)).toBeNull();
      expect(await getProtectedCheckpoint(db, CLIMBS_KEY)).toBeNull();

      await setProtectedCheckpoint(db, CLIMBS_KEY, PROTECTED);
      expect(await getProtectedCheckpoint(db, CLIMBS_KEY)).toEqual(PROTECTED);

      await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [CLIMBS_KEY, garbage]);
      await setCheckpoint(db, CLIMBS_KEY, REFERENCE);
      expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(REFERENCE);
    });

    it.each([
      ['a string', '"complete"'],
      ['no completeness', JSON.stringify({ updatedAt: PROTECTED.updatedAt, syncSeq: '40', revision: 1 })],
      ['a numeric sequence', JSON.stringify({ ...PROTECTED, syncSeq: 40 })],
      ['a date that is not one', JSON.stringify({ ...PROTECTED, updatedAt: 'yesterday' })],
      ['no revision', JSON.stringify({ updatedAt: PROTECTED.updatedAt, syncSeq: '40', complete: true })],
    ])('reads a protected value that is %s as absent', async (_label, storedProtected) => {
      await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
        CLIMBS_KEY,
        `{"updatedAt":"${REFERENCE.updatedAt}","syncSeq":"900","protected":${storedProtected}}`,
      ]);

      expect(await getProtectedCheckpoint(db, CLIMBS_KEY)).toBeNull();
      expect(await getCheckpoint(db, CLIMBS_KEY)).toEqual(REFERENCE);
    });
  });

  describe('isScopeProtectedComplete', () => {
    const stampComplete = async (tableName: string, scopeKey: string, complete = true) =>
      setProtectedCheckpoint(db, getCheckpointKey(tableName, scopeKey), { ...PROTECTED, complete });

    it('needs every table the scope pulls a protected stream for', async () => {
      const scopeKey = 'kilter:1:10';
      expect(await isScopeProtectedComplete(db, scopeKey)).toBe(false);
      await stampComplete('board_climbs', scopeKey);
      await stampComplete('board_climb_stats', scopeKey);
      expect(await isScopeProtectedComplete(db, scopeKey)).toBe(false);
      await stampComplete('board_climb_grades', scopeKey);
      // A catalogue board has no wall row, so `spray_walls` is not asked of it.
      expect(await isScopeProtectedComplete(db, scopeKey)).toBe(true);
    });

    it('asks a spray scope for its wall as well', async () => {
      const scopeKey = 'spray:7:7';
      for (const tableName of ['board_climbs', 'board_climb_stats', 'board_climb_grades']) {
        await stampComplete(tableName, scopeKey);
      }
      expect(await isScopeProtectedComplete(db, scopeKey)).toBe(false);
      await stampComplete('spray_walls', scopeKey);
      expect(await isScopeProtectedComplete(db, scopeKey)).toBe(true);
    });

    it('is false while one stream is still mid-replay, and for a key that is not a scope', async () => {
      const scopeKey = 'kilter:1:10';
      await stampComplete('board_climbs', scopeKey);
      await stampComplete('board_climb_stats', scopeKey, false);
      await stampComplete('board_climb_grades', scopeKey);
      expect(await isScopeProtectedComplete(db, scopeKey)).toBe(false);
      expect(await isScopeProtectedComplete(db, 'kilter')).toBe(false);
    });

    it('does not let one scope vouch for another', async () => {
      for (const tableName of ['board_climbs', 'board_climb_stats', 'board_climb_grades']) {
        await stampComplete(tableName, 'kilter:1:10');
      }
      expect(await isScopeProtectedComplete(db, 'kilter:1:1')).toBe(false);
      expect(await isScopeProtectedComplete(db, 'kilter:1:100')).toBe(false);
    });
  });

  describe('resetProtectedSyncState', () => {
    it('forgets every protected cursor on every board and leaves each reference cursor byte for byte', async () => {
      const scopes = ['kilter:1:10', 'tension:9:6', 'spray:7:7'];
      const referenceBefore = new Map<string, string>();
      for (const scopeKey of scopes) {
        for (const tableName of BOARD_DATA_TABLES) {
          const key = getCheckpointKey(tableName, scopeKey);
          if (!scopeKey.startsWith('spray') && tableName !== 'spray_walls') {
            await setCheckpoint(db, key, REFERENCE);
            referenceBefore.set(key, (await rawValue(key)) ?? '');
          }
          await setProtectedCheckpoint(db, key, PROTECTED);
        }
      }

      await resetProtectedSyncState(db);

      for (const scopeKey of scopes) {
        expect(await isScopeProtectedComplete(db, scopeKey)).toBe(false);
        for (const tableName of BOARD_DATA_TABLES) {
          expect(await getProtectedCheckpoint(db, getCheckpointKey(tableName, scopeKey))).toBeNull();
        }
      }
      for (const [key, value] of referenceBefore) expect(await rawValue(key)).toBe(value);
    });

    it('deletes a row that only ever carried a protected cursor', async () => {
      const wallKey = 'checkpoint:spray_walls:spray:7:7';
      await setProtectedCheckpoint(db, wallKey, PROTECTED);

      await resetProtectedSyncState(db);

      expect(await rawValue(wallKey)).toBeNull();
    });

    it('touches nothing else in sync_meta', async () => {
      await setCheckpoint(db, 'checkpoint:boardsesh_ticks', REFERENCE);
      await setCheckpoint(db, 'checkpoint:deletions', REFERENCE);
      await setCheckpoint(db, 'checkpoint:user_data_complete', REFERENCE);
      await markScopeDownloadComplete(db, 'kilter:1:10');
      const untouched: Record<string, string> = {
        'bootstrap-done:kilter:1:10': '2',
        'schema-refresh:board_climbs:kilter:1:10': '{"revision":1,"complete":true}',
        'holds-index:kilter:1:10': '{"syncSeq":5}',
        'privacy:catalog-viewer:v1': '{"viewerId":"viewer"}',
        [LEGACY_FIRST_ASCENT_SCRUB_KEY]: '1',
        // Unreadable rows must be skipped, not fail the statement: the privacy
        // purge runs this in its transaction and could never commit otherwise.
        'checkpoint:board_climbs:kilter:2:10': 'not-valid-json{',
        'checkpoint:board_climb_stats:kilter:2:10': '[]',
      };
      for (const [key, value] of Object.entries(untouched)) {
        await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [key, value]);
      }
      const before = await db.getAllAsync('SELECT key, value FROM sync_meta ORDER BY key');

      await resetProtectedSyncState(db);

      expect(await db.getAllAsync('SELECT key, value FROM sync_meta ORDER BY key')).toEqual(before);
    });

    it('resets one scope and leaves its neighbours, when asked for one scope', async () => {
      for (const scopeKey of ['kilter:1:10', 'kilter:1:1']) {
        for (const tableName of ['board_climbs', 'board_climb_stats', 'board_climb_grades']) {
          await setCheckpoint(db, getCheckpointKey(tableName, scopeKey), REFERENCE);
          await setProtectedCheckpoint(db, getCheckpointKey(tableName, scopeKey), PROTECTED);
        }
      }

      await resetScopeProtectedSyncState(db, 'kilter:1:10');

      expect(await isScopeProtectedComplete(db, 'kilter:1:10')).toBe(false);
      expect(await getCheckpoint(db, 'checkpoint:board_climbs:kilter:1:10')).toEqual(REFERENCE);
      expect(await isScopeProtectedComplete(db, 'kilter:1:1')).toBe(true);
    });
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

  // The board rows survive a sign-out as a shared cache and so do their
  // reference cursors. How far the DEPARTING account's authorized rows were
  // pulled is that account's, so the next one replays them (issue #6306).
  it('resets the protected cursors and keeps the reference ones beside them', async () => {
    const reference = { updatedAt: '2026-01-01T00:00:00Z', syncSeq: '1' };
    for (const tableName of ['board_climbs', 'board_climb_stats', 'board_climb_grades']) {
      await setCheckpoint(db, `checkpoint:${tableName}:kilter:1:5`, reference);
      await setProtectedCheckpoint(db, `checkpoint:${tableName}:kilter:1:5`, {
        updatedAt: '2025-12-01T00:00:00Z',
        syncSeq: '9',
        complete: true,
        revision: 1,
      });
    }
    await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', [LEGACY_FIRST_ASCENT_SCRUB_KEY, '1']);
    expect(await isScopeProtectedComplete(db, 'kilter:1:5')).toBe(true);

    await deleteUserCheckpoints(db);

    expect(await isScopeProtectedComplete(db, 'kilter:1:5')).toBe(false);
    for (const tableName of ['board_climbs', 'board_climb_stats', 'board_climb_grades']) {
      expect(await getCheckpoint(db, `checkpoint:${tableName}:kilter:1:5`)).toEqual(reference);
      expect(await getProtectedCheckpoint(db, `checkpoint:${tableName}:kilter:1:5`)).toBeNull();
    }
    // The rows stay scrubbed, so the note that they were stays too.
    expect(
      await db.getFirstAsync('SELECT value FROM sync_meta WHERE key = ?', [LEGACY_FIRST_ASCENT_SCRUB_KEY]),
    ).toEqual({ value: '1' });
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
