// The download funnel's terminal on the paths that DE-LIST a board rather than
// deleting it (issue #4452), replayed against the REAL client DDL.
//
// #4450 closed the removal case: `removeBoardScopeData` reads `scope-started:`
// before its delete transaction and emits `abandoned-removed` after the commit.
// Every other ender stayed silent — and the mechanism they share is not "the
// marker was deleted", it is "the scope left `syncEnabledBoards`", which
// `pullSync`'s board loop only ever iterates. So:
//
//   - the EXPLICIT sign-out wipes sync_meta wholesale (`deleteAllSyncMeta`), so
//     the markers have to be read before the transaction and reported after it,
//     exactly like the teardown;
//   - the SELECTIVE sign-outs (forced 401, proactive expiry, identity change)
//     keep every marker and every row, and still end the download for good;
//   - the My Boards toggle-off deletes nothing whatsoever.
//
// The wipe wiring itself lives in mobile's `purgeLocalDataForSignOut` (this
// package is platform-free and never sees expo-sqlite), so the shape is modelled
// here — read before, wipe, claim, emit after — while
// `packages/mobile/src/db/__tests__/connection.test.ts` pins the real call site
// against the same contract.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  markScopeDownloadStarted,
  markScopeDownloadComplete,
  isScopeDownloadStarted,
  isScopeDownloadComplete,
  getUnfinishedDownloadScopeKeys,
  clearScopeDownloadFunnelMarkers,
  ensureScopeDownloadStartedAt,
  deleteAllSyncMeta,
  setCheckpoint,
  getCheckpoint,
  getCheckpointKey,
} from '../checkpoints';
import {
  claimAbandonedDownloadTerminal,
  noteScopeDownloadTerminal,
  __resetDownloadTerminalRegistryForTests,
} from '../download-terminal-registry';
import { runMigrations } from '../../db/migrations';
import { ensureMutationQueueTable } from '../../mutation-queue/schema';
import { beginScopePurge, setSigningOut, __resetDrainerStateForTests } from '../../mutation-queue/drainer';
import { purgeNamespaceForScopeKey } from '../../offline-board-key';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';

const DOWNLOADING = 'tension:11:8';
const DOWNLOADED = 'kilter:1:5';
const DOWNLOADING_NAMESPACE = 'tension:11';

let workDir: string;
let db: TestSqliteDb;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'abandoned-signout-'));
  db = createTestDatabase(join(workDir, 'client.db'));
  await runMigrations(db);
  await ensureMutationQueueTable(db);
  __resetDrainerStateForTests();
  __resetDownloadTerminalRegistryForTests();
});

afterEach(() => {
  db.close();
  __resetDrainerStateForTests();
  __resetDownloadTerminalRegistryForTests();
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * The shape `purgeLocalDataForSignOut` implements: read the open funnels BEFORE
 * the transaction that destroys them, wipe, then claim-and-emit after the commit.
 */
async function signOutWipe(onDownloadAbandoned: (info: { scopeKey: string }) => void): Promise<void> {
  const abandoned = await getUnfinishedDownloadScopeKeys(db);
  await db.withExclusiveTransactionAsync(async (txn) => {
    await deleteAllSyncMeta(txn);
  });
  for (const scopeKey of abandoned) {
    const namespace = purgeNamespaceForScopeKey(scopeKey);
    if (namespace !== undefined && !claimAbandonedDownloadTerminal(scopeKey, namespace)) continue;
    onDownloadAbandoned({ scopeKey });
  }
}

describe('getUnfinishedDownloadScopeKeys', () => {
  it('names only the scopes with a Started and no Completed', async () => {
    await markScopeDownloadStarted(db, DOWNLOADING);
    await markScopeDownloadStarted(db, DOWNLOADED);
    await markScopeDownloadComplete(db, DOWNLOADED);

    expect(await getUnfinishedDownloadScopeKeys(db)).toEqual([DOWNLOADING]);
  });

  it('is empty when nothing ever announced a download', async () => {
    await markScopeDownloadComplete(db, DOWNLOADED);
    expect(await getUnfinishedDownloadScopeKeys(db)).toEqual([]);
  });

  it('does not confuse the start STAMP with the start MARKER', async () => {
    // `scope-download-started:` is the wall-clock stamp; only `scope-started:`
    // opens a funnel. A GLOB on the wrong prefix would return this scope.
    await ensureScopeDownloadStartedAt(db, DOWNLOADING, 1_700_000_000_000);
    expect(await getUnfinishedDownloadScopeKeys(db)).toEqual([]);
  });
});

describe('clearScopeDownloadFunnelMarkers', () => {
  it('closes the funnel without touching the rows it describes', async () => {
    await markScopeDownloadStarted(db, DOWNLOADING);
    await ensureScopeDownloadStartedAt(db, DOWNLOADING, 1_700_000_000_000);
    const checkpointKey = getCheckpointKey('board_climbs', DOWNLOADING);
    await setCheckpoint(db, checkpointKey, { updatedAt: '2026-05-02T00:00:00Z', syncSeq: '20' });
    await markScopeDownloadComplete(db, DOWNLOADED);

    await clearScopeDownloadFunnelMarkers(db, DOWNLOADING);

    expect(await isScopeDownloadStarted(db, DOWNLOADING)).toBe(false);
    // The checkpoint is what makes a re-enable resume instantly rather than
    // re-crawl 40k climbs, and `scope-complete:` is what tells local-first search
    // a catalog is on disk. Neither is the funnel's business.
    expect(await getCheckpoint(db, checkpointKey)).not.toBeNull();
    expect(await isScopeDownloadComplete(db, DOWNLOADED)).toBe(true);
  });
});

describe('a sign-out landing mid-download (issue #4452)', () => {
  it('closes the in-flight Started, and only that one, with exactly one terminal', async () => {
    await markScopeDownloadStarted(db, DOWNLOADING);
    await markScopeDownloadStarted(db, DOWNLOADED);
    await markScopeDownloadComplete(db, DOWNLOADED);

    const terminals: string[] = [];
    setSigningOut(true);
    await signOutWipe(({ scopeKey }) => terminals.push(scopeKey));
    setSigningOut(false);

    expect(terminals).toEqual([DOWNLOADING]);
    // And the evidence really is gone by then — which is why the read has to
    // happen before the transaction rather than after it.
    expect(await getUnfinishedDownloadScopeKeys(db)).toEqual([]);
  });

  it('stays silent when nothing was downloading', async () => {
    await markScopeDownloadStarted(db, DOWNLOADED);
    await markScopeDownloadComplete(db, DOWNLOADED);

    const onDownloadAbandoned = vi.fn();
    setSigningOut(true);
    await signOutWipe(onDownloadAbandoned);
    setSigningOut(false);

    expect(onDownloadAbandoned).not.toHaveBeenCalled();
  });

  it('emits ONE terminal, not two, when the torn-down cycle already reported aborted-wipe', async () => {
    await markScopeDownloadStarted(db, DOWNLOADING);

    const terminals: string[] = [];
    // setSigningOut bumps the global wipe epoch and tears the cycle down; the
    // bootstrap phase reports its own `aborted-wipe` for the attempt it just
    // abandoned, which the pull client notes in the registry.
    setSigningOut(true);
    noteScopeDownloadTerminal(DOWNLOADING);
    await signOutWipe(({ scopeKey }) => terminals.push(scopeKey));
    setSigningOut(false);

    expect(terminals).toEqual([]);
  });

  it('still reports when an EARLIER removal noted a terminal for the same scope', async () => {
    await markScopeDownloadStarted(db, DOWNLOADING);

    // A sibling board in this namespace was removed earlier in the session, and
    // the cycle it tore down reported `aborted-wipe` for our scope. That removal
    // is not this sign-out.
    const release = beginScopePurge(DOWNLOADING_NAMESPACE);
    noteScopeDownloadTerminal(DOWNLOADING);
    release();

    // Under the namespace-only generation #4406 shipped, the stale note IS the
    // current generation, so the sign-out below would be suppressed.
    expect(claimAbandonedDownloadTerminal(DOWNLOADING, DOWNLOADING_NAMESPACE)).toBe(false);

    const terminals: string[] = [];
    setSigningOut(true);
    await signOutWipe(({ scopeKey }) => terminals.push(scopeKey));
    setSigningOut(false);

    // The composite generation moves with the wipe epoch, so the sign-out gets
    // its own claim.
    expect(terminals).toEqual([DOWNLOADING]);
  });

  it('gives a second sign-out in the same session its own claim', async () => {
    setSigningOut(true);
    expect(claimAbandonedDownloadTerminal(DOWNLOADING, DOWNLOADING_NAMESPACE)).toBe(true);
    // Same sign-out, same generation: no second terminal.
    expect(claimAbandonedDownloadTerminal(DOWNLOADING, DOWNLOADING_NAMESPACE)).toBe(false);
    setSigningOut(false);

    setSigningOut(true);
    expect(claimAbandonedDownloadTerminal(DOWNLOADING, DOWNLOADING_NAMESPACE)).toBe(true);
    setSigningOut(false);
  });
});

describe('a de-listed scope keeps its rows and opens a fresh funnel (issue #4452)', () => {
  it('lets the next download emit its own Started after a toggle-off', async () => {
    await markScopeDownloadStarted(db, DOWNLOADING);
    const checkpointKey = getCheckpointKey('board_climbs', DOWNLOADING);
    await setCheckpoint(db, checkpointKey, { updatedAt: '2026-05-02T00:00:00Z', syncSeq: '20' });

    // The toggle-off: report, then close the funnel. Nothing else is deleted.
    await clearScopeDownloadFunnelMarkers(db, DOWNLOADING);
    expect(await getUnfinishedDownloadScopeKeys(db)).toEqual([]);

    // The re-enable. `emitScopeDownloadStartOnce` gates on this exact read, so a
    // surviving marker would have made the next download's Started disappear —
    // and its eventual Completed unmatched.
    expect(await isScopeDownloadStarted(db, DOWNLOADING)).toBe(false);
    await markScopeDownloadStarted(db, DOWNLOADING);
    expect(await getUnfinishedDownloadScopeKeys(db)).toEqual([DOWNLOADING]);
    // The crawl still resumes from where the abandoned one stopped.
    expect(await getCheckpoint(db, checkpointKey)).not.toBeNull();
  });
});
