// The download funnel's terminal on the paths that de-list a board rather than
// deleting it (issue #4452), against the REAL client DDL.
//
// The engine's own suite pins the primitives and the sign-out wipe's shape; this
// pins the mobile side of the contract: WHICH scope gets a terminal, that the
// markers are cleared so the funnel closes exactly once, and that a re-enable
// opens a fresh one instead of resuming a funnel the climber ended.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The adapter wires AppState and NetInfo at import time, so only the two
// reporters this module takes from it are stubbed (same trick as #4406's
// remove-offline-board test).
const reportScopeDownloadAbandonedOnSignOut = vi.hoisted(() => vi.fn());
const reportScopeDownloadAbandonedOnDisable = vi.hoisted(() => vi.fn());
vi.mock('../offline-sync-adapter', () => ({
  reportScopeDownloadAbandonedOnSignOut,
  reportScopeDownloadAbandonedOnDisable,
}));

const enabledScopeKeys = vi.hoisted(() => ({ current: [] as string[] }));
vi.mock('../../settings', () => ({ getSetting: () => enabledScopeKeys.current }));

import type { SQLiteDatabase } from 'expo-sqlite';
import { runMigrations, markScopeDownloadComplete, isScopeDownloadStarted } from '@boardsesh/offline-sync';
import {
  createTestDatabase,
  __resetDownloadTerminalRegistryForTests,
  type TestSqliteDb,
} from '@boardsesh/offline-sync/testing';
import {
  reportAbandonedDownloadsOnSignOut,
  reportAbandonedDownloadOnDisable,
  sweepDelistedDownloadTerminals,
} from '../abandoned-download-terminals';

const DOWNLOADING = 'tension:11:8';
const DOWNLOADED = 'kilter:1:5';

let workDir: string;
let db: TestSqliteDb & SQLiteDatabase;

/** `markScopeDownloadStarted` is package-internal — only the pull client writes it. */
const announceDownload = (scopeKey: string) =>
  db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [`scope-started:${scopeKey}`, '1']);

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'abandoned-terminals-'));
  db = createTestDatabase(join(workDir, 'client.db')) as unknown as TestSqliteDb & SQLiteDatabase;
  await runMigrations(db);
  enabledScopeKeys.current = [];
  // The one-terminal-per-teardown claim is process-local, so a suite that closes
  // several funnels for the same scope has to start each case with a clean one.
  __resetDownloadTerminalRegistryForTests();
  reportScopeDownloadAbandonedOnSignOut.mockClear();
  reportScopeDownloadAbandonedOnDisable.mockClear();
});

afterEach(() => {
  db.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe('reportAbandonedDownloadsOnSignOut', () => {
  it('closes every open funnel and leaves the finished ones alone', async () => {
    await announceDownload(DOWNLOADING);
    await announceDownload(DOWNLOADED);
    await markScopeDownloadComplete(db, DOWNLOADED);

    await reportAbandonedDownloadsOnSignOut(db);

    expect(reportScopeDownloadAbandonedOnSignOut).toHaveBeenCalledTimes(1);
    expect(reportScopeDownloadAbandonedOnSignOut).toHaveBeenCalledWith({ scopeKey: DOWNLOADING });
    // Cleared, so the selective sign-out's surviving markers cannot report twice
    // — nor make a later re-download emit Completed with no Started.
    expect(await isScopeDownloadStarted(db, DOWNLOADING)).toBe(false);
  });

  it('is a no-op when nothing was downloading', async () => {
    await reportAbandonedDownloadsOnSignOut(db);
    expect(reportScopeDownloadAbandonedOnSignOut).not.toHaveBeenCalled();
  });

  it('never fails a sign-out over a database it cannot read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const brokenDb = {
      getAllAsync: async () => {
        throw new Error('database is locked');
      },
    } as unknown as SQLiteDatabase;

    await expect(reportAbandonedDownloadsOnSignOut(brokenDb)).resolves.toBeUndefined();
    expect(reportScopeDownloadAbandonedOnSignOut).not.toHaveBeenCalled();
  });
});

describe('reportAbandonedDownloadOnDisable', () => {
  it('reports the toggled-off scope and closes its funnel', async () => {
    await announceDownload(DOWNLOADING);

    await reportAbandonedDownloadOnDisable(db, DOWNLOADING);

    expect(reportScopeDownloadAbandonedOnDisable).toHaveBeenCalledWith({ scopeKey: DOWNLOADING });
    expect(await isScopeDownloadStarted(db, DOWNLOADING)).toBe(false);
  });

  it('stays silent for a board whose download had already finished', async () => {
    await announceDownload(DOWNLOADED);
    await markScopeDownloadComplete(db, DOWNLOADED);

    await reportAbandonedDownloadOnDisable(db, DOWNLOADED);

    expect(reportScopeDownloadAbandonedOnDisable).not.toHaveBeenCalled();
    // Its Started stays: `scope-complete:` already closed that funnel, and the
    // marker is what keeps the pair once-ever per download lifecycle.
    expect(await isScopeDownloadStarted(db, DOWNLOADED)).toBe(true);
  });

  it('stays silent for a board that never announced a download', async () => {
    await reportAbandonedDownloadOnDisable(db, DOWNLOADING);
    expect(reportScopeDownloadAbandonedOnDisable).not.toHaveBeenCalled();
  });

  it('leaves a sibling board mid-download alone', async () => {
    await announceDownload(DOWNLOADING);
    await announceDownload(DOWNLOADED);

    await reportAbandonedDownloadOnDisable(db, DOWNLOADED);

    expect(reportScopeDownloadAbandonedOnDisable).toHaveBeenCalledTimes(1);
    expect(await isScopeDownloadStarted(db, DOWNLOADING)).toBe(true);
  });

  it('opens a fresh funnel on re-enable rather than resuming the one it closed', async () => {
    await announceDownload(DOWNLOADING);
    await reportAbandonedDownloadOnDisable(db, DOWNLOADING);

    // What `emitScopeDownloadStartOnce` reads. A surviving marker here is exactly
    // how the re-enabled download would lose its Started.
    expect(await isScopeDownloadStarted(db, DOWNLOADING)).toBe(false);
    await announceDownload(DOWNLOADING);

    // …and the second toggle-off gets its own terminal.
    await reportAbandonedDownloadOnDisable(db, DOWNLOADING);
    expect(reportScopeDownloadAbandonedOnDisable).toHaveBeenCalledTimes(2);
  });
});

describe('sweepDelistedDownloadTerminals', () => {
  it('reports a marker left behind for a board nobody enabled any more', async () => {
    await announceDownload(DOWNLOADING);
    enabledScopeKeys.current = [DOWNLOADED];

    await sweepDelistedDownloadTerminals(db);

    expect(reportScopeDownloadAbandonedOnDisable).toHaveBeenCalledWith({ scopeKey: DOWNLOADING });
  });

  it('reports once, not on every launch', async () => {
    await announceDownload(DOWNLOADING);

    await sweepDelistedDownloadTerminals(db);
    await sweepDelistedDownloadTerminals(db);

    expect(reportScopeDownloadAbandonedOnDisable).toHaveBeenCalledTimes(1);
  });

  it('never touches a board that is still enabled and still downloading', async () => {
    // A 40k-climb crawl legitimately spans launches; its Started is meant to stay
    // open across all of them.
    await announceDownload(DOWNLOADING);
    enabledScopeKeys.current = [DOWNLOADING];

    await sweepDelistedDownloadTerminals(db);

    expect(reportScopeDownloadAbandonedOnDisable).not.toHaveBeenCalled();
    expect(await isScopeDownloadStarted(db, DOWNLOADING)).toBe(true);
  });

  it('ignores a de-listed board whose download had completed', async () => {
    await announceDownload(DOWNLOADED);
    await markScopeDownloadComplete(db, DOWNLOADED);

    await sweepDelistedDownloadTerminals(db);

    expect(reportScopeDownloadAbandonedOnDisable).not.toHaveBeenCalled();
  });
});
