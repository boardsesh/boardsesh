// Removing one board scope's downloaded catalog, so the user can get the disk
// space back (issue #3617). The counterpart to the snapshot bootstrap / paged pull
// that put the rows there.
//
// Two invariants carry this whole module, and both are data-loss bugs when broken:
//
// 1. ROWS AND THEIR MARKERS DIE TOGETHER. A scope's downloaded state lives in four
//    kinds of sync_meta rows (see scopeSyncMetaKeys). If rows are deleted but a
//    checkpoint survives, the next pull resumes from that cursor and — because the
//    delta pull is a strict `>` keyset — NEVER revisits the deleted rows. The board
//    comes back permanently incomplete, and a surviving `scope-complete:` marker
//    makes isBoardDownloadedLocally serve that fraction to local-first search as if
//    it were the whole catalog. Unrecoverable short of a reinstall. Hence one
//    exclusive transaction around the lot.
//
//    The failure is asymmetric, which is why the ordering inside the transaction is
//    not arbitrary: markers-gone-but-rows-alive is benign (a re-enable re-crawls
//    into INSERT OR REPLACE — idempotent, just wasteful), while
//    rows-gone-but-markers-alive is unrecoverable.
//
// 2. ONLY DELETE ROWS NOBODY ELSE WANTS. board_climbs rows are shared across sizes
//    of a layout via compatible_size_ids, so removing "Kilter 12x12" must not gut a
//    still-downloaded "Kilter 8x12". See orphanClimbsPredicate.
//
// The caller is responsible for aborting in-flight pulls before calling this
// (beginLocalPurge in mutation-queue/drainer.ts) — a page already on the wire would
// otherwise land after the delete and resurrect part of the catalog, complete with
// a checkpoint past it.

import type { OfflineDatabase, SqlExecutor, SqlValue } from '../database';
import type { OfflineBoardScope } from '../offline-board-key';
import { climbsScopeFilter, isSizeScopedBoard, sizeMembershipClause } from './board-scope-sql';
import { getCheckpointKey, SCOPE_COMPLETE_PREFIX } from './checkpoints';
import { BOOTSTRAP_ATTEMPTS_PREFIX, BOOTSTRAP_DONE_PREFIX } from './snapshot-bootstrap';
import { BOARD_DATA_TABLES } from './table-config';

/** One scope's measured footprint. `estimatedBytes` is an apportionment — see getScopeUsage. */
export type ScopeUsage = {
  scopeKey: string;
  scope: OfflineBoardScope;
  climbCount: number;
  estimatedBytes: number;
};

export type ScopeTeardownResult = {
  climbsDeleted: number;
  statsDeleted: number;
  gradesDeleted: number;
  /** False when a retained sibling shares every row, so nothing was deletable. */
  removedAnyRows: boolean;
};

/**
 * Every sync_meta key describing one scope's downloaded state.
 *
 * The checkpoint keys are DERIVED from BOARD_DATA_TABLES rather than hardcoded, for
 * the same reason deleteUserCheckpoints builds its exclusion list that way: a future
 * per-board table (isPerBoard: true in TABLE_CONFIGS) is then covered automatically.
 * board_climb_grades fell through exactly that gap once already.
 */
export function scopeSyncMetaKeys(scopeKey: string): string[] {
  return [
    ...BOARD_DATA_TABLES.map((tableName) => getCheckpointKey(tableName, scopeKey)),
    `${SCOPE_COMPLETE_PREFIX}${scopeKey}`,
    `${BOOTSTRAP_ATTEMPTS_PREFIX}${scopeKey}`,
    `${BOOTSTRAP_DONE_PREFIX}${scopeKey}`,
  ];
}

/**
 * board_climbs rows of this scope's layout that NO retained scope needs.
 *
 * `board_type` and `layout_id` are columns on the row, so a row belongs to exactly
 * one (boardType, layoutId) pair — a retained scope at a different board or layout
 * can never need it. The only sharing axis is sizeId, via compatible_size_ids, so
 * the retention clause is the NEGATION of the membership check in
 * board-download-status.ts, generalised from one size to a set: keep a row iff its
 * compatible_size_ids contains ANY retained size.
 *
 * Two consequences worth stating plainly:
 *
 * - A NULL compatible_size_ids row is in no scope (Postgres `NULL @> ARRAY[x]` is
 *   NULL/false, which the membership clause mirrors), so `NOT (...)` evaluates true
 *   and the row is deleted. That's correct and deliberate: connection.ts's
 *   loadOptionalSeed copies board rows UNFILTERED, so such rows exist and no read
 *   path can reach them.
 * - This is therefore a "rows of layout (B, L) that nobody needs" sweep rather than
 *   strictly "scope S's rows" — it also takes seeded siblings the user never
 *   enabled. That's the feature (reclaim the space), and it's safe because
 *   isBoardDownloadedLocally gates on syncEnabledBoards + the scope-complete marker
 *   before any row probe, so those rows were never readable. It does mean a teardown
 *   can free MORE bytes than the scope's own estimate.
 */
function orphanClimbsPredicate(
  scope: OfflineBoardScope,
  retainedSizeIds: readonly number[],
): { sql: string; params: SqlValue[] } {
  const params: SqlValue[] = [scope.boardType, scope.layoutId];
  let sql = 'board_type = ? AND layout_id = ?';
  if (isSizeScopedBoard(scope.boardType)) {
    // null when nothing is retained → clause omitted → the whole layout goes.
    const retained = sizeMembershipClause('', retainedSizeIds);
    if (retained) {
      sql += ` AND NOT (${retained.sql})`;
      params.push(...retained.params);
    }
  }
  return { sql, params };
}

/**
 * Per-scope footprint for the manage-storage UI.
 *
 * `climbCount` is exact. `estimatedBytes` is an APPORTIONMENT, not a measurement:
 * a scope's share of board_climbs rows stands in for its share of used pages (stats
 * and grades are per (climb, angle), so they scale with climbs). SQLite can't
 * cheaply attribute real bytes to a subset of rows — `dbstat` isn't compiled into
 * expo-sqlite — and the error is well inside "approximate": ignoring the user tables'
 * pages is <1% against 200k+ board rows.
 *
 * Two sizes of one layout SHARE climb rows, so their estimates both count the shared
 * rows and the parts deliberately sum to MORE than the whole. Callers must not render
 * these as a stacked bar, a percentage of the total, or anything else implying they
 * add up.
 *
 * Scopes come from the caller (the enabled ∪ downloaded set) rather than from
 * checkpoints, so a partial download that never checkpointed still shows up and stays
 * reclaimable.
 *
 * Cost: the json_each membership parse can't be indexed away (idx_climbs_search
 * covers board_type/layout_id, but every candidate row still needs a rowid lookup and
 * a JSON parse), so this is ~100-400ms per scope on a large layout. Keep it off the
 * render path.
 */
export async function getScopeUsage(
  db: OfflineDatabase,
  scopes: readonly { scope: OfflineBoardScope; scopeKey: string }[],
): Promise<ScopeUsage[]> {
  const pageSize = await db.getFirstAsync<{ page_size: number }>('PRAGMA page_size');
  const pageCount = await db.getFirstAsync<{ page_count: number }>('PRAGMA page_count');
  const freelist = await db.getFirstAsync<{ freelist_count: number }>('PRAGMA freelist_count');
  const usedBytes = ((pageCount?.page_count ?? 0) - (freelist?.freelist_count ?? 0)) * (pageSize?.page_size ?? 0);

  const totalRow = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM board_climbs');
  const totalClimbs = totalRow?.n ?? 0;

  const usage: ScopeUsage[] = [];
  for (const { scope, scopeKey } of scopes) {
    const { sql, params } = climbsScopeFilter(scope);
    const row = await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM board_climbs WHERE ${sql}`, params);
    const climbCount = row?.n ?? 0;
    usage.push({
      scopeKey,
      scope,
      climbCount,
      // Guard the empty database: no climbs means no bytes to apportion.
      estimatedBytes: totalClimbs > 0 ? Math.round(usedBytes * (climbCount / totalClimbs)) : 0,
    });
  }
  return usage;
}

async function clearScopeSyncMeta(txn: SqlExecutor, scopeKey: string): Promise<void> {
  const keys = scopeSyncMetaKeys(scopeKey);
  // An exact key list, NOT a `LIKE 'checkpoint:%'` pattern. deleteAllCheckpoints
  // uses that pattern and it would swallow `checkpoint:deletions` — the single
  // global deletions cursor, which must survive (see the note in removeBoardScopeData).
  // Exact keys make that structurally impossible rather than pattern-dependent.
  await txn.runAsync(`DELETE FROM sync_meta WHERE key IN (${keys.map(() => '?').join(', ')})`, keys);
}

/**
 * Remove one board scope's downloaded reference rows and every marker describing
 * them, atomically. Idempotent — a second run is a clean no-op, which is what makes
 * the caller's "setting first, then delete" ordering safe to retry after a crash.
 *
 * `retainedScopes` is every OTHER scope whose data must survive (the caller passes
 * the still-enabled/downloaded set with `scope` already excluded). Nothing in here
 * reads app settings: the package is platform-free, and the caller owns the MMKV
 * ordering.
 *
 * `checkpoint:deletions` is deliberately untouched. It's one global cursor covering
 * the user's own tables plus reference tombstones, and deletions page on
 * `(deleted_at, sync_deletions.id)` — a different keyset from board sync_seq — so
 * there is no per-scope watermark to rewind it to. Leaving it ahead is safe on both
 * re-download paths: a re-bootstrap already calls rewindDeletionsCheckpoint inside
 * its own import transaction (and clearing the board checkpoints here is exactly
 * what makes the scope bootstrap-eligible again), while a paged re-download gets its
 * rows from the resolver, which never emits server-deleted rows.
 */
export async function removeBoardScopeData(params: {
  db: OfflineDatabase;
  scope: OfflineBoardScope;
  scopeKey: string;
  retainedScopes: readonly OfflineBoardScope[];
}): Promise<ScopeTeardownResult> {
  const { db, scope, scopeKey, retainedScopes } = params;

  const retainedSizeIds = retainedScopes
    .filter((retained) => retained.boardType === scope.boardType && retained.layoutId === scope.layoutId)
    .map((retained) => retained.sizeId);

  // MoonBoard isn't size-scoped, so every scope of one (boardType, layoutId) covers
  // an IDENTICAL row set — a retained sibling means nothing here is deletable.
  // Without this guard the predicate below would drop the size clause and delete the
  // whole layout out from under a still-enabled board.
  if (!isSizeScopedBoard(scope.boardType) && retainedSizeIds.length > 0) {
    return { climbsDeleted: 0, statsDeleted: 0, gradesDeleted: 0, removedAnyRows: false };
  }

  // The transaction task returns void (the OfflineDatabase seam mirrors expo-sqlite's
  // shape), so the counts are captured here and read after it commits.
  let result: ScopeTeardownResult = { climbsDeleted: 0, statsDeleted: 0, gradesDeleted: 0, removedAnyRows: false };

  await db.withExclusiveTransactionAsync(async (txn) => {
    // These deletes take seconds on a 40k-climb layout; don't lose the BEGIN
    // EXCLUSIVE to a straggling write on the main connection. Same guard
    // bootstrapScopeFromSnapshot uses.
    await txn.execAsync('PRAGMA busy_timeout = 5000');

    const { sql, params: predicateParams } = orphanClimbsPredicate(scope, retainedSizeIds);
    const climbUuids = `SELECT uuid FROM board_climbs WHERE ${sql}`;

    // Children BEFORE parents, and via a targeted `IN (subquery)` rather than a
    // board_type-wide orphan sweep. Both details are load-bearing:
    //
    // - A sweep (`... AND NOT EXISTS (SELECT 1 FROM board_climbs WHERE uuid = climb_uuid ...)`
    //   run after the climbs delete) would delete stats/grades whose climb row isn't
    //   present YET. That state is normal and reachable: syncTable pulls climbs, then
    //   stats, then grades per scope, so a DIFFERENT, concurrently-downloading scope
    //   can sit with advanced stats/grades checkpoints while its climbs are mid-crawl.
    //   The sweep would take its rows, its checkpoints would stay advanced, and the
    //   strict `>` delta would never revisit them — permanent loss in a board the user
    //   never asked to remove. Grades are the worst case: isBoardTypeDownloadedLocally
    //   gates on board TYPE only, so the sweep's blast radius is the read path's.
    //   The targeted form only touches children of climbs we are actually deleting.
    // - Order: the subquery resolves against board_climbs, so deleting climbs first
    //   would silently delete NOTHING from stats/grades. Covered by a regression test.
    //
    // The leading `board_type = ?` is not redundant — it range-scans idx_stats_lookup,
    // and grades' (board_type, climb_uuid, angle) PK autoindex.
    const stats = await txn.runAsync(
      `DELETE FROM board_climb_stats WHERE board_type = ? AND climb_uuid IN (${climbUuids})`,
      [scope.boardType, ...predicateParams],
    );
    const grades = await txn.runAsync(
      `DELETE FROM board_climb_grades WHERE board_type = ? AND climb_uuid IN (${climbUuids})`,
      [scope.boardType, ...predicateParams],
    );
    const climbs = await txn.runAsync(`DELETE FROM board_climbs WHERE ${sql}`, predicateParams);

    await clearScopeSyncMeta(txn, scopeKey);

    result = {
      climbsDeleted: climbs.changes,
      statsDeleted: stats.changes,
      gradesDeleted: grades.changes,
      removedAnyRows: climbs.changes + stats.changes + grades.changes > 0,
    };
  });

  return result;
}
