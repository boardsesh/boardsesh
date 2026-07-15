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
const beginLocalPurge = vi.fn();
const vacuumDatabase = vi.fn(async () => true);

vi.mock('@boardsesh/offline-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/offline-sync')>();
  return {
    ...actual,
    removeBoardScopeData: (...args: unknown[]) => removeBoardScopeData(...(args as [])),
    beginLocalPurge: () => beginLocalPurge(),
    vacuumDatabase: () => vacuumDatabase(),
  };
});

vi.mock('../../lib/error-reporting', () => ({
  reportHandledError: vi.fn(),
  reportError: vi.fn(),
}));

import type { QueryClient } from '@tanstack/react-query';
import { removeOfflineBoard, compactOfflineDatabase } from '../remove-offline-board';
import { getSetting, setSetting, resetAllSettings } from '../../settings/hooks';
import type { OfflineBoardScope, OfflineDatabase } from '@boardsesh/offline-sync';

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
  // stamping a checkpoint past them that the strict `>` delta never revisits.
  it('aborts in-flight pulls before deleting', async () => {
    setSetting('syncEnabledBoards', ['kilter:1:7']);
    const callOrder: string[] = [];
    beginLocalPurge.mockImplementationOnce(() => callOrder.push('purge'));
    removeBoardScopeData.mockImplementationOnce(async () => {
      callOrder.push('delete');
      return { climbsDeleted: 1, statsDeleted: 0, gradesDeleted: 0, removedAnyRows: true };
    });

    await removeOfflineBoard({ db, queryClient, scope: KILTER_12X14 });

    expect(callOrder).toEqual(['purge', 'delete']);
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

describe('compactOfflineDatabase', () => {
  // The teardown already committed, so a failed VACUUM means "the data is gone but
  // the file didn't shrink" — reportable, never an error that implies data loss.
  it('reports false instead of throwing when the vacuum fails', async () => {
    vacuumDatabase.mockRejectedValueOnce(new Error('SQLITE_FULL'));

    await expect(compactOfflineDatabase(db)).resolves.toBe(false);
  });

  // The rebuild landed but a reader blocked the WAL truncation, so the -wal stayed
  // large and the user's number won't have moved. Silent otherwise — pragma, not throw.
  it('reports false when the WAL truncation was blocked', async () => {
    vacuumDatabase.mockResolvedValueOnce(false);

    await expect(compactOfflineDatabase(db)).resolves.toBe(false);
  });

  it('reports true on success', async () => {
    await expect(compactOfflineDatabase(db)).resolves.toBe(true);
  });
});
