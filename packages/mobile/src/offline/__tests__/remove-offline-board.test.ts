// The ORDER is what this file exists to pin. The engine's own tests cover the SQL;
// what can go wrong here is sequencing — and the failure mode is a board silently
// re-downloading its whole catalog over cellular right after the user removed it.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockStorage = new Map<string, string>();

vi.mock('react-native-mmkv', () => {
  const createMockInstance = () => ({
    getString(key: string) {
      return mockStorage.get(key);
    },
    set(key: string, value: string) {
      mockStorage.set(key, value);
    },
    remove(key: string) {
      mockStorage.delete(key);
    },
    clearAll() {
      mockStorage.clear();
    },
  });
  return { createMMKV: vi.fn(() => createMockInstance()) };
});

const removeBoardScopeData = vi.fn(async () => ({
  climbsDeleted: 1,
  statsDeleted: 1,
  gradesDeleted: 0,
  removedAnyRows: true,
}));
const releasePurge = vi.fn();
const beginScopePurge = vi.fn((_namespace: string) => releasePurge);
const beginGlobalPurge = vi.fn();
const isSyncInFlight = vi.fn(() => false);
const vacuumDatabase = vi.fn(async () => true);

vi.mock('@boardsesh/offline-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/offline-sync')>();
  return {
    ...actual,
    removeBoardScopeData: (...args: unknown[]) => removeBoardScopeData(...(args as [])),
    beginScopePurge: (namespace: string) => beginScopePurge(namespace),
    beginGlobalPurge: () => beginGlobalPurge(),
    isSyncInFlight: () => isSyncInFlight(),
    vacuumDatabase: () => vacuumDatabase(),
  };
});

vi.mock('../../lib/error-reporting', () => ({
  reportHandledError: vi.fn(),
  reportError: vi.fn(),
}));

const sweepOverlaysForScope = vi.fn(async () => ({ beforeBytes: 0, freedBytes: 0, filesDeleted: 0 }));
vi.mock('../../lib/sweep-caches', () => ({
  sweepOverlaysForScope: (...args: unknown[]) => sweepOverlaysForScope(...(args as [])),
}));

import type { QueryClient } from '@tanstack/react-query';
import { removeOfflineBoard, compactOfflineDatabase } from '../remove-offline-board';
import { getSetting, setSetting, resetAllSettings } from '../../settings/hooks';
import { getOfflineBoards, rememberOfflineBoards } from '../../settings/offline-boards';
import type { OfflineBoardScope, OfflineDatabase } from '@boardsesh/offline-sync';
import type { UserBoard } from '@boardsesh/shared-schema';

const KILTER_12X14: OfflineBoardScope = { boardType: 'kilter', layoutId: 1, sizeId: 7 };
const KILTER_8X12: OfflineBoardScope = { boardType: 'kilter', layoutId: 1, sizeId: 8 };

// The engine is mocked out, so neither handle is ever really touched.
const db = {} as unknown as OfflineDatabase;
const invalidateQueries = vi.fn();
const queryClient = { invalidateQueries } as unknown as QueryClient;

beforeEach(() => {
  vi.clearAllMocks();
  mockStorage.clear();
  resetAllSettings();
  // clearAllMocks drops the factory implementations above, so restore the two
  // whose RETURN value the code under test depends on.
  beginScopePurge.mockImplementation(() => releasePurge);
  isSyncInFlight.mockImplementation(() => false);
  vacuumDatabase.mockImplementation(async () => true);
});

describe('removeOfflineBoard', () => {
  // The ordering hazard. The pull client reads syncEnabledBoards at the top of every
  // cycle, and a cycle fires on any foreground or connectivity change. If the scope
  // were still listed when the delete ran, the next cycle would see a scope with no
  // checkpoint and no marker — a brand-new board — and re-download the whole catalog.
  it('drops the setting BEFORE deleting any rows', async () => {
    setSetting('syncEnabledBoards', ['kilter:1:7']);
    let enabledWhenDeleteRan: string[] | null = null;
    removeBoardScopeData.mockImplementationOnce(async () => {
      enabledWhenDeleteRan = getSetting('syncEnabledBoards');
      return { climbsDeleted: 1, statsDeleted: 0, gradesDeleted: 0, removedAnyRows: true };
    });

    await removeOfflineBoard({ db, queryClient, scope: KILTER_12X14 });

    expect(enabledWhenDeleteRan).toEqual([]);
    expect(getSetting('syncEnabledBoards')).toEqual([]);
  });

  // Without this an in-flight pull's page lands after the delete and resurrects rows,
  // stamping a checkpoint past them that the strict `>` delta never revisits. The
  // namespace is the LAYOUT, not the scope key: that is exactly the DELETE predicate
  // and exactly the artifact cache key (issue #4370).
  it("aborts this layout's in-flight pull before deleting, and only this layout's", async () => {
    setSetting('syncEnabledBoards', ['kilter:1:7']);
    const callOrder: string[] = [];
    beginScopePurge.mockImplementationOnce((namespace: string) => {
      callOrder.push(`purge:${namespace}`);
      return releasePurge;
    });
    removeBoardScopeData.mockImplementationOnce(async () => {
      callOrder.push('delete');
      return { climbsDeleted: 1, statsDeleted: 0, gradesDeleted: 0, removedAnyRows: true };
    });

    await removeOfflineBoard({ db, queryClient, scope: KILTER_12X14 });

    expect(callOrder).toEqual(['purge:kilter:1', 'delete']);
  });

  // The latch covers the seconds the delete transaction holds; leaving it set would
  // block this layout's downloads for the rest of the app session.
  it('releases the purge latch after the delete resolves', async () => {
    setSetting('syncEnabledBoards', ['kilter:1:7']);
    const callOrder: string[] = [];
    releasePurge.mockImplementation(() => callOrder.push('release'));
    removeBoardScopeData.mockImplementationOnce(async () => {
      callOrder.push('delete');
      return { climbsDeleted: 1, statsDeleted: 0, gradesDeleted: 0, removedAnyRows: true };
    });

    await removeOfflineBoard({ db, queryClient, scope: KILTER_12X14 });

    expect(callOrder).toEqual(['delete', 'release']);
  });

  it('releases the purge latch when the delete throws, and still propagates', async () => {
    setSetting('syncEnabledBoards', ['kilter:1:7']);
    removeBoardScopeData.mockRejectedValueOnce(new Error('disk went away'));

    await expect(removeOfflineBoard({ db, queryClient, scope: KILTER_12X14 })).rejects.toThrow('disk went away');
    expect(releasePurge).toHaveBeenCalledTimes(1);
  });

  it('retains every other enabled scope, and never the one being removed', async () => {
    setSetting('syncEnabledBoards', ['kilter:1:7', 'kilter:1:8']);

    await removeOfflineBoard({ db, queryClient, scope: KILTER_12X14 });

    expect(removeBoardScopeData).toHaveBeenCalledWith(
      expect.objectContaining({ scopeKey: 'kilter:1:7', retainedScopes: [KILTER_8X12] }),
    );
  });

  // The benign kill-state: setting gone, rows possibly still there. Nothing reads
  // them (isBoardDownloadedLocally checks the setting first) and the teardown is
  // idempotent, so the next attempt reaps them. The reverse would be the bad one.
  it('leaves the setting off when the delete throws', async () => {
    setSetting('syncEnabledBoards', ['kilter:1:7']);
    removeBoardScopeData.mockRejectedValueOnce(new Error('disk went away'));

    await expect(removeOfflineBoard({ db, queryClient, scope: KILTER_12X14 })).rejects.toThrow('disk went away');
    expect(getSetting('syncEnabledBoards')).toEqual([]);
  });

  // The offline picker replays snapshots taken at download time. Once the rows are
  // gone, a surviving card offers a board with no climbs behind it.
  it('forgets the offline picker snapshots for the scope it just deleted', async () => {
    const card = (uuid: string, sizeId: number): UserBoard =>
      ({ uuid, name: uuid, boardType: 'kilter', layoutId: 1, sizeId, setIds: '20', angle: 40 }) as unknown as UserBoard;
    setSetting('syncEnabledBoards', ['kilter:1:7', 'kilter:1:8']);
    rememberOfflineBoards([card('removed', 7), card('kept', 8)]);

    await removeOfflineBoard({ db, queryClient, scope: KILTER_12X14 });

    expect(getOfflineBoards().map((entry) => entry.uuid)).toEqual(['kept']);
  });

  it('invalidates the readers that could still hold deleted rows', async () => {
    setSetting('syncEnabledBoards', ['kilter:1:7']);

    await removeOfflineBoard({ db, queryClient, scope: KILTER_12X14 });

    const invalidatedKeys = invalidateQueries.mock.calls.map((call) =>
      JSON.stringify((call[0] as { queryKey: unknown[] }).queryKey),
    );
    // The local-first search readers, plus the two "is it downloaded / how big" keys.
    expect(invalidatedKeys).toContain(JSON.stringify(['searchClimbs']));
    expect(invalidatedKeys).toContain(JSON.stringify(['climb']));
    expect(invalidatedKeys).toContain(JSON.stringify(['downloadedScopeKeys']));
    expect(invalidatedKeys).toContain(JSON.stringify(['offlineStorage']));
  });
});

describe('removeOfflineBoard cached art', () => {
  it("sweeps the removed scope's rendered art", async () => {
    setSetting('syncEnabledBoards', ['kilter:1:7']);
    await removeOfflineBoard({ db, queryClient, scope: KILTER_12X14 });
    expect(sweepOverlaysForScope).toHaveBeenCalledWith(KILTER_12X14);
  });

  // Cache housekeeping must never be able to turn a successful teardown into a
  // failure the user reads as "the removal didn't work" — same posture as
  // compactOfflineDatabase.
  it('still reports the teardown result when the art sweep throws', async () => {
    sweepOverlaysForScope.mockRejectedValueOnce(new Error('cache dir vanished'));
    setSetting('syncEnabledBoards', ['kilter:1:7']);
    await expect(removeOfflineBoard({ db, queryClient, scope: KILTER_12X14 })).resolves.toMatchObject({
      removedAnyRows: true,
    });
  });
});

describe('compactOfflineDatabase', () => {
  // The teardown already committed, so a failed VACUUM means "the data is gone but
  // the file didn't shrink" — reportable, never an error that implies data loss.
  it("reports 'not-truncated' instead of throwing when the vacuum fails", async () => {
    vacuumDatabase.mockRejectedValueOnce(new Error('SQLITE_FULL'));

    await expect(compactOfflineDatabase(db, { deferWhileSyncing: false })).resolves.toBe('not-truncated');
  });

  // The rebuild landed but a reader blocked the WAL truncation, so the -wal stayed
  // large and the user's number won't have moved. Silent otherwise — pragma, not throw.
  it("reports 'not-truncated' when the WAL truncation was blocked", async () => {
    vacuumDatabase.mockResolvedValueOnce(false);

    await expect(compactOfflineDatabase(db, { deferWhileSyncing: false })).resolves.toBe('not-truncated');
  });

  it("reports 'truncated' on success", async () => {
    await expect(compactOfflineDatabase(db, { deferWhileSyncing: false })).resolves.toBe('truncated');
  });

  // VACUUM's exclusive lock would fail a concurrent snapshot import with
  // SQLITE_BUSY, which the retry ladder charges as a structural failure — two of
  // those strand a board on the paged crawl (issue #4370). The post-removal
  // compaction defers instead; the manual Compact button does not.
  it("returns 'deferred' without touching the database while a pull is in flight", async () => {
    isSyncInFlight.mockReturnValue(true);

    await expect(compactOfflineDatabase(db, { deferWhileSyncing: true })).resolves.toBe('deferred');
    expect(vacuumDatabase).not.toHaveBeenCalled();
    expect(beginGlobalPurge).not.toHaveBeenCalled();
  });

  it('compacts anyway when nothing is syncing', async () => {
    isSyncInFlight.mockReturnValue(false);

    await expect(compactOfflineDatabase(db, { deferWhileSyncing: true })).resolves.toBe('truncated');
    expect(vacuumDatabase).toHaveBeenCalledTimes(1);
  });

  // db/vacuum.ts has always required this: the rebuild holds an exclusive lock for
  // 5-20s, so in-flight cycles must bail BEFORE it starts, not meet it.
  it('bumps the global epoch before vacuuming when it does not defer', async () => {
    isSyncInFlight.mockReturnValue(true);
    const callOrder: string[] = [];
    beginGlobalPurge.mockImplementationOnce(() => callOrder.push('global-purge'));
    vacuumDatabase.mockImplementationOnce(async () => {
      callOrder.push('vacuum');
      return true;
    });

    await expect(compactOfflineDatabase(db, { deferWhileSyncing: false })).resolves.toBe('truncated');
    expect(callOrder).toEqual(['global-purge', 'vacuum']);
  });
});
