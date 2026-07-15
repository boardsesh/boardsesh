// Removing a downloaded board's data from this device (issue #3617).
//
// The engine owns the SQL (@boardsesh/offline-sync's removeBoardScopeData); this
// module owns the ORDER, which is the part that can go wrong without any SQL being
// wrong at all.

import type { QueryClient } from '@tanstack/react-query';
import {
  beginLocalPurge,
  removeBoardScopeData,
  offlineBoardKey,
  parseOfflineBoardKey,
  vacuumDatabase,
  TABLE_CONFIGS,
  BOARD_DATA_TABLES,
  type OfflineBoardScope,
  type OfflineDatabase,
  type ScopeTeardownResult,
} from '@boardsesh/offline-sync';
import { getSetting, setOfflineBoardEnabled } from '../settings';
import { reportHandledError } from '../lib/error-reporting';

/** The query keys that read board reference rows, derived from the tables we delete from. */
function boardDataQueryKeys(): readonly (readonly unknown[])[] {
  const keys = BOARD_DATA_TABLES.flatMap((tableName) => TABLE_CONFIGS[tableName]?.invalidateKeys ?? []);
  // Deduplicate: the three board tables deliberately share most of their reader keys.
  const seen = new Set<string>();
  return keys.filter((key) => {
    const id = JSON.stringify(key);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * Invalidate everything that could still be holding rows we just deleted. Without
 * this a local-first climb search keeps serving the removed catalog straight out of
 * the React Query cache, and the board looks downloaded when it isn't.
 */
function invalidateBoardReaders(queryClient: QueryClient): void {
  for (const queryKey of boardDataQueryKeys()) {
    void queryClient.invalidateQueries({ queryKey });
  }
  // The "Available offline" signal My Boards reads, and this screen's own measurement.
  void queryClient.invalidateQueries({ queryKey: ['downloadedScopeKeys'] });
  void queryClient.invalidateQueries({ queryKey: ['offlineStorage'] });
}

/**
 * Remove one downloaded board scope: turn its offline toggle off, then delete its
 * rows and every marker describing them.
 *
 * The order is load-bearing.
 *
 * 1. THE SETTING GOES FIRST. `getEnabledBoards()` is read at the top of every sync
 *    cycle, and a cycle fires on any foreground or connectivity change. If the scope
 *    were still listed when the next one ran, the pull client would find no checkpoint
 *    and no scope-complete marker — i.e. a brand-new board — and re-download the whole
 *    catalog on cellular without asking. The user taps Remove, watches the number hit
 *    zero, and watches it climb straight back.
 * 2. `beginLocalPurge()` aborts any in-flight pull, so a page already on the wire
 *    can't land after the delete and resurrect rows with a checkpoint past them.
 * 3. The retained set is read AFTER step 1, so it's exactly "every scope that must
 *    survive" — this scope has already dropped out of it.
 *
 * Killed between 1 and 4? The setting is gone and the rows remain — benign, because
 * isBoardDownloadedLocally checks the setting first so nothing reads them, and the
 * teardown is idempotent so the next attempt reaps them. The reverse order is the
 * dangerous one.
 */
export async function removeOfflineBoard(params: {
  db: OfflineDatabase;
  queryClient: QueryClient;
  scope: OfflineBoardScope;
}): Promise<ScopeTeardownResult> {
  const { db, queryClient, scope } = params;

  setOfflineBoardEnabled(scope, false);
  beginLocalPurge();

  const retainedScopes = getSetting('syncEnabledBoards')
    .map(parseOfflineBoardKey)
    .filter((parsed): parsed is OfflineBoardScope => parsed !== null);

  const result = await removeBoardScopeData({ db, scope, scopeKey: offlineBoardKey(scope), retainedScopes });
  invalidateBoardReaders(queryClient);
  return result;
}

/**
 * Remove every downloaded board. Each scope is torn down in turn (so a failure part
 * way through still leaves a consistent device), with `retainedScopes: []` falling
 * out naturally because each iteration re-reads the setting after the previous one
 * emptied it further.
 */
export async function removeAllOfflineBoards(params: {
  db: OfflineDatabase;
  queryClient: QueryClient;
  scopeKeys: readonly string[];
}): Promise<void> {
  const { db, queryClient, scopeKeys } = params;
  for (const scopeKey of scopeKeys) {
    const scope = parseOfflineBoardKey(scopeKey);
    // A malformed legacy entry has no scope to delete rows for; drop the setting
    // entry so it stops showing up, and move on.
    if (!scope) continue;
    await removeOfflineBoard({ db, queryClient, scope });
  }
}

/**
 * Hand the freed pages back to the filesystem.
 *
 * Kept separate from the teardowns above, and best-effort by design: the teardown
 * transactions have already committed, so a failure here means "the data is gone but
 * the file didn't shrink" — never data loss. That's worth reporting (a persistent
 * failure means users can't actually reclaim space) but never worth surfacing as an
 * error that implies the removal didn't work. Runs once after all teardowns, not per
 * scope: it rebuilds the entire file each time.
 */
export async function compactOfflineDatabase(db: OfflineDatabase): Promise<boolean> {
  try {
    await vacuumDatabase(db);
    return true;
  } catch (error) {
    reportHandledError(error, { tags: { source: 'offline-sync', kind: 'vacuum' } });
    return false;
  }
}
