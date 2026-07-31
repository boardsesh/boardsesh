// Deletions coverage — the client half of the tombstone-retention contract
// (issue #3474). See retention.ts for the server half.
//
// THE INVARIANT. A client that pulled the deletions stream to its TAIL at
// wall-clock time T has consumed every tombstone that existed at T. Anything the
// server prunes after T was therefore already applied locally. The device can
// only miss data if `now - T` exceeds the retention window — at which point
// tombstones it never saw have been hard-deleted server-side and no cursor can
// reach them again.
//
// WHY NOT THE CHECKPOINT'S OWN AGE. `checkpoint:deletions` holds the server-side
// `deleted_at` of the last tombstone consumed, and pull-client only advances it
// on a NON-EMPTY page. A user who has not deleted anything for three months
// carries a three-month-old cursor on a perfectly current device — and in
// production the board tables emit no tombstones at all (every production DELETE
// of board_climbs / board_climb_stats runs inside the transaction that sets
// `boardsesh.suppress_sync_tombstones`, see packages/db/src/queries/boards/clear-aurora-board.ts),
// so the ONLY tombstones a given user ever sees are their own. A cursor-age test
// would wipe most of the fleet. This marker is a client wall clock, written only
// when the deletions pull actually reached the tail; never compare a
// server-sourced timestamp against Date.now() here.

import type { OfflineDatabase, SqlExecutor } from '../database';
import { applyBusyTimeout } from '../db/pragmas';
import { DELETIONS_CHECKPOINT_KEY, getCheckpointKey } from './checkpoints';
import { DELETIONS_COVERAGE_EPOCH_FLOOR_MS, DELETIONS_COVERAGE_KEY, DELETIONS_COVERAGE_MAX_AGE_MS } from './retention';
import { USER_DATA_TABLES } from './table-config';

// The key itself lives in retention.ts (dependency-free, so sign-out's
// checkpoint teardown can clear it without importing this module).
export { DELETIONS_COVERAGE_KEY } from './retention';

export type DeletionsCoverageVerdict =
  /**
   * No usable marker: absent (fresh install, or the OTA that introduced this),
   * or a value below the plausibility floor. Reset nothing; the next completed
   * deletions pull stamps it.
   */
  | 'unknown'
  /**
   * Marker is dated after `now` — a clock corrected backwards. Reset nothing;
   * the completed-pass stamp overwrites it with a real `now`.
   */
  | 'future'
  /** Within the window: every tombstone since the marker is still queryable. */
  | 'fresh'
  /** Older than the window: tombstones may already be pruned. Forced resync. */
  | 'stale';

export async function getDeletionsCoverageAt(db: SqlExecutor): Promise<number | null> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [
    DELETIONS_COVERAGE_KEY,
  ]);
  if (!row) return null;
  // Digits-only, deliberately: Number.parseInt tolerates trailing garbage, so an
  // ISO string written by some future refactor would parse to its leading year
  // ('2026-07-01…' → 2026 ≈ epoch-ms 1970) and read as decades stale. A corrupt
  // value must read as ABSENT — seeding a fresh marker costs one retention
  // window of exposure, whereas treating it as infinitely old wipes user data
  // off a garbled row. (evaluateDeletionsCoverage's floor catches the same class
  // of value; this is the cheaper of the two belts.)
  if (!/^\d+$/.test(row.value.trim())) return null;
  const parsed = Number.parseInt(row.value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function setDeletionsCoverageAt(db: SqlExecutor, atMs: number): Promise<void> {
  await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
    DELETIONS_COVERAGE_KEY,
    String(atMs),
  ]);
}

/**
 * Classify a coverage marker against the retention window. `coverageAt` is the
 * stored marker (null when absent); `nowMs` is the caller's clock, passed in so
 * tests don't have to fake time.
 */
export function evaluateDeletionsCoverage(coverageAt: number | null, nowMs: number): DeletionsCoverageVerdict {
  if (coverageAt === null) return 'unknown';
  // Below the floor is a broken clock, not an old device — see
  // DELETIONS_COVERAGE_EPOCH_FLOOR_MS. A phone that boots to 1970 before NTP
  // lands takes the 'future' branch and re-stamps the marker with its bogus
  // "now"; without this, the correction back to real time would then read as
  // decades stale and wipe a device that has been syncing daily.
  if (coverageAt < DELETIONS_COVERAGE_EPOCH_FLOOR_MS) return 'unknown';
  if (coverageAt > nowMs) return 'future';
  return nowMs - coverageAt > DELETIONS_COVERAGE_MAX_AGE_MS ? 'stale' : 'fresh';
}

/**
 * Drop every local USER-DATA row and the cursors that describe them, so the
 * cycle that follows re-pulls them from the epoch.
 *
 * WHAT IS DELETED: the rows of every USER_DATA_TABLES entry (ticks, playlists,
 * playlist climbs, favourites, the three follow tables), each of their
 * `checkpoint:<table>` keys, and the single `checkpoint:deletions` key. Rewinding
 * a checkpoint alone would not do: the delta resolver never re-emits a row the
 * server deleted, so a row that lost its tombstone can only be removed by
 * deleting it locally.
 *
 * WHAT IS DELIBERATELY NOT TOUCHED, and why:
 *  - `board_climbs` / `board_climb_stats` / `board_climb_grades` rows, their
 *    `checkpoint:board_*` keys, `scope-complete:*` and the bootstrap markers.
 *    No production path emits a board tombstone — the only DELETEs of those
 *    tables run inside clear-aurora-board.ts's transaction, which sets
 *    `boardsesh.suppress_sync_tombstones`, and board_climb_grades has no delete
 *    trigger at all — so a lost deletions window costs the catalog nothing.
 *    Clearing it would re-download tens to hundreds of MB, unprompted, possibly
 *    on cellular. A catalog rebuild stays where the user asks for it
 *    (removeBoardScopeData, behind the Storage settings flow).
 *  - `pending_mutations`. Unsynced local writes are not recoverable from the
 *    server; drainMutationQueue legitimately leaves rows behind (attempt budget,
 *    dead letters, offline), so "drain first, then wipe" is not a substitute for
 *    simply never touching the table.
 *  - `schema_version` and every other sync_meta key. Deletes are by exact key,
 *    never by pattern, so a future marker can't be swallowed by accident.
 *
 * KNOWN TRANSIENT: use-local-ticks JOINs pending_mutations onto boardsesh_ticks,
 * so an optimistic tick whose mutation has not drained yet disappears from the
 * logbook between this wipe and the drain that re-lands it from the server. The
 * write itself is safe — it is still in the outbox.
 *
 * One exclusive transaction, busy timeout first (same shape as
 * removeBoardScopeData): rows-gone-but-cursors-alive would be unrecoverable,
 * because the strict `>` delta would never revisit the deleted rows.
 */
export async function resetUserDataForLostCoverage(
  db: OfflineDatabase,
  nowMs: number,
): Promise<{ rowsCleared: number }> {
  let rowsCleared = 0;

  await db.withExclusiveTransactionAsync(async (txn) => {
    // These deletes can take a moment on a large logbook; don't lose the BEGIN
    // EXCLUSIVE to a straggling write on the main connection.
    await applyBusyTimeout(txn);

    for (const tableName of USER_DATA_TABLES) {
      // Interpolated, because SQLite parameters bind values, not identifiers.
      // Safe only while USER_DATA_TABLES stays compile-time literal (it is
      // derived from TABLE_CONFIGS' keys) — same contract as removeBoardScopeData.
      // Never let a computed or user-derived name into that array.
      const result = await txn.runAsync(`DELETE FROM ${tableName}`, []);
      rowsCleared += result.changes;
    }

    for (const tableName of USER_DATA_TABLES) {
      await deleteMetaKey(txn, getCheckpointKey(tableName));
    }
    await deleteMetaKey(txn, DELETIONS_CHECKPOINT_KEY);

    // Stamped LAST, inside the same transaction as the deletes it justifies.
    // After a full wipe the invariant holds trivially — no local user row
    // predates this moment — so the marker is honest, and a device whose
    // rebuild pull then fails does not wipe itself again on every trigger.
    await setDeletionsCoverageAt(txn, nowMs);
  });

  return { rowsCleared };
}

async function deleteMetaKey(txn: SqlExecutor, key: string): Promise<void> {
  await txn.runAsync('DELETE FROM sync_meta WHERE key = ?', [key]);
}
