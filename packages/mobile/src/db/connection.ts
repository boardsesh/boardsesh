// Database lifecycle + a module-level handle so non-React code (sync scheduler,
// mutation drainer triggered from listeners) can reach the open connection.
//
// The actual `SQLiteProvider` wiring lives elsewhere; this module only exposes
// `initializeDatabase`, which `SQLiteProvider`'s `onInit` calls, plus the handle
// accessors.

import type { SQLiteDatabase } from 'expo-sqlite';
import {
  ensureMutationQueueTable,
  runMigrations,
  deleteUserCheckpoints,
  applyBusyTimeout,
  configureMainConnection,
} from '@boardsesh/offline-sync';
import { reportError } from '../lib/error-reporting';

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
 * How many times the whole setup sequence is attempted before giving up, and the
 * hard wall-clock ceiling across all of them.
 *
 * Sized against the longest writer that can legitimately hold the file while the app
 * starts: `vacuumDatabase` documents an exclusive lock of 5-20s on a 200-400MB
 * database, and a snapshot import is the same order. 30s therefore outlasts a genuine
 * one, while anything still locked past it is wedged rather than busy — further
 * retries would only burn battery on a launch that has already fallen back to
 * network-only. The delays are the gaps BETWEEN attempts; the deadline is checked
 * before each sleep so a slow attempt cannot overrun the window.
 */
const MAX_INIT_ATTEMPTS = 5;
const MAX_INIT_WINDOW_MS = 30_000;
// Exported so the retry tests advance their fake clock by the real gap rather than
// mirroring these numbers in a literal that silently drifts from them.
export const INIT_RETRY_DELAYS_MS = [500, 2_000, 5_000, 10_000];

/**
 * Single-flight guard spanning the ENTIRE init lifecycle, background retries
 * included. `SQLiteProvider`'s effect has no re-entrancy guard of its own — a remount
 * while `onInit` is still in flight leaves the first connection unclosed and starts a
 * second setup — so without this, two remounts during a contended init would run two
 * retry chains and two migration transactions against one file, which is the very
 * contention being fixed.
 */
let activeInitialization: Promise<void> | null = null;

/**
 * Which step of the setup sequence failed. Tagged on the Sentry report so the next
 * triage can tell a refused WAL switch from a locked migration — #4104 could not,
 * because all three steps shared a single catch.
 */
type InitPhase = 'wal' | 'queue-table' | 'migrations';

type InitOutcome = { status: 'ready' } | { status: 'failed'; phase: InitPhase; error: unknown; retryable: boolean };

/**
 * A lock contention (SQLITE_BUSY code 5 / SQLITE_LOCKED code 6) — transient by
 * definition, so worth retrying. Anything else (a full disk, a corrupt file, missing
 * permissions) would fail identically forever, so it is reported at once instead.
 */
function isDatabaseLockedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /database (?:table )?is locked/i.test(message);
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

/**
 * Prepares an opened database for use: ensures the mutation queue table exists,
 * runs pending schema migrations, and publishes the handle for non-React callers.
 * Intended as the `SQLiteProvider` `onInit` callback. Idempotent — safe on every
 * launch and after a hot reload.
 *
 * Never rejects: `SQLiteProvider` leaves the app stuck rendering null if its `onInit`
 * promise rejects (loading stays true even when `onError` is supplied), which would
 * white-screen the whole app over non-essential offline storage.
 *
 * The setup DDL needs SQLite's single write lock, so a long writer already holding the
 * file at launch — a `VACUUM`, a snapshot import, a scope teardown still draining from
 * before a remount or OTA reload — makes it fail. That used to disable offline storage
 * for the entire session on one transient collision (#4104); it now retries in the
 * background within a bounded window and publishes the handle as soon as one attempt
 * wins. Concurrent callers share one lifecycle (see `activeInitialization`).
 *
 * Board reference data is filled in on demand by the per-scope download (nightly
 * CDN snapshot, then paged deltas — see docs/board-snapshots.md). The old bundled
 * seed-database import that used to run here was retired in #3646: it never had a
 * producer, and the snapshot bootstrap covers the same head start per (board,
 * layout, size) scope.
 */
export function initializeDatabase(db: SQLiteDatabase): Promise<void> {
  activeInitialization ??= beginInitialization(db);
  return activeInitialization;
}

/**
 * Runs the setup sequence once. Never throws — the caller decides whether the
 * failure is worth another attempt.
 */
async function attemptInitialization(db: SQLiteDatabase): Promise<InitOutcome> {
  let phase: InitPhase = 'wal';
  try {
    // WAL (persists on the file, so every later connection inherits it) + busy_timeout
    // on the main connection. Runs first, in autocommit: journal_mode can't change
    // inside a transaction, and ensureMutationQueueTable/runMigrations open one.
    // Does not throw on a refused WAL switch — see configureMainConnection.
    await configureMainConnection(db);
    phase = 'queue-table';
    await ensureMutationQueueTable(db);
    phase = 'migrations';
    await runMigrations(db);
    // Published only once the schema is actually in place: a handle whose migrations
    // never ran would hand every consumer a database with no tables.
    setDatabaseHandle(db);
    return { status: 'ready' };
  } catch (error) {
    return { status: 'failed', phase, error, retryable: isDatabaseLockedError(error) };
  }
}

/**
 * Drives the attempt sequence, resolving the returned promise as soon as the FIRST
 * attempt settles so app launch never waits on a retry — `SQLiteProvider` renders
 * nothing until `onInit` resolves, so blocking here is a black screen. Retries
 * continue detached and publish the handle the moment one wins; every consumer of
 * `getDatabaseHandle()` already null-checks and falls back to the network, so a late
 * handle degrades exactly like the old permanent failure did, then recovers.
 */
function beginInitialization(db: SQLiteDatabase): Promise<void> {
  let releaseLaunch: () => void = () => {};
  const launchGate = new Promise<void>((resolve) => {
    releaseLaunch = resolve;
  });

  void (async () => {
    const deadline = Date.now() + MAX_INIT_WINDOW_MS;

    for (let attempt = 1; attempt <= MAX_INIT_ATTEMPTS; attempt += 1) {
      const outcome = await attemptInitialization(db);

      // Unblock the provider once, whatever the first attempt did.
      if (attempt === 1) {
        releaseLaunch();
      }

      if (outcome.status === 'ready') {
        return;
      }

      const retryDelayMs = INIT_RETRY_DELAYS_MS[attempt - 1];
      const outOfRoad =
        !outcome.retryable ||
        attempt === MAX_INIT_ATTEMPTS ||
        retryDelayMs === undefined ||
        Date.now() + retryDelayMs >= deadline;

      if (outOfRoad) {
        if (__DEV__) {
          console.warn(
            `[SQLite] initializeDatabase failed in phase "${outcome.phase}" after ${attempt} attempt(s); ` +
              'offline storage disabled this session:',
            outcome.error,
          );
        }
        // In production a silent null handle just switches every offline feature off
        // with no trace — report it so a spike is diagnosable from telemetry. Only the
        // final attempt reports, so a retried-and-recovered launch stays quiet.
        reportError(outcome.error, {
          tags: { source: 'offline-sync', kind: 'sqlite-init', phase: outcome.phase },
          extra: { attempts: attempt, retryable: outcome.retryable },
        });
        // Let a genuinely new mount try again rather than staying dead for the process.
        activeInitialization = null;
        return;
      }

      await delay(retryDelayMs);
    }
  })();

  return launchGate;
}

/**
 * Test-only: drops the single-flight guard so each test can drive a fresh
 * initialization. Production has exactly one database for the process lifetime.
 *
 * It is defined here because the guard's state is module-local, but the sanctioned
 * import path is `./testing`; neither this name nor that module may be reached from
 * application code, which `connection-test-seam.test.ts` enforces.
 */
export function resetDatabaseInitializationForTests(): void {
  activeInitialization = null;
}

/**
 * Wipes the current user's local data on sign-out (account lifecycle, I11).
 * Runs every delete plus the checkpoint reset inside one transaction so the
 * device is left in a clean, internally-consistent state for the next account:
 * either everything is cleared or nothing is.
 *
 * Board reference data is intentionally left in place (see
 * USER_DATA_TABLES_TO_CLEAR), and so are the board download checkpoints — the rows
 * survive as the shared cache, so re-crawling them from epoch on the next sign-in
 * would be wasteful. Only the user-scoped checkpoints (user tables + deletions) are
 * reset. Any pending mutations that had not yet reached the server are discarded
 * here along with their local rows — sign-out is an explicit "this account is done
 * on this device" signal, so dropping unsynced writes is the documented behaviour
 * rather than a data-loss bug.
 */
export async function clearUserData(db: SQLiteDatabase): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    // Sign-out teardown runs on its own connection concurrently with in-flight sync
    // reads/writes; wait for the lock instead of failing instantly (BOARDSESH-A9).
    await applyBusyTimeout(txn);
    for (const table of USER_DATA_TABLES_TO_CLEAR) {
      await txn.runAsync(`DELETE FROM ${table}`);
    }
    await deleteUserCheckpoints(txn);
  });
}
