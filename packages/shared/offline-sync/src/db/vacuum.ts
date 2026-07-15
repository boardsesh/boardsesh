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
 * false when the rebuild landed but the WAL truncation was blocked (see below) — the
 * data is still gone, the file just may not have shrunk as far as it should.
 *
 * MUST NOT run inside a transaction — SQLite rejects it outright, and note that
 * `withExclusiveTransactionAsync` opens a deferred BEGIN before its task body runs,
 * so this belongs on the main connection, never inside that wrapper (the same trap
 * snapshot-bootstrap.ts's CONNECTION INVARIANT comment describes for ATTACH).
 *
 * MUST NOT run concurrently with a sync cycle — callers bump the wipe epoch
 * (beginLocalPurge) first so in-flight pulls bail.
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
export async function vacuumDatabase(db: OfflineDatabase): Promise<boolean> {
  await db.execAsync('VACUUM');
  // In WAL mode VACUUM writes the whole rebuilt database through the WAL, leaving a
  // -wal file at roughly the database's size — which would eat the reclaimed bytes
  // straight back, since the user's storage figure counts the sidecars. TRUNCATE (not
  // PASSIVE/FULL) is the checkpoint mode that actually shrinks the -wal file.
  //
  // The pragma returns (busy, log, checkpointed) and does NOT throw when it can't
  // finish: `busy = 1` means a reader held it off, the -wal stayed large, and the
  // user's storage figure won't have improved despite a clean VACUUM. Silent, so
  // report it rather than claiming success. Not fatal either way — the rows are gone
  // and the next checkpoint truncates.
  const checkpoint = await db.getFirstAsync<{ busy: number }>('PRAGMA wal_checkpoint(TRUNCATE)');
  // A non-WAL database returns no row; nothing was blocked, so that's a success.
  return (checkpoint?.busy ?? 0) === 0;
}
