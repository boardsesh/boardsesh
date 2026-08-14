// Returning freed SQLite pages to the filesystem.
//
// Deleting rows (see sync/scope-teardown.ts) moves their pages onto SQLite's
// freelist. SQLite reuses those pages for future writes but NEVER shrinks the file,
// so without an explicit VACUUM a user who removes a 180MB board sees the app still
// occupying its old size in the OS storage screen — for a feature called "manage
// storage", that's the whole point missed.
//
// This is separate from the teardown on purpose: the teardown transaction commits
// independently, so a VACUUM failure can never roll it back. Teardown is
// correctness; VACUUM is cosmetics. Callers should treat a failure as "the data is
// gone but the file didn't shrink", never as data loss.
//
// Why not PRAGMA auto_vacuum: it can only be set BEFORE any table exists, and
// initializeDatabase runs ensureMutationQueueTable + runMigrations (whose first
// statement creates schema_version) on every launch, so every device in the field is
// long past that window. Setting it retroactively is a silent no-op until a full
// VACUUM runs — i.e. it costs the exact operation it was meant to avoid — and would
// only ever apply to fresh installs, splitting the fleet so that long-time users
// (the ones with the big databases) are precisely who it never helps. It also isn't
// free: pointer-map pages tax the snapshot bulk-import path on every download,
// forever, and INCREMENTAL still needs an explicit `PRAGMA incremental_vacuum(N)`.

import type { OfflineDatabase } from '../database';
import { classifySqliteLockError } from './lock-errors';

/**
 * Tries at the post-VACUUM WAL truncation before settling for "the file may not
 * have shrunk". The blocker is a live reader that finishes in milliseconds — a
 * board row re-reading `downloadedScopeKeys`, a search query, the sync engine's
 * own next statement — so a couple of short waits usually turn a `false` into a
 * `true` and the user's storage figure actually moves.
 */
const CHECKPOINT_ATTEMPTS = 3;

/** Base gap between truncation tries; multiplied by the attempt number. */
const CHECKPOINT_RETRY_DELAY_MS = 120;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Test seams for the truncation retry loop; every field is optional. */
export type VacuumOptions = {
  /** How many times to try `wal_checkpoint(TRUNCATE)`. Default CHECKPOINT_ATTEMPTS. */
  checkpointAttempts?: number;
  /** Injected sleep so a test does not pay the real backoff. */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Hand the WAL back to the filesystem after a VACUUM, reporting whether it
 * actually happened.
 *
 * SQLite says "I could not truncate" in TWO different shapes, and only one of
 * them used to be handled:
 *
 *  - `busy = 1` in the returned row — ANOTHER connection held a read lock.
 *  - a THROW carrying SQLITE_LOCKED (6) / SQLITE_BUSY (5) — most often because
 *    THIS connection has an open transaction. `sqlite3BtreeCheckpoint()` returns
 *    SQLITE_LOCKED outright when `pBt->inTransaction != TRANS_NONE`, and on the
 *    app's main connection that is true for as long as any other statement is in
 *    flight on the same handle. The offline database has exactly that shape: the
 *    engine, every `useSQLiteContext()` screen, and this call all share one
 *    connection, so removing a board while My Boards re-reads its rows raced
 *    straight into it (Sentry BOARDSESH-D7, "Error code 6: database table is
 *    locked", reported against `finalizeAsync` because expo-sqlite's
 *    `getFirstAsync` re-throws the same code from its `finally`).
 *
 * Both mean the same thing to the user — the rows are gone, the file may not
 * have shrunk — so both now resolve `false` instead of one of them escaping as
 * an exception. Anything that is NOT lock contention still throws: a genuinely
 * broken database must not be reported as a cosmetic miss.
 */
async function truncateWal(db: OfflineDatabase, options: VacuumOptions | undefined): Promise<boolean> {
  const attempts = Math.max(1, options?.checkpointAttempts ?? CHECKPOINT_ATTEMPTS);
  const sleep = options?.sleep ?? wait;

  for (let attempt = 1; ; attempt += 1) {
    try {
      // The pragma returns (busy, log, checkpointed). A non-WAL database returns
      // no row at all; nothing was blocked, so that is a success.
      const checkpoint = await db.getFirstAsync<{ busy: number }>('PRAGMA wal_checkpoint(TRUNCATE)');
      if ((checkpoint?.busy ?? 0) === 0) return true;
    } catch (error) {
      if (!classifySqliteLockError(error).locked) throw error;
    }
    if (attempt >= attempts) return false;
    await sleep(CHECKPOINT_RETRY_DELAY_MS * attempt);
  }
}

/**
 * Bytes SQLite would hand back to the filesystem if `vacuumDatabase` ran now — the
 * honest "compacting frees about X" figure. Both pragmas are O(1) header reads.
 */
export async function measureReclaimableBytes(db: OfflineDatabase): Promise<number> {
  const pageSize = await db.getFirstAsync<{ page_size: number }>('PRAGMA page_size');
  const freelist = await db.getFirstAsync<{ freelist_count: number }>('PRAGMA freelist_count');
  return (pageSize?.page_size ?? 0) * (freelist?.freelist_count ?? 0);
}

/**
 * Rebuild the database file, returning freelist pages to the filesystem. Resolves
 * false when the rebuild landed but the WAL truncation was blocked (see
 * `truncateWal`) — the data is still gone, the file just may not have shrunk as far
 * as it should. It never throws for lock contention; only a genuinely broken
 * database escapes.
 *
 * MUST NOT run inside a transaction — SQLite rejects it outright, and note that
 * `withExclusiveTransactionAsync` opens a deferred BEGIN before its task body runs,
 * so this belongs on the main connection, never inside that wrapper (the same trap
 * snapshot-bootstrap.ts's CONNECTION INVARIANT comment describes for ATTACH).
 *
 * MUST NOT run concurrently with a sync cycle. A snapshot import that meets this
 * exclusive lock raises SQLITE_BUSY past the 5s busy_timeout, which
 * bootstrap-retry classifies as a structural failure — two of those and the scope
 * is stranded on the paged crawl for a lock we took ourselves. Callers get this
 * right in one of two ways (see compactOfflineDatabase in
 * packages/mobile/src/offline/remove-offline-board.ts):
 *  - DEFER while `isSyncInFlight()`, for the automatic post-removal compaction,
 *    which must not abort the downloads a board removal deliberately spared; or
 *  - bump the GLOBAL epoch (`beginGlobalPurge`) first, for the deliberate,
 *    spinner-backed manual Compact, so in-flight pulls bail cleanly (no burned
 *    attempt, resumed from checkpoints next cycle).
 *
 * Costs, for callers deciding how to present this: it builds a complete new file
 * before swapping, so peak disk is roughly original + final (SQLite documents up to
 * ~2x transiently) — which fails exactly for the user who has no space, i.e. the one
 * who came here to make some. Precheck free space. It also holds an exclusive lock
 * for the whole rebuild, order 5-20s on a 200-400MB database, so it needs a blocking
 * foreground state, never a timer or a launch hook.
 *
 * Atomic: it either completes or leaves the original byte-identical, so a failure
 * (SQLITE_FULL, SQLITE_BUSY, app killed) still leaves a valid database with the rows
 * deleted and the space merely still on the freelist.
 */
export async function vacuumDatabase(db: OfflineDatabase, options?: VacuumOptions): Promise<boolean> {
  await db.execAsync('VACUUM');
  // In WAL mode VACUUM writes the whole rebuilt database through the WAL, leaving a
  // -wal file at roughly the database's size — which would eat the reclaimed bytes
  // straight back, since the user's storage figure counts the sidecars. TRUNCATE (not
  // PASSIVE/FULL) is the checkpoint mode that actually shrinks the -wal file.
  //
  // Blocked truncation is reported, never thrown — the rows are gone either way and
  // the next checkpoint truncates. See truncateWal for the two shapes SQLite uses to
  // say "blocked" and why only reporting one of them was a bug.
  return truncateWal(db, options);
}
