// Database lifecycle + a module-level handle so non-React code (sync scheduler,
// mutation drainer triggered from listeners) can reach the open connection.
//
// The actual `SQLiteProvider` wiring lives elsewhere; this module only exposes
// `initializeDatabase`, which `SQLiteProvider`'s `onInit` calls, plus the handle
// accessors.

import type { SQLiteDatabase } from 'expo-sqlite';
import { ensureMutationQueueTable } from '../mutation-queue/schema';
import { runMigrations } from './migrations';
import { deleteAllCheckpoints, setCheckpoint, getCheckpointKey } from '../sync/checkpoints';
import { BOARD_DATA_TABLES } from '../sync/table-config';
import { resolveSeedAssetModuleId } from './seed-asset';

export const DATABASE_NAME = 'boardsesh.db';

// Board reference tables a bundled seed DB may pre-populate. Kept narrow: the
// seed only ships the expensive shared cache (climbs + stats), never anyone's
// user data.
const SEEDABLE_BOARD_TABLES = BOARD_DATA_TABLES;

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

async function isTableEmpty(db: SQLiteDatabase, tableName: string): Promise<boolean> {
  // EXISTS(SELECT 1 … LIMIT 1) stops at the first row, so this stays O(1) even on
  // the 200k–1M-row board tables.
  const row = await db.getFirstAsync<{ has_rows: number }>(
    `SELECT EXISTS(SELECT 1 FROM ${tableName} LIMIT 1) AS has_rows`,
  );
  return (row?.has_rows ?? 0) === 0;
}

/**
 * Best-effort, fully optional: if the build bundled a pre-warmed board database
 * (see seed-asset.ts) and the local board tables are still empty, copy the seed's
 * board reference rows in so the app can browse boards offline from first launch.
 *
 * Runs AFTER migrations (so the destination tables exist and match the current
 * schema) and only when the tables are empty, so it never clobbers data a sync has
 * already pulled, and re-running it on a later launch is a no-op. Uses SQLite
 * ATTACH rather than a file swap because SQLiteProvider has already opened the
 * live handle by the time onInit runs — a pre-open file copy is no longer possible.
 * ATTACH/DETACH run outside the transaction (SQLite forbids ATTACH inside one); the
 * row copy + checkpoint stamping run inside it so the seed lands all-or-nothing.
 *
 * Any failure (no asset, unreadable asset, schema drift) is swallowed: the seed is
 * a head-start, never a requirement, and the per-board sync still fills the tables.
 */
async function loadOptionalSeed(db: SQLiteDatabase): Promise<void> {
  const seedModuleId = resolveSeedAssetModuleId();
  if (seedModuleId === null) {
    // Default build: no bundled seed. Nothing to do — the app runs online-only
    // until the user opts a board into offline sync.
    return;
  }

  // Skip the (cheap) emptiness probe + asset download entirely once any board
  // table already holds rows — a prior seed or sync has run.
  const emptiness = await Promise.all(SEEDABLE_BOARD_TABLES.map((table) => isTableEmpty(db, table)));
  if (!emptiness.some(Boolean)) return;

  // Materialise the bundled asset to a readable file path. expo-asset is imported
  // lazily so the default (no-seed) path never pulls it into a hot launch.
  const { Asset } = await import('expo-asset');
  const asset = Asset.fromModule(seedModuleId);
  await asset.downloadAsync();
  const seedPath = asset.localUri;
  if (!seedPath) return;

  // ATTACH cannot run inside a transaction, so it brackets the copy explicitly.
  await db.execAsync(`ATTACH DATABASE '${seedPath.replace(/'/g, "''")}' AS seed`);
  try {
    await db.withExclusiveTransactionAsync(async (txn) => {
      for (const table of SEEDABLE_BOARD_TABLES) {
        // Transaction extends SQLiteDatabase, so the txn reuses the helpers above.
        if (!(await isTableEmpty(txn, table))) continue;
        await txn.execAsync(`INSERT OR IGNORE INTO ${table} SELECT * FROM seed.${table}`);
      }

      // If the seed carries the sync cursor it was built at, stamp it as each
      // board's checkpoint so the next pull resumes from the seed's build point
      // instead of re-crawling the whole board from empty. Optional: a seed
      // without this table just means the first sync starts from zero.
      const seedCursors = await txn
        .getAllAsync<{ board_type: string; table_name: string; updated_at: string; sync_seq: string }>(
          `SELECT board_type, table_name, updated_at, sync_seq FROM seed.seed_checkpoints`,
        )
        .catch(() => []);
      for (const cursor of seedCursors) {
        if (!SEEDABLE_BOARD_TABLES.includes(cursor.table_name)) continue;
        await setCheckpoint(txn, getCheckpointKey(cursor.table_name, cursor.board_type), {
          updatedAt: cursor.updated_at,
          syncSeq: cursor.sync_seq,
        });
      }
    });
  } finally {
    await db.execAsync('DETACH DATABASE seed');
  }

  if (__DEV__) {
    console.warn('[SQLite] seeded board reference data from bundled asset');
  }
}

/**
 * Prepares an opened database for use: ensures the mutation queue table exists,
 * runs pending schema migrations, optionally seeds board reference data from a
 * bundled asset, and publishes the handle for non-React callers. Intended as the
 * `SQLiteProvider` `onInit` callback. Idempotent — safe on every launch and after
 * a hot reload.
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
    // Seed is wrapped in its own guard so a bad/absent asset never blocks the
    // handle from publishing — the queue + migrations are what offline writes need.
    try {
      await loadOptionalSeed(db);
    } catch (seedError) {
      if (__DEV__) {
        console.warn('[SQLite] optional seed import failed; continuing without it:', seedError);
      }
    }
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
