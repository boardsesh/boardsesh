import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockStorage = new Map<string, string>();
vi.mock('react-native-mmkv', () => {
  const createMockInstance = () => ({
    getString: (key: string) => mockStorage.get(key),
    set: (key: string, value: string) => mockStorage.set(key, value),
    remove: (key: string) => mockStorage.delete(key),
    clearAll: () => mockStorage.clear(),
  });
  return { createMMKV: vi.fn(() => createMockInstance()) };
});

import { resetProtectedSyncState, runMigrations } from '@boardsesh/offline-sync';
import {
  createTestDatabase,
  markScopeDownloaded,
  markScopeProtectedComplete,
  type TestSqliteDb,
} from '@boardsesh/offline-sync/testing';
import {
  isBoardDownloadedLocally,
  isBoardTypeDownloadedLocally,
  isBoardTypeProtectedSettled,
  hasDownloadedBoardData,
  isClimbLayoutDownloadedLocally,
} from '../board-download-status';
import { markScopeDownloadComplete } from '@boardsesh/offline-sync';
import { setSetting, resetAllSettings } from '../../../settings/hooks';

async function insertClimb(
  db: TestSqliteDb,
  opts: { uuid: string; boardType?: string; layoutId?: number; compatibleSizeIds?: number[] | null },
): Promise<void> {
  const sizes = opts.compatibleSizeIds === null ? null : JSON.stringify(opts.compatibleSizeIds ?? [5]);
  await db.runAsync(
    `INSERT INTO board_climbs (uuid, board_type, layout_id, is_listed, is_draft, compatible_size_ids, updated_at)
     VALUES (?, ?, ?, 1, 0, ?, ?)`,
    [opts.uuid, opts.boardType ?? 'kilter', opts.layoutId ?? 1, sizes, '2026-01-01T00:00:00Z'],
  );
}

describe('isBoardDownloadedLocally', () => {
  let db: TestSqliteDb;

  beforeEach(async () => {
    mockStorage.clear();
    resetAllSettings();
    db = createTestDatabase();
    await runMigrations(db);
  });

  it('is false when the scope key is not in syncEnabledBoards', async () => {
    await insertClimb(db, { uuid: 'a', compatibleSizeIds: [5] });
    expect(await isBoardDownloadedLocally(db, { boardType: 'kilter', layoutId: 1, sizeId: 5 })).toBe(false);
  });

  it('is true when enabled, the initial download completed, and rows exist for the exact (type, layout, size)', async () => {
    await insertClimb(db, { uuid: 'a', compatibleSizeIds: [5, 6] });
    setSetting('syncEnabledBoards', ['kilter:1:5']);
    await markScopeDownloadComplete(db, 'kilter:1:5');
    expect(await isBoardDownloadedLocally(db, { boardType: 'kilter', layoutId: 1, sizeId: 5 })).toBe(true);
  });

  it('is FALSE while the initial download is still in flight (rows landed, no completeness marker)', async () => {
    // A first-page checkpoint plus a sliver of rows must not serve local-first
    // reads: a 40k-climb board pulls for minutes and a partial catalog would
    // silently truncate search results while fully online.
    await insertClimb(db, { uuid: 'a', compatibleSizeIds: [5, 6] });
    setSetting('syncEnabledBoards', ['kilter:1:5']);
    expect(await isBoardDownloadedLocally(db, { boardType: 'kilter', layoutId: 1, sizeId: 5 })).toBe(false);
  });

  it('is FALSE for a different size of the same layout (the exact-scope gate)', async () => {
    // Downloaded at size 5; the user then enables size 15 of the same layout. The
    // size-5 rows must NOT satisfy the size-15 scope — offline search for 15 would
    // otherwise run against data it was never scoped for. Even a (stale)
    // completeness marker for the 15-scope can't override the row probe.
    await insertClimb(db, { uuid: 'a', compatibleSizeIds: [5, 6] });
    setSetting('syncEnabledBoards', ['kilter:1:15']);
    await markScopeDownloadComplete(db, 'kilter:1:15');
    expect(await isBoardDownloadedLocally(db, { boardType: 'kilter', layoutId: 1, sizeId: 15 })).toBe(false);
  });

  it('is false when enabled but no rows for the layout have landed', async () => {
    setSetting('syncEnabledBoards', ['kilter:1:5']);
    expect(await isBoardDownloadedLocally(db, { boardType: 'kilter', layoutId: 1, sizeId: 5 })).toBe(false);
  });

  it('ignores size for moonboard (single fixed size)', async () => {
    await insertClimb(db, { uuid: 'm', boardType: 'moonboard', layoutId: 1, compatibleSizeIds: null });
    setSetting('syncEnabledBoards', ['moonboard:1:99']);
    await markScopeDownloadComplete(db, 'moonboard:1:99');
    expect(await isBoardDownloadedLocally(db, { boardType: 'moonboard', layoutId: 1, sizeId: 99 })).toBe(true);
  });
});

describe('hasDownloadedBoardData', () => {
  let db: TestSqliteDb;

  beforeEach(async () => {
    mockStorage.clear();
    resetAllSettings();
    db = createTestDatabase();
    await runMigrations(db);
  });

  it('is false on an empty catalog', async () => {
    expect(await hasDownloadedBoardData(db)).toBe(false);
  });

  it('is true whenever board_climbs holds any row', async () => {
    await insertClimb(db, { uuid: 'a' });
    expect(await hasDownloadedBoardData(db)).toBe(true);
  });

  // Why the sign-out warning probes rows instead of syncEnabledBoards: a feature-flag
  // rollback clears the toggle list while the catalog rows survive on disk. Those
  // rows still get wiped, so the warning still has to fire.
  it('is true even when syncEnabledBoards is empty (a flag rollback left the rows)', async () => {
    await insertClimb(db, { uuid: 'a' });
    setSetting('syncEnabledBoards', []);
    expect(await hasDownloadedBoardData(db)).toBe(true);
  });

  // A download killed part-way never wrote a scope-complete marker, but it still has
  // rows to lose.
  it('is true for a partial download with no scope-complete marker', async () => {
    await insertClimb(db, { uuid: 'a' });
    expect(await hasDownloadedBoardData(db)).toBe(true);
  });
});

describe('isClimbLayoutDownloadedLocally', () => {
  let db: TestSqliteDb;

  beforeEach(async () => {
    mockStorage.clear();
    resetAllSettings();
    db = createTestDatabase();
    await runMigrations(db);
  });

  it("is true when a size of the climb's own layout that the climb fits finished downloading", async () => {
    await insertClimb(db, { uuid: 'a', layoutId: 1, compatibleSizeIds: [5, 7] });
    setSetting('syncEnabledBoards', ['kilter:1:7']);
    await markScopeDownloadComplete(db, 'kilter:1:7');
    expect(await isClimbLayoutDownloadedLocally(db, 'kilter', 'a')).toBe(true);
  });

  it('is false when the only completed size of the layout is one the climb does not fit', async () => {
    // The stats pull is scoped by compatible_size_ids, so a finished kilter:1:7
    // never pulled this climb's stats, even though the row is here (kilter:1:5
    // is still downloading).
    await insertClimb(db, { uuid: 'a', layoutId: 1, compatibleSizeIds: [5] });
    setSetting('syncEnabledBoards', ['kilter:1:5', 'kilter:1:7']);
    await markScopeDownloadComplete(db, 'kilter:1:7');
    expect(await isClimbLayoutDownloadedLocally(db, 'kilter', 'a')).toBe(false);
  });

  it('ignores size for a board that is not size-scoped', async () => {
    await insertClimb(db, { uuid: 'm', boardType: 'moonboard', layoutId: 2, compatibleSizeIds: null });
    setSetting('syncEnabledBoards', ['moonboard:2:1']);
    await markScopeDownloadComplete(db, 'moonboard:2:1');
    expect(await isClimbLayoutDownloadedLocally(db, 'moonboard', 'm')).toBe(true);
  });

  it('is false when only a different layout of the board type is downloaded', async () => {
    await insertClimb(db, { uuid: 'a', layoutId: 1 });
    setSetting('syncEnabledBoards', ['kilter:8:5']);
    await markScopeDownloadComplete(db, 'kilter:8:5');
    expect(await isClimbLayoutDownloadedLocally(db, 'kilter', 'a')).toBe(false);
  });

  it('is false while the layout download is still in flight', async () => {
    await insertClimb(db, { uuid: 'a', layoutId: 1 });
    setSetting('syncEnabledBoards', ['kilter:1:5']);
    expect(await isClimbLayoutDownloadedLocally(db, 'kilter', 'a')).toBe(false);
  });

  it('is false for a climb that is not on the device, or on another board type', async () => {
    await insertClimb(db, { uuid: 'a', layoutId: 1 });
    setSetting('syncEnabledBoards', ['kilter:1:5']);
    await markScopeDownloadComplete(db, 'kilter:1:5');
    expect(await isClimbLayoutDownloadedLocally(db, 'kilter', 'missing')).toBe(false);
    expect(await isClimbLayoutDownloadedLocally(db, 'tension', 'a')).toBe(false);
  });
});

// Issue #6306. A privacy event deletes other climbers' protected rows and
// resets the protected sync cursors; the `scope-complete:` marker stays, and the
// next pull brings back what the viewer may still see. What may be read from
// the device in between depends on what the board is made of.
describe('a downloaded board whose protected rows are being replayed after a privacy event', () => {
  let db: TestSqliteDb;
  const KILTER = { boardType: 'kilter', layoutId: 1, sizeId: 5 };
  const WALL = { boardType: 'spray', layoutId: 7, sizeId: 7 };

  beforeEach(async () => {
    mockStorage.clear();
    resetAllSettings();
    db = createTestDatabase();
    await runMigrations(db);
    await insertClimb(db, { uuid: 'kilter-climb', compatibleSizeIds: [5] });
    await insertClimb(db, { uuid: 'wall-climb', boardType: 'spray', layoutId: 7, compatibleSizeIds: [7] });
    setSetting('syncEnabledBoards', ['kilter:1:5', 'spray:7:7']);
    await markScopeDownloaded(db, 'kilter:1:5');
    await markScopeDownloaded(db, 'spray:7:7');
  });

  it('reads both boards from the device once every stream is at its tail', async () => {
    expect(await isBoardDownloadedLocally(db, KILTER)).toBe(true);
    expect(await isBoardDownloadedLocally(db, WALL)).toBe(true);
    expect(await isBoardTypeProtectedSettled(db, 'kilter')).toBe(true);
    expect(await isBoardTypeProtectedSettled(db, 'spray')).toBe(true);
  });

  describe('between the event and the end of the replay', () => {
    beforeEach(async () => {
      // What the revalidation does to the sync state.
      await resetProtectedSyncState(db);
    });

    it('keeps serving a catalogue board: it still holds its reference catalogue and the climber’s own climbs', async () => {
      expect(await isBoardDownloadedLocally(db, KILTER)).toBe(true);
      expect(await isBoardTypeDownloadedLocally(db, 'kilter')).toBe(true);
      expect(await isClimbLayoutDownloadedLocally(db, 'kilter', 'kilter-climb')).toBe(true);
    });

    it('does not serve a spray wall: without its protected rows there is no wall', async () => {
      expect(await isBoardDownloadedLocally(db, WALL)).toBe(false);
      expect(await isBoardTypeDownloadedLocally(db, 'spray')).toBe(false);
      expect(await isClimbLayoutDownloadedLocally(db, 'spray', 'wall-climb')).toBe(false);
    });

    it('says neither board type is settled, which is what sends an online read to the server', async () => {
      expect(await isBoardTypeProtectedSettled(db, 'kilter')).toBe(false);
      expect(await isBoardTypeProtectedSettled(db, 'spray')).toBe(false);
    });

    it('serves the wall again, and settles, when its replay finishes', async () => {
      await markScopeProtectedComplete(db, 'spray:7:7');

      expect(await isBoardDownloadedLocally(db, WALL)).toBe(true);
      expect(await isBoardTypeProtectedSettled(db, 'spray')).toBe(true);
      // One board's replay says nothing about another's.
      expect(await isBoardTypeProtectedSettled(db, 'kilter')).toBe(false);
    });
  });

  describe('isBoardTypeProtectedSettled', () => {
    it('is settled for a board type with nothing downloaded: there is nothing to wait for', async () => {
      expect(await isBoardTypeProtectedSettled(db, 'tension')).toBe(true);
    });

    it('ignores a scope that is still downloading, which is not read from the device anyway', async () => {
      setSetting('syncEnabledBoards', ['kilter:1:5', 'kilter:8:5']);
      expect(await isBoardTypeProtectedSettled(db, 'kilter')).toBe(true);
    });

    it('ignores a board that is on the device but switched off', async () => {
      await resetProtectedSyncState(db);
      setSetting('syncEnabledBoards', ['spray:7:7']);
      expect(await isBoardTypeProtectedSettled(db, 'kilter')).toBe(true);
    });

    it('waits for every downloaded scope of the type, not just one', async () => {
      await insertClimb(db, { uuid: 'kilter-other-layout', layoutId: 8, compatibleSizeIds: [5] });
      setSetting('syncEnabledBoards', ['kilter:1:5', 'kilter:8:5']);
      await markScopeDownloadComplete(db, 'kilter:8:5');
      expect(await isBoardTypeProtectedSettled(db, 'kilter')).toBe(false);
      await markScopeProtectedComplete(db, 'kilter:8:5');
      expect(await isBoardTypeProtectedSettled(db, 'kilter')).toBe(true);
    });
  });
});
