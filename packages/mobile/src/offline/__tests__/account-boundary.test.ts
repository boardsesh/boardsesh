// The owner-stamp recovery (#6563) against the REAL client DDL, the real settings
// store (over an in-memory MMKV) and the real sync-status store.
//
// Account A's session expired while the app was closed, so no sign-out ran for
// it. Account B signs in on the same phone, and `OfflineSyncBridge` finds the
// database stamped for A. That recovery is the only place A's offline selection,
// board names and sync status can be reset, and it must not cost the downloads:
// the catalogue rows and their checkpoints stay, so B enabling the same board
// resumes it (#6545).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockStorage = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => ({
  createMMKV: () => ({
    getString: (key: string) => mockStorage.get(key),
    set: (key: string, value: string) => {
      mockStorage.set(key, value);
    },
    remove: (key: string) => {
      mockStorage.delete(key);
    },
    clearAll: () => {
      mockStorage.clear();
    },
  }),
}));

// The adapter wires AppState and NetInfo at import time; only the two reporters
// the funnel module takes from it are stubbed. Neither may fire here: A's events
// must not land on B's analytics.
const reportScopeDownloadAbandonedOnSignOut = vi.hoisted(() => vi.fn());
const reportScopeDownloadAbandonedOnDisable = vi.hoisted(() => vi.fn());
vi.mock('../offline-sync-adapter', () => ({
  reportScopeDownloadAbandonedOnSignOut,
  reportScopeDownloadAbandonedOnDisable,
}));

// The photographs are files, not rows (#5448).
const clearStoredSprayPhotos = vi.hoisted(() => vi.fn());
vi.mock('../../lib/spray/spray-photo-store', () => ({ clearStoredSprayPhotos }));

// What db/connection reaches besides SQLite.
const trackMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/analytics', () => ({ track: trackMock }));
vi.mock('../../lib/error-reporting', () => ({ reportError: vi.fn() }));
vi.mock('../../lib/profiling/startup-profile', () => ({ markStartup: vi.fn() }));

import type { SQLiteDatabase } from 'expo-sqlite';
import type { UserBoard } from '@boardsesh/shared-schema';
import {
  BOARD_DATA_TABLES,
  assertLocalUserDataOwner,
  getCheckpoint,
  getCheckpointKey,
  getLocalUserId,
  isScopeDownloadComplete,
  isScopeDownloadStarted,
  markScopeDownloadComplete,
  runMigrations,
  setCheckpoint,
  stampLocalUserId,
} from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import {
  getOfflineBoards,
  getOwnedSprayWallPins,
  getSetting,
  rememberOfflineBoards,
  resetAllSettings,
  setOwnedSprayWallPins,
  setSetting,
} from '../../settings';
import { getSyncStatusSnapshot, resetSyncStatus, setSyncProgress } from '../../sync/sync-status';
import { isBoardDownloadedLocally } from '../../db/queries/board-download-status';
import { sweepDelistedDownloadTerminals } from '../abandoned-download-terminals';
import { wipePreviousAccountLocalData } from '../account-boundary';
import { planOwnedSprayWallPins } from '../owned-spray-wall-pins';

const ACCOUNT_A = 'account-a';
const ACCOUNT_B = 'account-b';
// A finished downloading this board...
const DOWNLOADED = 'kilter:1:1';
// ...and was halfway through this one.
const DOWNLOADING = 'tension:11:8';
const NOW = '2026-10-01T00:00:00Z';

let workDir: string;
let db: TestSqliteDb & SQLiteDatabase;

const board = (overrides: Partial<UserBoard> & { uuid: string; name: string }): UserBoard =>
  ({
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 1,
    setIds: '20,21',
    angle: 40,
    ...overrides,
  }) as unknown as UserBoard;

/** `markScopeDownloadStarted` is package-internal; only the pull client writes it. */
const announceDownload = (scopeKey: string) =>
  db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [`scope-started:${scopeKey}`, '1']);

async function countRows(table: string): Promise<number> {
  const row = await db.getFirstAsync<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`);
  return row?.count ?? 0;
}

/** A's phone, as A left it: a tick, one finished download, one half done. */
async function seedAccountA(): Promise<void> {
  await stampLocalUserId(db, ACCOUNT_A);
  await db.runAsync(
    `INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status) VALUES (?, ?, 'kilter', 'climb-1', 40, 'send')`,
    ['tick-by-a', ACCOUNT_A],
  );

  await db.runAsync(`INSERT INTO board_climbs (uuid, board_type, layout_id, compatible_size_ids) VALUES (?, ?, ?, ?)`, [
    'climb-1',
    'kilter',
    1,
    '[1]',
  ]);
  for (const tableName of BOARD_DATA_TABLES) {
    await setCheckpoint(db, getCheckpointKey(tableName, DOWNLOADED), { updatedAt: NOW, syncSeq: '9' });
  }
  await announceDownload(DOWNLOADED);
  await markScopeDownloadComplete(db, DOWNLOADED);

  await announceDownload(DOWNLOADING);
  await setCheckpoint(db, getCheckpointKey(BOARD_DATA_TABLES[0], DOWNLOADING), { updatedAt: NOW, syncSeq: '3' });

  setSetting('syncEnabledBoards', [DOWNLOADED, DOWNLOADING]);
  rememberOfflineBoards([board({ uuid: 'board-a', name: "A's garage" })]);
  setSyncProgress({ phase: 'idle', currentTable: null, documentsProcessed: 10 });
}

/** The sequence `OfflineSyncBridge` runs once B's id is known. */
async function ownerStampHandover(userId: string): Promise<string> {
  const ownership = await assertLocalUserDataOwner(db, userId);
  if (ownership === 'mismatch') await wipePreviousAccountLocalData(db);
  if (ownership !== 'ok') await stampLocalUserId(db, userId);
  return ownership;
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'account-boundary-'));
  db = createTestDatabase(join(workDir, 'client.db')) as unknown as TestSqliteDb & SQLiteDatabase;
  await runMigrations(db);
  mockStorage.clear();
  resetAllSettings();
  resetSyncStatus();
  vi.clearAllMocks();
  await seedAccountA();
});

afterEach(() => {
  db.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe('the owner-stamp recovery when another account signs in', () => {
  it("resets A's downloaded boards, board names and sync status", async () => {
    // What B would otherwise inherit.
    expect(getSetting('syncEnabledBoards')).toEqual([DOWNLOADED, DOWNLOADING]);
    expect(getOfflineBoards().map((card) => card.name)).toEqual(["A's garage"]);
    expect(getSyncStatusSnapshot().lastSyncedAt).not.toBeNull();

    expect(await ownerStampHandover(ACCOUNT_B)).toBe('mismatch');

    expect(getSetting('syncEnabledBoards')).toEqual([]);
    expect(getOfflineBoards()).toEqual([]);
    expect(getSyncStatusSnapshot().lastSyncedAt).toBeNull();
    // ...along with what the recovery already wiped: A's rows and photographs.
    expect(await countRows('boardsesh_ticks')).toBe(0);
    expect(clearStoredSprayPhotos).toHaveBeenCalledTimes(1);
    expect(await getLocalUserId(db)).toBe(ACCOUNT_B);
  });

  it('keeps the downloaded catalogue and every board checkpoint', async () => {
    await ownerStampHandover(ACCOUNT_B);

    expect(await countRows('board_climbs')).toBe(1);
    expect(await isScopeDownloadComplete(db, DOWNLOADED)).toBe(true);
    for (const tableName of BOARD_DATA_TABLES) {
      expect(await getCheckpoint(db, getCheckpointKey(tableName, DOWNLOADED))).toEqual({
        updatedAt: NOW,
        syncSeq: '9',
      });
    }
    // The half-done download keeps its place too.
    expect(await getCheckpoint(db, getCheckpointKey(BOARD_DATA_TABLES[0], DOWNLOADING))).toEqual({
      updatedAt: NOW,
      syncSeq: '3',
    });
  });

  it("serves A's downloaded board to B as soon as B enables it, without a re-download", async () => {
    await ownerStampHandover(ACCOUNT_B);
    const scope = { boardType: 'kilter', layoutId: 1, sizeId: 1 };
    // Not B's until B asks for it...
    expect(await isBoardDownloadedLocally(db, scope)).toBe(false);

    setSetting('syncEnabledBoards', [DOWNLOADED]);

    // ...and then straight from the rows already on the phone.
    expect(await isBoardDownloadedLocally(db, scope)).toBe(true);
  });

  it("closes A's unfinished download without an event, so none lands on B", async () => {
    await ownerStampHandover(ACCOUNT_B);

    expect(await isScopeDownloadStarted(db, DOWNLOADING)).toBe(false);
    // A finished funnel is not touched: `scope-complete:` already closed it.
    expect(await isScopeDownloadStarted(db, DOWNLOADED)).toBe(true);
    // B's launch sweep finds the list empty and nothing left to report.
    await sweepDelistedDownloadTerminals(db);
    expect(reportScopeDownloadAbandonedOnSignOut).not.toHaveBeenCalled();
    expect(reportScopeDownloadAbandonedOnDisable).not.toHaveBeenCalled();
    expect(trackMock).not.toHaveBeenCalled();
  });

  // `OwnedSprayWallsOfflinePin` does not wait for the owner check. On a contended
  // launch it can pin B's own wall and record it before the wipe runs; the reset
  // then empties the list, and a recorded wall is never pinned again.
  it("lets the pin turn B's own walls back on after the reset", async () => {
    const wallB = board({ uuid: 'wall-b', name: "B's garage", boardType: 'spray', layoutId: 77, sizeId: 77 });
    const ownedWall = { ...wallB, ownerId: ACCOUNT_B } as UserBoard;
    setSetting('syncEnabledBoards', [DOWNLOADED, DOWNLOADING, 'spray:77:77']);
    setOwnedSprayWallPins({ userId: ACCOUNT_B, wallUuids: ['wall-b'] });

    await ownerStampHandover(ACCOUNT_B);

    expect(getSetting('syncEnabledBoards')).toEqual([]);
    expect(getOwnedSprayWallPins()).toBeNull();
    // What the pin plans on its next run: B's wall goes back on.
    const plan = planOwnedSprayWallPins({
      boards: [ownedWall],
      viewerUserId: ACCOUNT_B,
      ledger: getOwnedSprayWallPins(),
      enabledScopeKeys: new Set(getSetting('syncEnabledBoards')),
    });
    expect(plan.pin.map((wall) => wall.uuid)).toEqual(['wall-b']);
  });

  it('leaves everything alone when A signs back in', async () => {
    // A re-signing in after the expiry keeps their own selection.
    expect(await ownerStampHandover(ACCOUNT_A)).toBe('ok');

    expect(getSetting('syncEnabledBoards')).toEqual([DOWNLOADED, DOWNLOADING]);
    expect(getOfflineBoards().map((card) => card.name)).toEqual(["A's garage"]);
    expect(getSyncStatusSnapshot().lastSyncedAt).not.toBeNull();
    expect(await countRows('boardsesh_ticks')).toBe(1);
    expect(await isScopeDownloadStarted(db, DOWNLOADING)).toBe(true);
  });
});
