// Database lifecycle + a module-level handle so non-React code (sync scheduler,
// mutation drainer triggered from listeners) can reach the open connection.
//
// The actual `SQLiteProvider` wiring lives elsewhere; this module only exposes
// `initializeDatabase`, which `SQLiteProvider`'s `onInit` calls, plus the handle
// accessors.

import type { SQLiteDatabase } from 'expo-sqlite';
import { ensureMutationQueueTable } from '../mutation-queue/schema';
import { runMigrations } from './migrations';
import { deleteAllCheckpoints } from '../sync/checkpoints';

export const DATABASE_NAME = 'boardsesh.db';

// Tables that hold the signed-in user's own data. Cleared on sign-out so the
// next account on the device never sees the previous user's ticks, playlists,
// follows, or not-yet-synced writes. Board reference data (board_climbs,
// board_climb_stats) is deliberately excluded — it is the expensive shared
// cache and is identical regardless of who is logged in.
const USER_DATA_TABLES_TO_CLEAR = [
  'boardsesh_ticks',
  'playlists',
  'playlist_climbs',
  'user_favorites',
  'user_follows',
  'setter_follows',
  'playlist_follows',
  'pending_mutations',
] as const;

let databaseHandle: SQLiteDatabase | null = null;

export function setDatabaseHandle(db: SQLiteDatabase | null): void {
  databaseHandle = db;
}

export function getDatabaseHandle(): SQLiteDatabase | null {
  return databaseHandle;
}

/**
 * Prepares an opened database for use: ensures the mutation queue table exists,
 * runs pending schema migrations, and publishes the handle for non-React callers.
 * Intended as the `SQLiteProvider` `onInit` callback. Idempotent — safe on every
 * launch and after a hot reload.
 */
export async function initializeDatabase(db: SQLiteDatabase): Promise<void> {
  // Never reject: SQLiteProvider leaves the app stuck rendering null if its
  // onInit promise rejects (loading stays true even when onError is supplied),
  // which would white-screen the whole app over non-essential offline storage.
  // On failure we log (dev) and leave the handle unpublished, so getDatabaseHandle()
  // returns null and offline reads/writes degrade to no-ops instead of crashing.
  try {
    await ensureMutationQueueTable(db);
    await runMigrations(db);
    setDatabaseHandle(db);
  } catch (error) {
    if (__DEV__) {
      console.warn('[SQLite] initializeDatabase failed; offline storage disabled this session:', error);
    }
  }
}

/**
 * Wipes the current user's local data on sign-out (account lifecycle, I11).
 * Runs every delete plus the checkpoint reset inside one transaction so the
 * device is left in a clean, internally-consistent state for the next account:
 * either everything is cleared or nothing is.
 *
 * Board reference data is intentionally left in place (see
 * USER_DATA_TABLES_TO_CLEAR). Any pending mutations that had not yet reached the
 * server are discarded here along with their local rows — sign-out is an
 * explicit "this account is done on this device" signal, so dropping unsynced
 * writes is the documented behaviour rather than a data-loss bug.
 */
export async function clearUserData(db: SQLiteDatabase): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    for (const table of USER_DATA_TABLES_TO_CLEAR) {
      await txn.runAsync(`DELETE FROM ${table}`);
    }
    await deleteAllCheckpoints(txn);
  });
}
