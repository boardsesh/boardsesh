// The download funnel's terminal event for every path that DE-LISTS a board
// instead of deleting it (issue #4452).
//
// `Offline Board Download Started` is emitted once per scope and guarded by the
// durable `scope-started:` marker, so its terminal is owed by whatever ends the
// download. Until now exactly one ender reported: `removeBoardScopeData`, which
// reads the marker before its delete transaction and emits `abandoned-removed`
// after the commit (issue #4406). Every other ender was silent.
//
// The mechanism they share is NOT "the marker was deleted" — it is "the scope
// left `syncEnabledBoards`". `pullSync`'s board loop iterates only enabled
// scopes, so a de-listed board is never visited again and its Started stays open
// forever, even though nothing was deleted and the marker is still sitting in
// sync_meta. That covers the My Boards toggle-off (which deletes nothing at all)
// and all three sign-outs (`runSignedOutCleanup` empties the list for the manual,
// forced-401 and proactive-expiry paths alike).
//
// Reporting and CLEARING are one step here, deliberately. The marker is what
// makes a second report impossible, and it is also what would otherwise make a
// re-enable's download emit Completed with no Started of its own. Two Starteds
// for a toggle-off-then-on is the honest reading: as far as the funnel is
// concerned those are two downloads.

import type { SQLiteDatabase } from 'expo-sqlite';
import {
  getUnfinishedDownloadScopeKeys,
  clearScopeDownloadFunnelMarkers,
  claimAbandonedDownloadTerminal,
  purgeNamespaceForScopeKey,
  isScopeDownloadStarted,
  isScopeDownloadComplete,
} from '@boardsesh/offline-sync';
import { getSetting } from '../settings';
import { reportScopeDownloadAbandonedOnSignOut, reportScopeDownloadAbandonedOnDisable } from './offline-sync-adapter';

/**
 * Emit the terminal for a scope that was DE-LISTED without a teardown — the My
 * Boards toggle-off and the launch backstop — then close its funnel.
 *
 * No teardown-generation claim here, deliberately, unlike the sign-out path
 * below. Nothing tore a cycle down, so there is no competing `aborted-wipe` to
 * defer to, and the claim would actively lose events: it is keyed on a
 * generation that only a purge or a sign-out moves, so toggling one board off,
 * back on, and off again in a single session — an ordinary thing to do — would
 * report the first abandonment and silently swallow the second. The cleared
 * marker is the dedup that actually holds, and it is durable: once it is gone,
 * no path anywhere can find an unfinished download for this scope.
 */
async function closeDelistedScopeFunnel(db: SQLiteDatabase, scopeKey: string): Promise<void> {
  reportScopeDownloadAbandonedOnDisable({ scopeKey });
  await clearScopeDownloadFunnelMarkers(db, scopeKey);
}

/**
 * Run one scope's close without letting it take the rest of a sweep down with
 * it. A locked database on the first of five scopes must not silently drop the
 * other four — they are independent funnels, and the one that failed is covered
 * by the next launch's sweep because its marker is still there.
 */
async function closeScopeFunnelQuietly(scopeKey: string, close: () => Promise<void>): Promise<void> {
  try {
    await close();
  } catch (error) {
    if (__DEV__) {
      console.warn(`[offline] failed to close the abandoned download funnel for ${scopeKey}:`, error);
    }
  }
}

/**
 * The SELECTIVE sign-out — a forced 401, a proactive token expiry, or an
 * identity change. These keep every marker (`clearUserData` preserves the board
 * checkpoints and never touches `scope-started:`) and keep every downloaded row,
 * but `runSignedOutCleanup` empties `syncEnabledBoards` for them too, so no
 * future cycle will ever finish the download.
 *
 * The EXPLICIT sign-out does not come through here: its wipe destroys the
 * markers inside its own transaction, so `purgeLocalDataForSignOut` has to read
 * them before it commits and report through its own seam.
 *
 * Best-effort, like every other sign-out cleanup step: a database that will not
 * open must never fail a sign-out over a telemetry event.
 */
export async function reportAbandonedDownloadsOnSignOut(db: SQLiteDatabase): Promise<void> {
  try {
    for (const scopeKey of await getUnfinishedDownloadScopeKeys(db)) {
      await closeScopeFunnelQuietly(scopeKey, async () => {
        // The teardown claim #4406 built, and this path genuinely needs it:
        // `setSigningOut(true)` bumps the global wipe epoch and tears the
        // running cycle down, so the bootstrap phase reports its own
        // `aborted-wipe` for this same scope milliseconds earlier. Two terminals
        // for one Started would break the funnel invariant. A key we cannot
        // parse belongs to no namespace, so the registry never records one for
        // it and nothing can double-report it — those are reported rather than
        // dropped.
        const namespace = purgeNamespaceForScopeKey(scopeKey);
        if (namespace === undefined || claimAbandonedDownloadTerminal(scopeKey, namespace)) {
          reportScopeDownloadAbandonedOnSignOut({ scopeKey });
        }
        // Cleared either way: the download is over whether or not this call site
        // was the one that got to say so.
        await clearScopeDownloadFunnelMarkers(db, scopeKey);
      });
    }
  } catch (error) {
    if (__DEV__) {
      console.warn('[offline] failed to close abandoned download funnels during sign-out:', error);
    }
  }
}

/**
 * The My Boards toggle-off — the highest-volume de-list the code can still be
 * responsible for. Nothing is deleted (the rows and checkpoints stay so a
 * re-enable resumes instantly), which is exactly why nothing reported before:
 * there is no teardown to hang the terminal off.
 *
 * Called with the scope the climber just turned off, so it reads that one key
 * rather than sweeping — a sibling board mid-download must keep its funnel open.
 */
export async function reportAbandonedDownloadOnDisable(db: SQLiteDatabase, scopeKey: string): Promise<void> {
  try {
    const [started, complete] = await Promise.all([
      isScopeDownloadStarted(db, scopeKey),
      isScopeDownloadComplete(db, scopeKey),
    ]);
    if (!started || complete) return;
    await closeDelistedScopeFunnel(db, scopeKey);
  } catch (error) {
    if (__DEV__) {
      console.warn('[offline] failed to close the abandoned download funnel on toggle-off:', error);
    }
  }
}

/**
 * The launch backstop, so this is structural rather than another list of sites
 * someone has to remember (the lesson #4391 wrote down).
 *
 * Any `scope-started:` marker whose scope is NOT in `syncEnabledBoards` is an
 * open funnel nothing will ever close: the board is de-listed, so no cycle will
 * visit it. That state is reachable three ways — a crash between the de-list and
 * the in-session report, a device upgrading from a build that predates this fix,
 * and any future de-listing path nobody instruments. Sweeping it at launch
 * covers all three without knowing which happened.
 *
 * Attribution is honest but imperfect here: this reports on the NEXT session's
 * distinct_id. The in-session reports above are the primary path precisely so
 * this only fires on crashes and upgrades.
 */
export async function sweepDelistedDownloadTerminals(db: SQLiteDatabase): Promise<void> {
  try {
    const unfinished = await getUnfinishedDownloadScopeKeys(db);
    if (unfinished.length === 0) return;
    const enabledScopeKeys = new Set(getSetting('syncEnabledBoards'));
    for (const scopeKey of unfinished) {
      // Still enabled means still downloading — a board-data crawl legitimately
      // spans launches, and its Started is meant to stay open across all of them.
      if (enabledScopeKeys.has(scopeKey)) continue;
      await closeScopeFunnelQuietly(scopeKey, () => closeDelistedScopeFunnel(db, scopeKey));
    }
  } catch (error) {
    if (__DEV__) {
      console.warn('[offline] failed to sweep de-listed download funnels:', error);
    }
  }
}
