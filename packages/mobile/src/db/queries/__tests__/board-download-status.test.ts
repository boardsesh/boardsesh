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

import { runMigrations } from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import { isBoardDownloadedLocally, hasDownloadedBoardData } from '../board-download-status';
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
