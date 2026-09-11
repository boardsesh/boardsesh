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
  deleteAllSyncMeta,
  applyBusyTimeout,
  beginImmediateWrite,
  classifySqliteLockError,
  OFFLINE_DB_BUSY_TIMEOUT_MS,
  configureMainConnection,
  vacuumDatabase,
  BOARD_DATA_TABLES,
  getUnfinishedDownloadScopeKeys,
  claimAbandonedDownloadTerminal,
  purgeNamespaceForScopeKey,
} from '@boardsesh/offline-sync';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { reportError } from '../lib/error-reporting';
import { track } from '../lib/analytics';
import { setSchemaReady } from './schema-ready';
import { pinDatabase } from './connection-pin';
import { markStartup } from '../lib/profiling/startup-profile';
import { measureDatabaseBytes } from './storage-usage';

// Defined in its own leaf module so `connection-pin.ts` can read it without an
// import cycle back through this file. Re-exported here so every existing import
// site keeps working.
export { DATABASE_NAME } from './database-name';

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
  // The handle is only ever published once migrations have run, so it doubles as
  // the schema-readiness signal for the `useSQLiteContext()` consumers that can't
  // see this handle at all. Driving the store from here — rather than letting
  // callers poke it — keeps the two from ever disagreeing.
  setSchemaReady(db !== null);
}

export function getDatabaseHandle(): SQLiteDatabase | null {
  return databaseHandle;
}

/**
 * Retracts the published handle when the connection behind it is being closed.
 *
 * `SQLiteProvider`'s effect teardown calls `db.closeAsync()`, and until #5292 nothing
 * told this module about it: `getDatabaseHandle()` kept serving the closed connection
 * and every local read threw `Access to closed resource` (~249 users/30d). Called from
 * the provider's own teardown so the handle goes null BEFORE the close lands, rather
 * than leaving a window where a non-React reader (sync scheduler, mutation drainer)
 * picks up a dead connection.
 *
 * Identity-checked: an effect cleanup can run after a newer connection has already
 * published itself, and retracting unconditionally would switch offline storage off
 * for a database that is perfectly alive.
 */
export function releaseDatabaseHandle(db: SQLiteDatabase): void {
  if (databaseHandle === db) setDatabaseHandle(null);
}

/**
 * The gaps BETWEEN attempts, in two phases. Exported so the retry tests advance their
 * fake clock by the real gap rather than mirroring these numbers in a literal that
 * silently drifts from them.
 *
 * FAST (#4104) — sized for a writer that is merely in the way: a tick commit, a
 * checkpoint stamp, one `SNAPSHOT_IMPORT_BATCH_ROWS` import batch. Almost every
 * contended launch is won here, and the whole ladder fits in 17.5s.
 */
export const INIT_RETRY_DELAYS_MS = [500, 2_000, 5_000, 10_000];

/**
 * SLOW (#4314) — the gaps that follow, reached ONLY by lock contention.
 *
 * The fast ladder stops at 17.5s of gaps, so the chain used to give up around 30s.
 * That was sized against `vacuumDatabase`'s documented 5-20s exclusive lock, but the
 * writer that actually loses this window in the field is a board-data snapshot
 * import: `Offline Board Download Completed.importMs` runs to 253,939ms at the top of
 * the 30-day distribution, an order of magnitude past the old ceiling. Every
 * phase-tagged `kind: 'sqlite-init'` report on 2.4.0 has the same shape —
 * `retryable: true`, `attempts: 4`, `elapsedMs: 29,875` — i.e. the chain spent its
 * entire window waiting out a real lock and then walked away.
 *
 * Walking away was permanent. `SQLiteProvider` calls `onInit` exactly once per
 * connection, so once the chain returned there was nothing left to try again: the
 * handle stayed null and offline storage was off for the REST OF THE SESSION, over a
 * database that became writable a minute or two later. These four gaps carry the
 * chain to ~227.5s of waiting (~272s with every attempt blocking its full
 * `busy_timeout`), which covers that 253,939ms tail.
 *
 * It costs a healthy launch nothing. Only a failure `classifySqliteLockError` calls
 * contention gets here — a full disk or a corrupt file still ends the chain on
 * attempt 1 — and a blocked attempt is an idle await, not a spin.
 */
export const INIT_LOCK_RETRY_DELAYS_MS = [30_000, 60_000, 60_000, 60_000];

const INIT_ALL_RETRY_DELAYS_MS = [...INIT_RETRY_DELAYS_MS, ...INIT_LOCK_RETRY_DELAYS_MS];

/**
 * How many times the whole setup sequence is attempted before giving up, and the hard
 * wall-clock ceiling across all of them.
 *
 * The attempt count is derived from the ladder so the two can never disagree. The
 * ceiling is the backstop for an attempt that is itself slow — every gap plus a full
 * `busy_timeout` on all nine attempts still lands inside it — so the ladder, not the
 * clock, is what normally ends the chain. It is checked before each sleep, so a slow
 * attempt cannot overrun the window.
 */
const MAX_INIT_ATTEMPTS = INIT_ALL_RETRY_DELAYS_MS.length + 1;
const MAX_INIT_WINDOW_MS = 360_000;
/**
 * How many times a superseded attempt may be refunded (see the restart branch in
 * `beginInitialization`). Each refund needs its own remount — the retry immediately
 * retargets onto the connection that superseded it — so this only exists to stop a
 * pathological remount loop from keeping one chain alive forever. Hitting it ends the
 * chain with nothing published and a Sentry report (see `reportSupersededExhaustion`),
 * not with the superseded connection presented as ready.
 */
const MAX_SUPERSEDED_RESTARTS = 3;

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
 * The most recent database `SQLiteProvider` handed us, which is not necessarily the
 * one the in-flight chain started with.
 *
 * `SQLiteProvider`'s effect teardown calls `db.closeAsync()` (expo-sqlite
 * `build/hooks.js`), so a remount mid-chain CLOSES the connection the chain captured
 * and opens a new one. The single-flight guard above means the remount just gets the
 * existing promise back — so without this, every remaining retry hammers a closed
 * handle, throws "database is closed" (not a lock error, therefore classified
 * non-retryable), and reports a lifecycle artefact to Sentry under
 * `kind: 'sqlite-init'` — polluting the exact aggregate #4314 reads to decide
 * whether the lock problem is fixed. Each attempt reads this instead, so one chain
 * follows the LIVE connection.
 */
let latestDatabase: SQLiteDatabase | null = null;

/**
 * Exit protocol for the init chain: whatever is published when a chain stops must be
 * a connection `SQLiteProvider` still owns.
 *
 * The single gated publish in `beginInitialization` is what makes this hold, so today
 * this never has anything to retract. It is called at every terminal `return` anyway
 * because the failure it backstops is silent and expensive: a superseded handle reads
 * as `isSchemaReady() === true` while every query throws `Access to closed resource`,
 * and the chain that left it there has already dropped `activeInitialization`, so
 * nothing retries until the next remount (#5366). A second publish site added later —
 * the retry ladder and its wake path are both being retuned (#4314) — would be caught
 * here instead of shipping as #5292 for a third time.
 */
function retractSupersededHandle(): void {
  if (databaseHandle !== null && latestDatabase !== null && databaseHandle !== latestDatabase) {
    setDatabaseHandle(null);
  }
}

/**
 * At most one recovery event per process. A launch can only recover once, but the
 * chain can restart after an exhausted window (`activeInitialization` is cleared),
 * and one launch must not emit two.
 */
let hasReportedRecovery = false;

/**
 * Which step of the setup sequence failed. Tagged on the Sentry report so the next
 * triage can tell a refused WAL switch from a locked migration — #4104 could not,
 * because all three steps shared a single catch.
 */
type InitPhase = 'wal' | 'queue-table' | 'migrations';

type InitOutcome =
  | { status: 'ready' }
  | { status: 'failed'; phase: InitPhase; error: unknown; retryable: boolean; sqliteCode: number | null };

// Retryability comes from `classifySqliteLockError` (@boardsesh/offline-sync,
// db/lock-errors.ts): a lock contention (SQLITE_BUSY 5 / SQLITE_LOCKED 6) is
// transient by definition and worth another attempt, while anything else — a full
// disk, a corrupt file, missing permissions — would fail identically forever and is
// reported at once. The matching lives there rather than here because the message
// shapes differ per platform and are only knowable from telemetry, so they need a
// test pinning the literal strings Sentry carries.

/**
 * Ends the backoff the chain is currently parked in. Non-null ONLY while a sleep is in
 * flight — `sleepUntilRetry` sets it as it parks and clears it on the way out, so a
 * wake that arrives during an attempt finds nothing to do and cannot make the loop
 * run that attempt twice. At most one sleeper exists: `activeInitialization`
 * single-flights the chain, and every path that clears it has already returned.
 */
let wakeFromBackoff: (() => void) | null = null;

/**
 * The gap between two attempts, endable early.
 *
 * The slow #4314 gaps run to a minute, and a `SQLiteProvider` remount arriving inside
 * one used to be invisible to the chain: `initializeDatabase` moves `latestDatabase`
 * and hands the remount the already-resolved launch gate, so the replacement provider
 * renders with a null handle and `schemaReady` false until the sleep runs out — over a
 * fresh connection that would work right now. The wake exists so that lands on the
 * NEXT loop iteration instead, which reads `latestDatabase` and retargets through the
 * path that already exists rather than a second one.
 *
 * It shortens a wait; it does not buy an attempt. The budget slot was already spent
 * before the sleep and `supersededRestarts` is untouched, so a remount loop cannot
 * keep one chain alive past `MAX_INIT_ATTEMPTS`.
 */
function sleepUntilRetry(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    // Both exits null the slot, so "set" and "parked" are the same state. That is what
    // makes the no-double-run property above STRUCTURAL rather than accidental: there
    // is no window where a wake could reach a chain that is mid-attempt.
    //
    // A left-behind resolver would in fact be inert — it closes over its own timer and
    // its own promise, both already settled by the time it could be called again, and
    // the next sleep overwrites the slot regardless. Mutation-tested: dropping either
    // assignment changes no observable behaviour. They are kept because the invariant,
    // not the assignment, is the thing this function's callers rely on.
    const timer = setTimeout(() => {
      wakeFromBackoff = null;
      resolve();
    }, durationMs);

    wakeFromBackoff = () => {
      clearTimeout(timer);
      wakeFromBackoff = null;
      resolve();
    };
  });
}

/**
 * Best-effort read of the file's journal mode for the failure report.
 *
 * Tagged because one untested hypothesis for a device that fails at launch forever
 * is that it never made it out of rollback-journal mode (the WAL switch is
 * one-shot, and `configureMainConnection` steps over a refused one). By definition
 * this runs against a contended database, so the read can fail too — the explicit
 * `'unavailable'` sentinel keeps "stuck in rollback journal" distinguishable from
 * "we couldn't tell", instead of the tag silently vanishing.
 */
async function readJournalMode(db: SQLiteDatabase): Promise<string> {
  try {
    const row = await db.getFirstAsync<{ journal_mode: string }>('PRAGMA journal_mode');
    return row?.journal_mode ?? 'unavailable';
  } catch {
    return 'unavailable';
  }
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
  const replacesTheOneInFlight = latestDatabase !== null && latestDatabase !== db;
  // Reassigning `latestDatabase` below is what makes the PREVIOUS wrapper collectable,
  // and on Android collecting any wrapper for this file frees the native handle the
  // live connection is still using (#5410). The outgoing one was pinned by its own
  // call to this function, so only the incoming one needs pinning here.
  //
  // Deliberately overlapping with the two pins in `database-provider.tsx`: today
  // `onInit` is this function's only caller, so removing any ONE of the three leaves
  // every wrapper pinned and the suite green. That redundancy is the point — this is
  // the module that owns the overwrite hazard, and `initializeDatabase` is a public
  // export, so a second caller must not have to remember the provider's pin.
  pinDatabase(db);
  // Recorded on EVERY call, including the remount that only gets the shared promise
  // back, so the in-flight chain can retarget onto the live connection.
  latestDatabase = db;
  // A second connection arriving means `SQLiteProvider` has torn the previous one
  // down — its teardown closes it (expo-sqlite `build/hooks.js`), and the close can
  // land before or after this call. Retract synchronously, before the first await, so
  // from the instant `onInit` runs for the new connection no reader can be handed the
  // old one (#5292). The chain below republishes once the new connection's migrations
  // are in place.
  if (databaseHandle !== null && databaseHandle !== db) setDatabaseHandle(null);
  // Whatever lock the chain is sitting out belongs to a connection that no longer
  // exists, so the rest of the gap buys nothing — and at the slow #4314 gaps it costs
  // this mount up to a minute of null handle. End the sleep and let the loop retarget.
  // A no-op unless the chain is actually parked (see `wakeFromBackoff`).
  if (replacesTheOneInFlight) wakeFromBackoff?.();
  activeInitialization ??= beginInitialization(db);
  return activeInitialization;
}

/**
 * Runs the setup sequence once. Never throws — the caller decides whether the
 * failure is worth another attempt.
 *
 * Deliberately does NOT publish the handle. It cannot tell whether the connection it
 * just prepared is still the live one, and a remount landing during the winning
 * attempt has already had `SQLiteProvider` close it — publishing from here handed
 * every reader a closed connection (#5366). `beginInitialization` owns the single
 * publish, where the supersede check already lives.
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
    return { status: 'ready' };
  } catch (error) {
    const { locked, code } = classifySqliteLockError(error);
    return { status: 'failed', phase, error, retryable: locked, sqliteCode: code };
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
  markStartup('sqlite.initial.start');
  let releaseLaunch: () => void = () => {};
  const launchGate = new Promise<void>((resolve) => {
    releaseLaunch = resolve;
  });

  void (async () => {
    const startedAt = Date.now();
    const deadline = startedAt + MAX_INIT_WINDOW_MS;
    // What the last failed attempt tripped over, so a recovery can say which step
    // was contended rather than just "it took three goes".
    let lastFailure: { phase: InitPhase; sqliteCode: number | null } | null = null;

    // Attempts made, for the telemetry narrative ("it took three goes").
    let attempts = 0;
    // Attempts that actually reached the live connection, which is what the backoff
    // and the give-up ceiling are budgeting for. A superseded attempt is refunded —
    // see the restart branch below.
    let budgetSpent = 0;
    let supersededRestarts = 0;

    while (budgetSpent < MAX_INIT_ATTEMPTS) {
      // The live connection, which a remount may have swapped since the chain
      // started — see `latestDatabase`. Falls back to the captured one only if the
      // handle was cleared outright.
      const target = latestDatabase ?? db;
      const outcome = await attemptInitialization(target);
      attempts += 1;

      // Unblock the provider once, whatever the first attempt did.
      if (attempts === 1) {
        markStartup('sqlite.initial.gate', outcome.status === 'ready' ? 'ready' : 'degraded');
        releaseLaunch();
      }

      if (outcome.status === 'ready') {
        // A remount landed while this attempt was in flight, so `SQLiteProvider` has
        // already closed the connection it just prepared — its teardown runs before the
        // replacement reaches `initializeDatabase`, so a superseded target is a CLOSED
        // target.
        const superseded = latestDatabase !== null && latestDatabase !== target;
        // THE publish, and the only one in the lifecycle. Two conditions, both
        // load-bearing: the schema is actually in place (a handle whose migrations never
        // ran hands every consumer a database with no tables), and this connection is
        // still the live one. Publishing a superseded target is #5292's exact symptom —
        // `Access to closed resource` on every local read — reintroduced by #5292's own
        // fix, because neither exit below retracted it (#5366). Keeping it here rather
        // than inside `attemptInitialization` means no return path can leave a closed
        // connection published: there is only one place that could have published it.
        if (!superseded) setDatabaseHandle(target);
        // The remount was handed this (about to resolve) promise and nothing else will
        // initialize its connection, so retarget here instead of returning and leaving
        // offline storage dead for the session. Spends a superseded refund, not retry
        // budget: no lock was contended, the file is simply behind a newer connection.
        if (superseded && supersededRestarts < MAX_SUPERSEDED_RESTARTS) {
          markStartup('sqlite.recovery.start');
          supersededRestarts += 1;
          continue;
        }
        // Drop the single-flight guard on the way out. Holding it past a successful
        // chain is what made #5292 permanent: the next mount was handed this resolved
        // promise, `setDatabaseHandle` never ran again, and the handle stayed pinned to
        // a connection `SQLiteProvider` had since closed. Nothing awaits between here
        // and the `return`, so no mount can slip in after the clear and be stranded.
        activeInitialization = null;
        if (superseded) {
          // Out of refunds with the live connection never initialized: a remount loop
          // outran the chain. Offline storage is off for the session — nothing is
          // published, `isSchemaReady()` is false — and only another mount can restart
          // it, so it has to be visible. Falling through to the success path published
          // the closed connection as ready and reported nothing at all (#5366).
          if (attempts > 1) markStartup('sqlite.recovery.end', 'error');
          retractSupersededHandle();
          reportSupersededExhaustion({
            attempts,
            elapsedMs: Date.now() - startedAt,
            restarts: supersededRestarts,
          });
          return;
        }
        if (attempts > 1) markStartup('sqlite.recovery.end', 'ready');
        // Only a chain that survived a GENUINE lock failure recovered from
        // contention. A chain whose only failure was against a superseded (closed)
        // handle worked around a remount, not a lock — firing the event for it
        // would claim contention that never happened and feed a bogus ~retry-delay
        // `elapsedMs` into the distribution that sizes the retry window (#4325).
        // `lastFailure` is only ever set by an earlier iteration, so it doubles as
        // the "this was not a first-attempt win" check.
        if (lastFailure !== null) {
          reportInitRecovered({
            attempts,
            elapsedMs: Date.now() - startedAt,
            phase: lastFailure.phase,
            sqliteCode: lastFailure.sqliteCode,
          });
        }
        return;
      }

      // A remount landed WHILE this attempt was in flight, so the connection it just
      // failed against is the one `SQLiteProvider` closed on teardown. That failure
      // says nothing about the lock, and reporting it would pollute the sqlite-init
      // aggregate with a lifecycle artefact — carry on against the new handle instead.
      const superseded = latestDatabase !== null && latestDatabase !== target;

      // Lock-classified failures always count toward the recovery narrative — the
      // lock was real even if the handle was superseded a moment later. A non-lock
      // throw against a superseded handle is the closed-connection artefact above
      // and must not arm the recovery event.
      if (outcome.retryable || !superseded) {
        lastFailure = { phase: outcome.phase, sqliteCode: outcome.sqliteCode };
      }

      // A non-lock failure against a superseded handle never touched the live file, so
      // it spends no budget and takes no backoff — the replacement connection is fresh,
      // there is nothing to wait out. Without the refund a remount landing during the
      // LAST attempt hit the attempt ceiling and ended the chain with the
      // replacement never initialized, and nothing left to call in: that remount had
      // already been handed the resolved launch promise, so schema readiness stayed
      // false for the rest of the session.
      if (superseded && !outcome.retryable && supersededRestarts < MAX_SUPERSEDED_RESTARTS) {
        markStartup('sqlite.recovery.start');
        supersededRestarts += 1;
        continue;
      }

      budgetSpent += 1;
      const retryDelayMs = INIT_ALL_RETRY_DELAYS_MS[budgetSpent - 1];
      const outOfRoad =
        (!outcome.retryable && !superseded) ||
        budgetSpent === MAX_INIT_ATTEMPTS ||
        retryDelayMs === undefined ||
        Date.now() + retryDelayMs >= deadline;

      if (outOfRoad) {
        if (attempts > 1) markStartup('sqlite.recovery.end', 'error');
        if (__DEV__) {
          console.warn(
            `[SQLite] initializeDatabase failed in phase "${outcome.phase}" after ${attempts} attempt(s); ` +
              'offline storage disabled this session:',
            outcome.error,
          );
        }
        // Let a genuinely new mount try again rather than staying dead for the
        // process. Cleared BEFORE the report, because the journal-mode read-back
        // below awaits — a mount landing in that window must start a fresh chain
        // rather than be handed this dead one.
        activeInitialization = null;
        if (!superseded) {
          // In production a silent null handle just switches every offline feature off
          // with no trace — report it so a spike is diagnosable from telemetry. Only the
          // final attempt reports, so a retried-and-recovered launch stays quiet (it
          // fires the recovery event above instead).
          reportError(outcome.error, {
            tags: {
              source: 'offline-sync',
              kind: 'sqlite-init',
              phase: outcome.phase,
              sqlite_code: outcome.sqliteCode,
              journal_mode: await readJournalMode(target),
            },
            extra: { attempts, retryable: outcome.retryable, elapsedMs: Date.now() - startedAt },
          });
        }
        // Last thing before the chain stops, and after the awaited read-back above, so
        // a remount landing during it is accounted for: nothing that survives this
        // return may point at a connection `SQLiteProvider` has closed (#5366).
        retractSupersededHandle();
        return;
      }

      markStartup('sqlite.recovery.start');
      await sleepUntilRetry(retryDelayMs);
    }
  })();

  return launchGate;
}

/**
 * Report that offline storage came up on a retry, at most once per process.
 *
 * Without this the lane is write-only: Sentry hears about a launch that ran out of
 * retries and nothing at all about one that contended and recovered, so after an OTA
 * "fixed" and "still contending, just retrying its way out" look identical. The
 * `elapsedMs` distribution is also the only measurement of how long the offline
 * writers actually hold the file — the retry window is sized on a guess today.
 *
 * Firing this ~1s into launch is safe: the PostHog client is constructed eagerly at
 * module import with a synchronously-resolved bootstrap distinct id.
 */
function reportInitRecovered(properties: {
  attempts: number;
  elapsedMs: number;
  phase: InitPhase;
  sqliteCode: number | null;
}): void {
  if (hasReportedRecovery) return;
  hasReportedRecovery = true;
  track(SHARED_EVENTS.OfflineSqliteInitRecovered, properties);
}

/**
 * Report a chain that ran out of superseded-connection refunds without ever reaching
 * the live database.
 *
 * The outcome is the same dead offline storage a give-up leaves — no handle, no schema
 * readiness, every local read on the network path — so it needs the same visibility.
 * Until #5366 this exit reported nothing at all: it fell through to the success path,
 * published the closed connection, and looked from telemetry like a clean launch.
 *
 * Deliberately NOT `kind: 'sqlite-init'`. That aggregate is the lock-contention signal
 * #4314 reads to decide whether the lock problem is fixed, and there is no lock in
 * this failure — it is a remount loop outrunning one chain, and mixing the two is what
 * made the closed-handle artefacts unreadable in the first place.
 */
function reportSupersededExhaustion(details: { attempts: number; elapsedMs: number; restarts: number }): void {
  reportError(new Error('SQLite init ran out of superseded-connection restarts'), {
    tags: { source: 'offline-sync', kind: 'sqlite-init-superseded' },
    extra: details,
  });
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
  latestDatabase = null;
  hasReportedRecovery = false;
  // A chain a test walked away from must not be reachable from the next one's first
  // `initializeDatabase` call.
  wakeFromBackoff = null;
}

/**
 * Wipes the current user's local data on sign-out (account lifecycle, I11), keeping
 * the downloaded board catalogs. Runs every delete plus the checkpoint reset inside
 * one transaction so the device is left in a clean, internally-consistent state for
 * the next account: either everything is cleared or nothing is.
 *
 * This is the wipe the sign-out paths the user did NOT choose take — the auth
 * interceptor's failed-refresh 401, checkAuth's proactive expiry, a confirmed
 * identity change. A token glitch must not cost someone a 271MB Kilter download.
 * An explicit, confirmed sign-out runs `purgeLocalDataForSignOut` below instead.
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

/** What an explicit sign-out's wipe actually removed, for telemetry. */
export type SignOutPurgeResult = {
  /**
   * Queued writes still awaiting a send when the wipe ran — counted inside the
   * transaction. Excludes dead letters, which are reported separately below;
   * `pendingDiscarded + deadLettersDiscarded` is the whole outbox the wipe deleted.
   */
  pendingDiscarded: number;
  /**
   * Writes that had already exhausted their retries (`status = 'dead_letter'`) when
   * the wipe ran. Split out because they are a different kind of loss: the drain
   * sign-out runs cannot push them, the user was being shown a Retry button for them
   * on the More tab, and folding them into `pendingDiscarded` made "writes lost at
   * sign-out" and "writes that were still trying" the same number.
   */
  deadLettersDiscarded: number;
  /** Whether a downloaded board catalog was on disk before the wipe. */
  hadDownloads: boolean;
  /** Whether the VACUUM handed the freed pages back to the filesystem. */
  vacuumed: boolean;
  /** Database bytes on disk before / after, or undefined where the stat isn't available. */
  bytesBefore?: number;
  bytesAfter?: number;
};

/**
 * The wipe an EXPLICIT sign-out runs: everything `clearUserData` deletes, plus the
 * downloaded board catalogs and every sync_meta marker, then a VACUUM so the freed
 * pages actually leave the file (issue #3621).
 *
 * The board tables used to be spared on the grounds that a catalog is public
 * reference data, identical whoever is signed in. That traded a signed-out user's
 * ~200k rows per board of disk for a faster re-enable, and it reads as a bug from the
 * outside: "log out" left a 271MB download on the phone that nothing could reach and
 * the OS storage screen still counted. `BOARD_DATA_TABLES` is spread rather than
 * listed so a future per-board table (`isPerBoard: true` in TABLE_CONFIGS) is covered
 * automatically — `board_climb_grades` fell through exactly this kind of hardcoded
 * list once.
 *
 * Rows and the markers describing them dying together is the load-bearing part, which
 * is why this uses `deleteAllSyncMeta` and not the selective reset: a surviving
 * `scope-complete:` would make `isBoardDownloadedLocally` serve an empty catalog to
 * local-first search as a whole board, and a surviving checkpoint would make the
 * strict `>` delta pull resume past rows that are gone.
 *
 * The caller MUST have aborted in-flight pulls first — a page already on the wire
 * would otherwise land after the delete and resurrect part of a catalog, complete
 * with a checkpoint past it. AuthProvider's `setSigningOut(true)` does that (it bumps
 * the monotonic wipe epoch every long-running pull re-checks across its awaits) and
 * is what this runs inside.
 *
 * The VACUUM is what makes the deletes visible to the user: without it SQLite parks
 * the freed pages on its freelist and the file keeps its old size forever. It is
 * cheap in this particular case — VACUUM's cost tracks LIVE data, and every table has
 * just been emptied, so it rebuilds a near-empty file rather than the 5-20s exclusive
 * rebuild the same call costs when a teardown leaves the rest of a catalog in place.
 * It runs outside the transaction because SQLite rejects VACUUM inside one, and its
 * failure is swallowed: the rows are already gone by then, so a SQLITE_FULL means
 * "the file didn't shrink", never data loss — and failing a sign-out over cosmetics
 * would be the worse bug.
 *
 * `onDownloadAbandoned` closes the download funnel for whatever was still
 * downloading when this ran (issue #4452) — the same seam a board removal uses
 * (`removeBoardScopeData`). It is called once per scope that had announced a
 * download and never completed one; see the comments at the read and the call
 * below for why the read has to precede the transaction and the report follow it.
 */
export async function purgeLocalDataForSignOut(
  db: SQLiteDatabase,
  options?: { onDownloadAbandoned?: (info: { scopeKey: string }) => void },
): Promise<SignOutPurgeResult> {
  const bytesBefore = measureDatabaseBytesQuietly();

  // READ BEFORE THE TRANSACTION, for the reason scope-teardown.ts spells out: the
  // `deleteAllSyncMeta` at the bottom of it takes `scope-started:` along with
  // every other row, and once that commits nothing anywhere can tell a download
  // abandoned mid-flight from a board that was never downloaded at all.
  const abandonedScopeKeys = options?.onDownloadAbandoned === undefined ? [] : await getUnfinishedDownloadScopeKeys(db);

  let pendingDiscarded = 0;
  let deadLettersDiscarded = 0;
  let hadDownloads = false;
  await db.withExclusiveTransactionAsync(async (txn) => {
    // Same lock guard as clearUserData: this runs on its own connection alongside
    // in-flight sync reads/writes, so wait for the write lock rather than failing
    // instantly with SQLITE_BUSY (BOARDSESH-A9).
    //
    // IMMEDIATE, not just a timeout (#4332): the two reads below run before the
    // first DELETE, and expo's `BEGIN` is deferred — so a deferred transaction
    // would open for READING here, and SQLite never consults `busy_timeout` when
    // upgrading a read transaction to a write. A contended sign-out would fail in
    // about a millisecond and leave the previous account's rows on disk, which is
    // the exact hazard the owner stamp exists to defend against.
    await beginImmediateWrite(txn, OFFLINE_DB_BUSY_TIMEOUT_MS);
    // Counted here, inside the transaction and immediately before the DELETE, because
    // this is the only place the number is both post-drain and exact. The count the
    // confirmation dialog showed was taken before sign-out's bounded 3s drain, so it
    // can be larger than what was really lost.
    //
    // One grouped read rather than two COUNTs, and anything that is not a dead letter
    // counts as pending: the schema defaults `status` to 'pending', so an unknown
    // future status still lands in the "unsent write" bucket instead of vanishing
    // from both totals.
    const queueRows = await txn.getAllAsync<{ status: string; count: number }>(
      'SELECT status, COUNT(*) AS count FROM pending_mutations GROUP BY status',
    );
    for (const row of queueRows) {
      if (row.status === 'dead_letter') deadLettersDiscarded += row.count;
      else pendingDiscarded += row.count;
    }
    const downloadRow = await txn.getFirstAsync<{ has_rows: number }>(
      'SELECT EXISTS(SELECT 1 FROM board_climbs LIMIT 1) AS has_rows',
    );
    hadDownloads = (downloadRow?.has_rows ?? 0) === 1;
    for (const table of [...USER_DATA_TABLES_TO_CLEAR, ...BOARD_DATA_TABLES]) {
      await txn.runAsync(`DELETE FROM ${table}`);
    }
    await deleteAllSyncMeta(txn);
  });

  // AFTER the commit, for the reason removeBoardScopeData reports after its own:
  // the cycle this sign-out tore down is still unwinding while the transaction
  // holds the write lock, and reporting first would race its `aborted-wipe` — the
  // claim below would then be made before the report it exists to defer to.
  for (const scopeKey of abandonedScopeKeys) {
    const namespace = purgeNamespaceForScopeKey(scopeKey);
    // A key we cannot parse has no namespace to claim against, and the registry
    // never records one for it either — so nothing can be double-reported and it
    // is reported unconditionally rather than dropped.
    if (namespace !== undefined && !claimAbandonedDownloadTerminal(scopeKey, namespace)) continue;
    options?.onDownloadAbandoned?.({ scopeKey });
  }

  let vacuumed = false;
  try {
    vacuumed = await vacuumDatabase(db);
  } catch (error) {
    if (__DEV__) {
      console.warn('[SQLite] post-sign-out VACUUM failed; data is cleared but the file did not shrink:', error);
    }
    reportError(error, { tags: { source: 'offline-sync', kind: 'sign-out-vacuum' } });
  }

  return {
    pendingDiscarded,
    deadLettersDiscarded,
    hadDownloads,
    vacuumed,
    bytesBefore,
    bytesAfter: measureDatabaseBytesQuietly(),
  };
}

/**
 * The on-disk size, or undefined when the platform can't say. Expo web has no usable
 * `Paths.document`, and a telemetry figure is never a reason to fail a sign-out.
 */
function measureDatabaseBytesQuietly(): number | undefined {
  try {
    return measureDatabaseBytes();
  } catch {
    return undefined;
  }
}
