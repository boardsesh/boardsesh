// Exercises clearUserData against the REAL v1 DDL (via node:sqlite): every
// user-data table plus the mutation queue and sync checkpoints must be wiped on
// sign-out, while the expensive board reference cache is left untouched.
//
// Also guards the #3646 retirement: no bundled-seed machinery may come back into
// the DB lifecycle.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const reportErrorMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/error-reporting', () => ({ reportError: reportErrorMock }));

const trackMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/analytics', () => ({ track: trackMock }));
// Only vacuumDatabase is stubbed; everything else in the engine stays real, since
// the point of this suite is what the REAL DDL ends up holding. VACUUM is separately
// covered by db/vacuum's own tests, and stubbing it is the only way to exercise the
// "rows are gone but the file didn't shrink" branch.
const vacuumDatabaseMock = vi.hoisted(() => vi.fn(async (): Promise<boolean> => true));
vi.mock('@boardsesh/offline-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boardsesh/offline-sync')>();
  return { ...actual, vacuumDatabase: vacuumDatabaseMock };
});

import type { SQLiteDatabase } from 'expo-sqlite';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import {
  clearUserData,
  purgeLocalDataForSignOut,
  getDatabaseHandle,
  initializeDatabase,
  INIT_RETRY_DELAYS_MS,
  setDatabaseHandle,
} from '../connection';
import { isSchemaReady } from '../schema-ready';
import { resetDatabaseInitializationForTests } from '../testing';
import {
  runMigrations,
  setCheckpoint,
  getCheckpoint,
  getCheckpointKey,
  enqueue,
  getPendingCount,
  getDeadLetterCount,
  markScopeDownloadComplete,
  isScopeDownloadComplete,
  getDownloadedScopeKeys,
  BOARD_DATA_TABLES,
} from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';

let db: TestSqliteDb & SQLiteDatabase;

async function countRows(table: string): Promise<number> {
  const row = await db.getFirstAsync<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`);
  return row?.count ?? 0;
}

// One signed-in device: the user's own rows, a queued write, a downloaded catalog
// with its markers, and a checkpoint per board table.
async function seedSignedInDevice(): Promise<void> {
  const now = '2024-06-01T00:00:00Z';
  await db.runAsync(`INSERT INTO boardsesh_ticks (uuid, board_type, climb_uuid, angle) VALUES (?, ?, ?, ?)`, [
    'tick-1',
    'kilter',
    'climb-1',
    40,
  ]);
  await db.runAsync(`INSERT INTO playlists (uuid, name) VALUES (?, ?)`, ['pl-1', 'Projects']);
  await db.runAsync(`INSERT INTO user_favorites (board_name, climb_uuid, angle) VALUES (?, ?, ?)`, [
    'kilter',
    'climb-1',
    40,
  ]);
  await enqueue(db, 'boardsesh_ticks', 'create', { climbUuid: 'climb-1' }, 'tick-1');
  await enqueue(db, 'boardsesh_ticks', 'create', { climbUuid: 'climb-2' }, 'tick-2');
  await setCheckpoint(db, getCheckpointKey('boardsesh_ticks'), { updatedAt: now, syncSeq: '5' });

  await db.runAsync(`INSERT INTO board_climbs (uuid, board_type) VALUES (?, ?)`, ['climb-1', 'kilter']);
  await db.runAsync(
    `INSERT INTO board_climb_stats (board_type, climb_uuid, angle, ascensionist_count) VALUES (?, ?, ?, ?)`,
    ['kilter', 'climb-1', 40, 12],
  );
  for (const tableName of BOARD_DATA_TABLES) {
    await setCheckpoint(db, getCheckpointKey(tableName, 'kilter:1:1'), { updatedAt: now, syncSeq: '9' });
  }
  await markScopeDownloadComplete(db, 'kilter:1:1');
}

beforeEach(async () => {
  // connection.ts is the expo lifecycle seam, so its API is typed against the
  // real SQLiteDatabase; the node adapter satisfies the used surface.
  db = createTestDatabase() as unknown as TestSqliteDb & SQLiteDatabase;
  await runMigrations(db);
  vacuumDatabaseMock.mockClear();
  vacuumDatabaseMock.mockResolvedValue(true);
});

describe('clearUserData', () => {
  it('clears every user-data table, the mutation queue, and sync checkpoints', async () => {
    const now = '2024-06-01T00:00:00Z';

    await db.runAsync(`INSERT INTO boardsesh_ticks (uuid, board_type, climb_uuid, angle) VALUES (?, ?, ?, ?)`, [
      'tick-1',
      'kilter',
      'climb-1',
      40,
    ]);
    await db.runAsync(`INSERT INTO playlists (uuid, name) VALUES (?, ?)`, ['pl-1', 'Projects']);
    await db.runAsync(`INSERT INTO playlist_climbs (playlist_uuid, climb_uuid) VALUES (?, ?)`, ['pl-1', 'climb-1']);
    await db.runAsync(`INSERT INTO user_favorites (board_name, climb_uuid, angle) VALUES (?, ?, ?)`, [
      'kilter',
      'climb-1',
      40,
    ]);
    await db.runAsync(`INSERT INTO user_follows (following_id) VALUES (?)`, ['user-2']);
    await db.runAsync(`INSERT INTO setter_follows (setter_username) VALUES (?)`, ['setter-x']);
    await db.runAsync(`INSERT INTO playlist_follows (playlist_uuid) VALUES (?)`, ['pl-9']);
    await enqueue(db, 'boardsesh_ticks', 'create', { climbUuid: 'climb-1' }, 'tick-1');
    await setCheckpoint(db, getCheckpointKey('boardsesh_ticks'), { updatedAt: now, syncSeq: '5' });

    // Board reference data that must survive the wipe.
    await db.runAsync(`INSERT INTO board_climbs (uuid, board_type) VALUES (?, ?)`, ['climb-1', 'kilter']);
    await db.runAsync(
      `INSERT INTO board_climb_stats (board_type, climb_uuid, angle, ascensionist_count) VALUES (?, ?, ?, ?)`,
      ['kilter', 'climb-1', 40, 12],
    );

    await clearUserData(db);

    expect(await countRows('boardsesh_ticks')).toBe(0);
    expect(await countRows('playlists')).toBe(0);
    expect(await countRows('playlist_climbs')).toBe(0);
    expect(await countRows('user_favorites')).toBe(0);
    expect(await countRows('user_follows')).toBe(0);
    expect(await countRows('setter_follows')).toBe(0);
    expect(await countRows('playlist_follows')).toBe(0);
    expect(await getPendingCount(db)).toBe(0);
    expect(await getCheckpoint(db, getCheckpointKey('boardsesh_ticks'))).toBeNull();

    // The expensive shared cache is deliberately retained.
    expect(await countRows('board_climbs')).toBe(1);
    expect(await countRows('board_climb_stats')).toBe(1);
  });

  it('is a no-op on an already-empty database', async () => {
    await clearUserData(db);

    expect(await countRows('boardsesh_ticks')).toBe(0);
    expect(await getPendingCount(db)).toBe(0);
  });

  // The guarantee that keeps a token-refresh glitch from costing someone a 271MB
  // download: the forced/expiry paths still run this wipe, and it still spares the
  // catalog and the checkpoints that let the next sign-in resume instead of re-crawl.
  it('leaves the downloaded catalog and its board checkpoints alone', async () => {
    await seedSignedInDevice();

    await clearUserData(db);

    expect(await countRows('board_climbs')).toBe(1);
    expect(await countRows('board_climb_stats')).toBe(1);
    for (const tableName of BOARD_DATA_TABLES) {
      expect(await getCheckpoint(db, getCheckpointKey(tableName, 'kilter:1:1'))).not.toBeNull();
    }
    expect(await isScopeDownloadComplete(db, 'kilter:1:1')).toBe(true);
  });
});

describe('purgeLocalDataForSignOut', () => {
  it('clears the user rows, the queue AND the downloaded board catalog', async () => {
    await seedSignedInDevice();

    await purgeLocalDataForSignOut(db);

    expect(await countRows('boardsesh_ticks')).toBe(0);
    expect(await countRows('playlists')).toBe(0);
    expect(await countRows('user_favorites')).toBe(0);
    expect(await getPendingCount(db)).toBe(0);
    // Derived from BOARD_DATA_TABLES, not hardcoded, so a future per-board table
    // cannot fall through the way board_climb_grades once did.
    for (const tableName of BOARD_DATA_TABLES) {
      expect(await countRows(tableName)).toBe(0);
    }
  });

  // The trap this wipe exists to avoid. `scope-complete:` and the bootstrap markers
  // sit OUTSIDE the `checkpoint:` prefix, so a prefix sweep would leave them past the
  // rows they describe — and isBoardDownloadedLocally would then serve an empty
  // catalog to local-first search as though it were the whole board.
  it('leaves no sync_meta marker describing rows it deleted', async () => {
    await seedSignedInDevice();
    await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', ['bootstrap-done:kilter:1:1', '1']);
    await db.runAsync('INSERT INTO sync_meta (key, value) VALUES (?, ?)', ['bootstrap-attempts:kilter:1:1', '2']);

    await purgeLocalDataForSignOut(db);

    expect(await isScopeDownloadComplete(db, 'kilter:1:1')).toBe(false);
    expect(await getDownloadedScopeKeys(db)).toEqual([]);
    expect(await countRows('sync_meta')).toBe(0);
  });

  // schema_version is its own table. Losing it would replay every migration over a
  // live database on the next launch.
  it('preserves the migration state', async () => {
    await seedSignedInDevice();

    await purgeLocalDataForSignOut(db);

    expect(await countRows('schema_version')).toBeGreaterThan(0);
  });

  // Counted inside the wipe's transaction, which is the only place it can be honest:
  // the dialog's number was read before sign-out's bounded 3s drain.
  it('reports the queue depth it discarded and whether a catalog was present', async () => {
    await seedSignedInDevice();

    const result = await purgeLocalDataForSignOut(db);

    expect(result.pendingDiscarded).toBe(2);
    expect(result.deadLettersDiscarded).toBe(0);
    expect(result.hadDownloads).toBe(true);
    expect(result.vacuumed).toBe(true);
  });

  // Dead letters are deleted by the same DELETE, but nothing ever tried to send them:
  // their retries were already spent and the More tab was showing a Retry button for
  // them. Counting them as pending would claim a send attempt that never happened,
  // and the old `status = 'pending'` COUNT dropped them from the report entirely —
  // the loss this wipe is most likely to cause, reported as zero.
  it('counts dead-lettered writes separately from the ones still trying', async () => {
    await seedSignedInDevice();
    await enqueue(db, 'boardsesh_ticks', 'create', { climbUuid: 'climb-3' }, 'tick-3');
    // markDeadLetter isn't part of the package's public surface (the drainer owns the
    // transition), so the row is aged into the state the drainer would leave it in.
    await db.runAsync(`UPDATE pending_mutations SET status = 'dead_letter', last_error = ? WHERE idempotency_key = ?`, [
      'climb does not exist',
      'tick-3',
    ]);
    expect(await getDeadLetterCount(db)).toBe(1);

    const result = await purgeLocalDataForSignOut(db);

    expect(result.pendingDiscarded).toBe(2);
    expect(result.deadLettersDiscarded).toBe(1);
    expect(await countRows('pending_mutations')).toBe(0);
  });

  it('reports no downloads when only user data was present', async () => {
    await db.runAsync(`INSERT INTO playlists (uuid, name) VALUES (?, ?)`, ['pl-1', 'Projects']);

    const result = await purgeLocalDataForSignOut(db);

    expect(result.hadDownloads).toBe(false);
    expect(result.pendingDiscarded).toBe(0);
    expect(result.deadLettersDiscarded).toBe(0);
  });

  // The rows are already gone by the time VACUUM runs, so a SQLITE_FULL means "the
  // file didn't shrink", never data loss. Failing a sign-out over that would be worse.
  it('still resolves when the VACUUM fails, and reports it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vacuumDatabaseMock.mockRejectedValue(new Error('database or disk is full'));
    await seedSignedInDevice();

    const result = await purgeLocalDataForSignOut(db);

    expect(result.vacuumed).toBe(false);
    expect(result.pendingDiscarded).toBe(2);
    expect(await countRows('board_climbs')).toBe(0);
    expect(reportErrorMock).toHaveBeenCalled();
  });

  it('is a no-op on an already-empty database', async () => {
    const result = await purgeLocalDataForSignOut(db);

    expect(result).toMatchObject({ pendingDiscarded: 0, deadLettersDiscarded: 0, hadDownloads: false });
    expect(await countRows('board_climbs')).toBe(0);
  });

  // The download funnel's sign-out terminal (issue #4452). `deleteAllSyncMeta`
  // takes `scope-started:` with everything else, so this wipe is the last code
  // that can tell an abandoned download from a board that was never downloaded —
  // hence the read before its transaction and the report after the commit.
  // `markScopeDownloadStarted` stays package-internal (only the pull client
  // writes it), so the marker is inserted the way the engine would.
  const announceDownload = (scopeKey: string) =>
    db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [`scope-started:${scopeKey}`, '1']);

  describe('the abandoned-download seam', () => {
    it('calls the hook once per download that had started and never completed', async () => {
      await seedSignedInDevice();
      await announceDownload('tension:11:8');
      // seedSignedInDevice already completed kilter:1:1 — its Started is closed,
      // so it owes nothing.
      await announceDownload('kilter:1:1');

      const onDownloadAbandoned = vi.fn();
      await purgeLocalDataForSignOut(db, { onDownloadAbandoned });

      expect(onDownloadAbandoned).toHaveBeenCalledTimes(1);
      expect(onDownloadAbandoned).toHaveBeenCalledWith({ scopeKey: 'tension:11:8' });
    });

    it('stays silent when nothing was downloading', async () => {
      await seedSignedInDevice();
      await announceDownload('kilter:1:1');

      const onDownloadAbandoned = vi.fn();
      await purgeLocalDataForSignOut(db, { onDownloadAbandoned });

      expect(onDownloadAbandoned).not.toHaveBeenCalled();
    });

    it('wipes exactly the same rows when no hook is supplied', async () => {
      await seedSignedInDevice();
      await announceDownload('tension:11:8');

      const result = await purgeLocalDataForSignOut(db);

      expect(result).toMatchObject({ pendingDiscarded: 2, deadLettersDiscarded: 0, hadDownloads: true });
      expect(await countRows('sync_meta')).toBe(0);
      expect(await countRows('board_climbs')).toBe(0);
    });
  });
});

// #3646 retired the bundled seed-database import (ATTACH + row copy + cursor
// stamping) from initializeDatabase. A behavioural test cannot guard that: the
// seam always resolved to "no asset" in every shipped build, so restoring the code
// changes nothing observable at runtime. The assertion that does bite on revert is
// a source-level one — the seam file is gone and the lifecycle module mentions no
// seed at all.
describe('bundled seed retirement (#3646)', () => {
  const dbModuleDir = fileURLToPath(new URL('../', import.meta.url));

  it('keeps the seed seam module deleted', () => {
    expect(existsSync(join(dbModuleDir, 'seed-asset.ts'))).toBe(false);
  });

  it('leaves no seed machinery in the database lifecycle', () => {
    const lifecycleSource = readFileSync(join(dbModuleDir, 'connection.ts'), 'utf8');
    // Every name the retired path needed. Restoring any part of it trips one.
    expect(lifecycleSource).not.toMatch(
      /resolveSeedAssetModuleId|loadOptionalSeed|SEEDABLE_BOARD_TABLES|seed_checkpoints|ATTACH DATABASE|expo-asset/,
    );
  });
});

// WAL persists on the file header (so it can't be checked on an in-memory DB —
// PRAGMA journal_mode = WAL returns "memory" there), so these run file-backed.
describe('initializeDatabase connection PRAGMAs', () => {
  let dbDir: string;
  let fileDb: TestSqliteDb & SQLiteDatabase;
  let dbPath: string;

  beforeEach(() => {
    // initializeDatabase is single-flight for the process (see activeInitialization),
    // so each test has to start from a clean lifecycle.
    resetDatabaseInitializationForTests();
    setDatabaseHandle(null);
    reportErrorMock.mockClear();
    trackMock.mockClear();
    dbDir = mkdtempSync(join(tmpdir(), 'bs-conn-'));
    dbPath = join(dbDir, 'boardsesh.db');
    fileDb = createTestDatabase(dbPath) as unknown as TestSqliteDb & SQLiteDatabase;
  });

  afterEach(() => {
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('puts the main connection in WAL mode with a 5s busy_timeout', async () => {
    await initializeDatabase(fileDb);

    const journal = await fileDb.getFirstAsync<{ journal_mode: string }>('PRAGMA journal_mode');
    expect(journal?.journal_mode?.toLowerCase()).toBe('wal');
    const busy = await fileDb.getFirstAsync<{ timeout: number }>('PRAGMA busy_timeout');
    expect(busy?.timeout).toBe(5000);
  });

  it('persists WAL on the file so a fresh connection inherits it', async () => {
    await initializeDatabase(fileDb);

    // A separately-opened connection (mirrors the per-task connection
    // withExclusiveTransactionAsync spins up) reads WAL from the file header,
    // but starts with the default busy_timeout of 0 — hence the per-connection set.
    const other = createTestDatabase(dbPath) as unknown as TestSqliteDb & SQLiteDatabase;
    const journal = await other.getFirstAsync<{ journal_mode: string }>('PRAGMA journal_mode');
    expect(journal?.journal_mode?.toLowerCase()).toBe('wal');
    const busy = await other.getFirstAsync<{ timeout: number }>('PRAGMA busy_timeout');
    expect(busy?.timeout).toBe(0);
  });
});

// #4104: startup DDL needs SQLite's single write lock, so a long writer already
// holding the file (a VACUUM, a snapshot import, a teardown still draining across a
// remount or OTA reload) made initializeDatabase throw. It swallowed the error, never
// published the handle, and never tried again — one transient collision disabled
// offline storage for the whole session. These drive that exact interleaving.
describe('initializeDatabase lock contention (#4104)', () => {
  // The real gap before the first retry, read from the production backoff rather than
  // mirrored as a literal. Advancing the fake clock by exactly this much runs attempt 2
  // and nothing else, and it keeps tracking if the backoff is ever retuned.
  const FIRST_RETRY_DELAY_MS = INIT_RETRY_DELAYS_MS[0];

  // The failure report awaits a best-effort `PRAGMA journal_mode` read-back, so it
  // lands a microtask or two after the launch gate the test awaited. Wait for the
  // report itself rather than guessing a tick count.
  function settledReport(): Promise<void> {
    return vi.waitFor(() => {
      expect(reportErrorMock).toHaveBeenCalled();
    });
  }

  let dbDir: string;
  let realDb: TestSqliteDb;

  const LOCK_ERROR_MESSAGE = "Calling the 'execAsync' function has failed → Error code 5: database is locked";
  // What expo-sqlite throws once SQLiteProvider's teardown has closed the handle the
  // chain captured. Not a lock error, so it classifies as permanent.
  const CLOSED_HANDLE_MESSAGE = 'Access to closed resource';

  // Stands in for the contended connection: the mutation-queue DDL — the first write
  // initializeDatabase issues — fails with the real Sentry message until `unlock()`.
  // `error` may be a function to vary the throw per failure (attempt N is contended,
  // attempt N+1 is a closed handle).
  function createContendedDatabase(
    options: { error?: Error | ((failureCount: number) => Error); onFailure?: (failureCount: number) => void } = {},
  ) {
    const { error = new Error(LOCK_ERROR_MESSAGE) } = options;
    const failureFor = (failureCount: number) => (typeof error === 'function' ? error(failureCount) : error);
    let locked = true;
    let failures = 0;

    const wrapper = {
      execAsync: async (source: string): Promise<void> => {
        if (locked && /pending_mutations/i.test(source)) {
          failures += 1;
          // Lets a test land a remount WHILE this attempt is in flight, which is the
          // only way the chain's target can be superseded.
          options.onFailure?.(failures);
          throw failureFor(failures);
        }
        await realDb.execAsync(source);
      },
      getFirstAsync: <T>(source: string, ...params: unknown[]): Promise<T | null> =>
        realDb.getFirstAsync<T>(source, ...(params as never[])),
      runAsync: (source: string, ...params: unknown[]) => realDb.runAsync(source, ...(params as never[])),
      withExclusiveTransactionAsync: (task: (txn: unknown) => Promise<void>) =>
        realDb.withExclusiveTransactionAsync(task as never),
    };

    return {
      db: wrapper as unknown as SQLiteDatabase,
      unlock: () => {
        locked = false;
      },
      failures: () => failures,
    };
  }

  beforeEach(() => {
    resetDatabaseInitializationForTests();
    setDatabaseHandle(null);
    reportErrorMock.mockClear();
    trackMock.mockClear();
    dbDir = mkdtempSync(join(tmpdir(), 'bs-lock-'));
    realDb = createTestDatabase(join(dbDir, 'boardsesh.db'));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('does not block app launch on the retry, leaving the handle unpublished for now', async () => {
    // This test deliberately walks away mid-chain, so the retry it leaves pending must
    // sit on the fake clock: afterEach's useRealTimers() discards it, instead of a real
    // timer firing into a later test and publishing a handle or reporting an error there.
    vi.useFakeTimers();
    const contended = createContendedDatabase();

    // Resolves as soon as the FIRST attempt settles — SQLiteProvider renders nothing
    // until onInit resolves, so waiting for retries here would be a black screen.
    await expect(initializeDatabase(contended.db)).resolves.toBeUndefined();

    expect(contended.failures()).toBe(1);
    expect(getDatabaseHandle()).toBeNull();
    // A launch that is still retrying is not yet newsworthy.
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it('publishes the handle once a retry wins, instead of staying dead for the session', async () => {
    // Fake timers, not a real sleep: the gap before the first retry is exactly
    // FIRST_RETRY_DELAY_MS, and a real wait would race the attempt itself under CI load.
    vi.useFakeTimers();
    const contended = createContendedDatabase();

    await initializeDatabase(contended.db);
    expect(getDatabaseHandle()).toBeNull();

    // The contending writer finishes (VACUUM done, import committed).
    contended.unlock();
    await vi.advanceTimersByTimeAsync(FIRST_RETRY_DELAY_MS);

    expect(getDatabaseHandle()).toBe(contended.db);
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it('shares one lifecycle across a remount mid-retry, retargeted onto the new connection', async () => {
    vi.useFakeTimers();
    const first = createContendedDatabase();
    const second = createContendedDatabase();

    const initial = initializeDatabase(first.db);
    await initial;

    // A remount lands while the retry chain is still pending. SQLiteProvider has no
    // re-entrancy guard, so without the single-flight this would run a second chain —
    // two migration transactions against the one file, i.e. more of the contention
    // being fixed.
    const remount = initializeDatabase(second.db);
    expect(remount).toBe(initial);

    // ...but the one chain must follow the LIVE connection. SQLiteProvider's effect
    // teardown closed `first.db` on that remount, so every remaining attempt against
    // it would throw "closed resource" — not a lock error, so classified permanent
    // and reported to Sentry as a sqlite-init failure that never happened.
    second.unlock();
    await vi.advanceTimersByTimeAsync(FIRST_RETRY_DELAY_MS);

    expect(getDatabaseHandle()).toBe(second.db);
    // The dead connection was touched once, by the attempt that predates the remount.
    expect(first.failures()).toBe(1);
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it('does not report a failure against a connection the remount had already closed', async () => {
    vi.useFakeTimers();
    const healthy = createContendedDatabase();
    healthy.unlock();
    // Without the supersede check the chain would stop dead on attempt 1 and file the
    // closed-handle throw under kind:'sqlite-init'.
    const closed = createContendedDatabase({
      error: new Error(CLOSED_HANDLE_MESSAGE),
      onFailure: () => {
        void initializeDatabase(healthy.db);
      },
    });

    await initializeDatabase(closed.db);
    expect(reportErrorMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(FIRST_RETRY_DELAY_MS);

    expect(getDatabaseHandle()).toBe(healthy.db);
    expect(reportErrorMock).not.toHaveBeenCalled();
    // Working around a remount is not recovering from a lock: the closed-handle
    // artefact must not arm the recovery event either, or its ~retry-delay
    // elapsedMs would feed the distribution that sizes the retry window (#4325).
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('does not spend the final attempt on a connection the remount had already closed', async () => {
    vi.useFakeTimers();
    const healthy = createContendedDatabase();
    healthy.unlock();

    // Attempts 1-4 are genuine contention; the remount lands DURING attempt 5, so the
    // last attempt fails against a handle SQLiteProvider had already closed. That
    // failure tested nothing, so it must not be the one that exhausts the budget:
    // the remount already holds the resolved launch promise, so a chain that gives up
    // here leaves the replacement handle uninitialized for the whole session.
    const contended = createContendedDatabase({
      error: (failureCount) => new Error(failureCount === 5 ? CLOSED_HANDLE_MESSAGE : LOCK_ERROR_MESSAGE),
      onFailure: (failureCount) => {
        if (failureCount === 5) {
          void initializeDatabase(healthy.db);
        }
      },
    });

    await initializeDatabase(contended.db);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(contended.failures()).toBe(5);
    expect(getDatabaseHandle()).toBe(healthy.db);
    expect(isSchemaReady()).toBe(true);
    expect(reportErrorMock).not.toHaveBeenCalled();
    // The refunded attempt retries immediately — the replacement connection is fresh,
    // so there is no lock to wait out — and the lock narrative survives it: the
    // recovery still names the contention from attempt 4, not the closed handle.
    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock.mock.calls[0][1]).toMatchObject({ attempts: 6, phase: 'queue-table', sqliteCode: 5 });
  });

  it('reports a recovered init exactly once, with the contention it survived', async () => {
    vi.useFakeTimers();
    const contended = createContendedDatabase();

    await initializeDatabase(contended.db);
    contended.unlock();
    await vi.advanceTimersByTimeAsync(FIRST_RETRY_DELAY_MS);

    expect(getDatabaseHandle()).toBe(contended.db);
    expect(trackMock).toHaveBeenCalledTimes(1);
    const [eventName, properties] = trackMock.mock.calls[0];
    expect(eventName).toBe(SHARED_EVENTS.OfflineSqliteInitRecovered);
    expect(properties).toMatchObject({ attempts: 2, phase: 'queue-table', sqliteCode: 5 });
    expect(typeof (properties as { elapsedMs: unknown }).elapsedMs).toBe('number');
    // A recovery is not a failure — it must not also land in the Sentry aggregate.
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it('stays quiet on a clean launch — no recovery event when attempt 1 wins', async () => {
    const healthy = createContendedDatabase();
    healthy.unlock();

    await initializeDatabase(healthy.db);

    expect(getDatabaseHandle()).toBe(healthy.db);
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('publishes schema readiness only once the migrations have actually run', async () => {
    vi.useFakeTimers();
    const contended = createContendedDatabase();

    await initializeDatabase(contended.db);
    // The launch gate is open and every screen is rendering against this connection,
    // but it has no tables yet — the whole point of the readiness store.
    expect(isSchemaReady()).toBe(false);

    contended.unlock();
    await vi.advanceTimersByTimeAsync(FIRST_RETRY_DELAY_MS);

    expect(isSchemaReady()).toBe(true);
  });

  it('tags the failure report with the SQLite result code and the journal mode', async () => {
    vi.useFakeTimers();
    const contended = createContendedDatabase();

    await initializeDatabase(contended.db);
    await vi.advanceTimersByTimeAsync(30_000);

    const [, context] = reportErrorMock.mock.calls[0];
    expect(context.tags).toMatchObject({ sqlite_code: 5, journal_mode: 'wal' });
    expect(context.extra).toMatchObject({ attempts: 5, retryable: true });
    expect(typeof context.extra.elapsedMs).toBe('number');
  });

  it('falls back to an explicit sentinel when the journal-mode read itself fails', async () => {
    // The report runs against a database that is contended by definition, so the
    // read-back can fail too. 'unavailable' keeps "stuck in rollback journal"
    // distinguishable from "we could not tell", instead of the tag vanishing.
    const contended = createContendedDatabase({ error: new Error('Error code 10: disk I/O error') });
    const unreadable = {
      ...(contended.db as unknown as Record<string, unknown>),
      getFirstAsync: () => Promise.reject(new Error('Error code 10: disk I/O error')),
    } as unknown as SQLiteDatabase;

    await initializeDatabase(unreadable);
    await settledReport();

    const [, context] = reportErrorMock.mock.calls[0];
    expect(context.tags).toMatchObject({ journal_mode: 'unavailable' });
  });

  it('reports a disk-I/O failure on the first attempt, carrying its result code', async () => {
    const failing = createContendedDatabase({ error: new Error('Error code 10: disk I/O error') });

    await initializeDatabase(failing.db);
    await settledReport();

    expect(failing.failures()).toBe(1);
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    const [, context] = reportErrorMock.mock.calls[0];
    expect(context.tags).toMatchObject({ sqlite_code: 10 });
    expect(context.extra).toMatchObject({ attempts: 1, retryable: false });
  });

  it('gives up after the bounded attempt window and reports once, tagged with the phase', async () => {
    vi.useFakeTimers();
    const contended = createContendedDatabase();

    await initializeDatabase(contended.db);
    // Drive the whole backoff chain (500 + 2000 + 5000 + 10000 = 17.5s, inside the 30s ceiling).
    await vi.advanceTimersByTimeAsync(30_000);

    expect(contended.failures()).toBe(5);
    expect(getDatabaseHandle()).toBeNull();
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    const [, context] = reportErrorMock.mock.calls[0];
    expect(context.tags).toMatchObject({
      source: 'offline-sync',
      kind: 'sqlite-init',
      phase: 'queue-table',
      superseded: 'false',
    });
    expect(context.extra).toMatchObject({ attempts: 5, retryable: true });
  });

  it('still reports an exhausted window when a remount lands during the final attempt', async () => {
    vi.useFakeTimers();
    const healthy = createContendedDatabase();
    healthy.unlock();

    // Every attempt is genuine contention — including attempt 5, which a remount
    // happens to overlap. A LOCK failure is never refunded (only the closed-handle
    // artefact is), so the chain runs out of road with `superseded` true. Dropping
    // the report there hid a fully exhausted 30s window behind an unrelated remount:
    // offline storage is off for the session and Sentry heard nothing about it.
    const contended = createContendedDatabase({
      onFailure: (failureCount) => {
        if (failureCount === 5) {
          void initializeDatabase(healthy.db);
        }
      },
    });

    await initializeDatabase(contended.db);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(contended.failures()).toBe(5);
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    const [, context] = reportErrorMock.mock.calls[0];
    // Tagged, not merged: #4314's close criterion reads the clean `superseded:false`
    // population, so the remount-tangled tail — which can carry a closed-handle
    // artefact instead of a lock — has to stay separable rather than silently join it.
    expect(context.tags).toMatchObject({
      source: 'offline-sync',
      kind: 'sqlite-init',
      phase: 'queue-table',
      sqlite_code: 5,
      superseded: 'true',
    });
    expect(context.extra).toMatchObject({ attempts: 5, retryable: true });
  });

  it('does not retry a failure that is not lock contention', async () => {
    // A full disk or a corrupt file fails identically forever; burning the window on
    // it would just delay the report.
    const contended = createContendedDatabase({ error: new Error('disk I/O error') });

    await initializeDatabase(contended.db);
    await settledReport();

    expect(contended.failures()).toBe(1);
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    const [, context] = reportErrorMock.mock.calls[0];
    expect(context.extra).toMatchObject({ attempts: 1, retryable: false });
  });

  it('lets a later mount try again after the window is exhausted', async () => {
    const exhausted = createContendedDatabase({ error: new Error('disk I/O error') });
    const initial = initializeDatabase(exhausted.db);
    await initial;

    // The chain is over, so the guard must not pin a dead lifecycle for the process.
    const healthy = createContendedDatabase();
    healthy.unlock();
    const retryMount = initializeDatabase(healthy.db);
    expect(retryMount).not.toBe(initial);
    await retryMount;

    expect(getDatabaseHandle()).toBe(healthy.db);
  });
});
