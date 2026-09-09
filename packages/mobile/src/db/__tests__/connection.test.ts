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

const markStartupMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/profiling/startup-profile', () => ({ markStartup: markStartupMock }));

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
  INIT_LOCK_RETRY_DELAYS_MS,
  setDatabaseHandle,
  releaseDatabaseHandle,
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
    markStartupMock.mockClear();
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

  // The fast ladder's gaps, plus a second to clear the attempt that follows the last
  // of them. Advancing by exactly this leaves the chain where every phase-tagged
  // sqlite-init report on 2.4.0 sits: the whole #4104 window spent on a real lock.
  const FAST_LADDER_MS = INIT_RETRY_DELAYS_MS.reduce((total, gap) => total + gap, 0) + 1_000;
  // Every gap in both ladders, so a test can drive the chain to its true end without
  // mirroring the numbers.
  const WHOLE_LADDER_MS =
    [...INIT_RETRY_DELAYS_MS, ...INIT_LOCK_RETRY_DELAYS_MS].reduce((total, gap) => total + gap, 0) + 1_000;
  const TOTAL_ATTEMPTS = INIT_RETRY_DELAYS_MS.length + INIT_LOCK_RETRY_DELAYS_MS.length + 1;

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
    options: {
      error?: Error | ((failureCount: number) => Error);
      onFailure?: (failureCount: number) => void;
      // The same hook for an attempt that is going to SUCCEED: a remount landing
      // during the winning attempt is the production case, not just the contended one.
      onExec?: (source: string) => void;
    } = {},
  ) {
    const { error = new Error(LOCK_ERROR_MESSAGE) } = options;
    const failureFor = (failureCount: number) => (typeof error === 'function' ? error(failureCount) : error);
    let locked = true;
    let failures = 0;

    const wrapper = {
      execAsync: async (source: string): Promise<void> => {
        options.onExec?.(source);
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
    markStartupMock.mockClear();
    dbDir = mkdtempSync(join(tmpdir(), 'bs-lock-'));
    realDb = createTestDatabase(join(dbDir, 'boardsesh.db'));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('does not block app launch on the retry, leaving the handle unpublished for now', async () => {
    vi.useFakeTimers();
    const contended = createContendedDatabase();

    // Resolves as soon as the FIRST attempt settles — SQLiteProvider renders nothing
    // until onInit resolves, so waiting for retries here would be a black screen.
    await expect(initializeDatabase(contended.db)).resolves.toBeUndefined();

    expect(markStartupMock).toHaveBeenCalledWith('sqlite.initial.gate', 'degraded');
    expect(markStartupMock).toHaveBeenCalledWith('sqlite.recovery.start');
    expect(markStartupMock).not.toHaveBeenCalledWith('sqlite.recovery.end', 'ready');
    expect(contended.failures()).toBe(1);
    expect(getDatabaseHandle()).toBeNull();
    // A launch that is still retrying is not yet newsworthy.
    expect(reportErrorMock).not.toHaveBeenCalled();

    // Let the chain END rather than walking away from it. `afterEach`'s
    // `useRealTimers()` does NOT discard the retry this test leaves pending — it hands
    // it to the real clock, where it goes on driving the module-level handle and the
    // mocks into whichever test is running by then. That was survivable while the
    // ladder ran out in 17.5s; it is not now that a lock keeps the chain alive for
    // minutes (#4314). The unlock is the writer finishing, exactly as everywhere else.
    contended.unlock();
    await vi.advanceTimersByTimeAsync(FIRST_RETRY_DELAY_MS);
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

    expect(markStartupMock).toHaveBeenCalledWith('sqlite.recovery.end', 'ready');
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
    await vi.advanceTimersByTimeAsync(WHOLE_LADDER_MS);

    const [, context] = reportErrorMock.mock.calls[0];
    expect(context.tags).toMatchObject({ sqlite_code: 5, journal_mode: 'wal' });
    expect(context.extra).toMatchObject({ attempts: TOTAL_ATTEMPTS, retryable: true });
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
    // Drive both ladders to their end — the fast #4104 gaps and the slow #4314 ones.
    await vi.advanceTimersByTimeAsync(WHOLE_LADDER_MS);

    expect(contended.failures()).toBe(TOTAL_ATTEMPTS);
    expect(getDatabaseHandle()).toBeNull();
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    const [, context] = reportErrorMock.mock.calls[0];
    expect(context.tags).toMatchObject({ source: 'offline-sync', kind: 'sqlite-init', phase: 'queue-table' });
    expect(context.extra).toMatchObject({ attempts: TOTAL_ATTEMPTS, retryable: true });
  });

  // #4314: the fast ladder is sized for a writer that is merely in the way, but the one
  // that actually loses this window is a board-data snapshot import (`importMs` reaches
  // 253,939ms). Every phase-tagged sqlite-init report on 2.4.0 reads `retryable: true`,
  // `attempts: 4`, `elapsedMs: 29,875` — the whole window spent waiting out a real lock.
  // The chain then RETURNED, and `SQLiteProvider` calls `onInit` once per connection, so
  // nothing was left to try again: offline storage stayed off for the rest of the
  // session over a database that became writable a minute later.
  it('keeps retrying a lock that outlives the fast window, instead of dying for the session', async () => {
    vi.useFakeTimers();
    const contended = createContendedDatabase();

    await initializeDatabase(contended.db);
    await vi.advanceTimersByTimeAsync(FAST_LADDER_MS);

    // The old ceiling. The lock is real and still held, so this is not the moment to
    // declare the database unusable and file it in the sqlite-init aggregate.
    expect(getDatabaseHandle()).toBeNull();
    expect(reportErrorMock).not.toHaveBeenCalled();

    // The import commits a minute in.
    contended.unlock();
    await vi.advanceTimersByTimeAsync(INIT_LOCK_RETRY_DELAYS_MS[0]);

    expect(getDatabaseHandle()).toBe(contended.db);
    expect(isSchemaReady()).toBe(true);
    expect(reportErrorMock).not.toHaveBeenCalled();
    // A launch that contended and came back is a recovery, not a failure — and it is
    // the only signal that separates "fixed" from "still contending, just retrying its
    // way out" once the fleet is on this build.
    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock.mock.calls[0][1]).toMatchObject({ phase: 'queue-table', sqliteCode: 5 });
  });

  // The cost of the longer ladder, paid back. A remount inside a slow gap only moved
  // `latestDatabase` and got the already-resolved launch gate, while the chain stayed
  // parked in `delay()` — so the replacement provider rendered with a null handle and
  // `schemaReady` false for up to a MINUTE over a connection that was usable
  // immediately. At the old 17.5s ceiling that stranding cost seconds.
  it('wakes the backoff when a replacement connection arrives, instead of sleeping out the gap', async () => {
    vi.useFakeTimers();
    const contended = createContendedDatabase();

    await initializeDatabase(contended.db);
    // Spend the fast ladder, which parks the chain in the first slow gap.
    await vi.advanceTimersByTimeAsync(FAST_LADDER_MS);
    expect(getDatabaseHandle()).toBeNull();

    // SQLiteProvider remounts. Its connection is fine — whatever held the file is gone
    // with the connection that waited on it.
    const replacement = createContendedDatabase();
    replacement.unlock();
    await initializeDatabase(replacement.db);

    // ONE tick of the fake clock, nowhere near the remaining gap. Reading the wake off
    // the fake timer rather than a wall-clock wait keeps the assertion off the box's
    // load: without the wake, the chain is still asleep here.
    await vi.advanceTimersByTimeAsync(1);

    expect(getDatabaseHandle()).toBe(replacement.db);
    expect(isSchemaReady()).toBe(true);
    // Retargeted, not retried: the stale connection is not touched again after the
    // attempt that predates the remount.
    expect(contended.failures()).toBe(INIT_RETRY_DELAYS_MS.length + 1);
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  // The wake ends a SLEEP; it must not hand the loop a second go at an attempt that is
  // still running. `wakeFromBackoff` is null outside the sleep, so a remount landing
  // mid-attempt falls through to the retarget path the chain already had.
  it('does not double-run an attempt when the remount lands while one is in flight', async () => {
    vi.useFakeTimers();
    const healthy = createContendedDatabase();
    healthy.unlock();
    const contended = createContendedDatabase({
      onFailure: (failureCount) => {
        if (failureCount === 1) void initializeDatabase(healthy.db);
      },
    });

    await initializeDatabase(contended.db);
    await vi.advanceTimersByTimeAsync(FIRST_RETRY_DELAY_MS);

    expect(contended.failures()).toBe(1);
    expect(getDatabaseHandle()).toBe(healthy.db);
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  // A remount storm must not turn the ladder into a perpetual motion machine: a wake
  // shortens a wait, it does not refund budget. The chain still ends inside
  // MAX_INIT_ATTEMPTS and still reports exactly once.
  it('spends the same budget however many remounts wake it', async () => {
    vi.useFakeTimers();
    // One connection per attempt the ladder allows: the first starts the chain, and
    // every other one wakes it out of the gap it had just entered. If a wake refunded
    // budget this would never run out.
    const connections = Array.from({ length: TOTAL_ATTEMPTS }, () => createContendedDatabase());

    await initializeDatabase(connections[0].db);
    for (const connection of connections.slice(1)) {
      await initializeDatabase(connection.db);
      await vi.advanceTimersByTimeAsync(1);
    }

    const totalFailures = connections.reduce((total, connection) => total + connection.failures(), 0);
    expect(totalFailures).toBe(TOTAL_ATTEMPTS);
    expect(getDatabaseHandle()).toBeNull();
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    // And the chain is over rather than still parked, so nothing is left to fire into
    // the next launch: no sleep survives the whole remaining ladder.
    await vi.advanceTimersByTimeAsync(WHOLE_LADDER_MS);
    expect(totalFailures).toBe(TOTAL_ATTEMPTS);
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
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

  // #5292: the success-path counterpart to the exhausted-window case above. A chain
  // that WON kept the single-flight guard forever, so the next mount was handed the
  // resolved promise, the handle was never republished, and every local read went on
  // hitting the connection SQLiteProvider had closed ("Access to closed resource",
  // ~249 users/30d). The remount triggers are production ones — the root error
  // boundary's retry, Android activity recreation — not just Fast Refresh.
  it('re-publishes the connection a remount opened', async () => {
    const first = createContendedDatabase();
    first.unlock();
    await initializeDatabase(first.db);
    expect(getDatabaseHandle()).toBe(first.db);

    // The remount: SQLiteProvider closed first.db and opened second.db, calling
    // onInit again with it.
    const second = createContendedDatabase();
    second.unlock();
    await initializeDatabase(second.db);

    expect(getDatabaseHandle()).toBe(second.db);
    expect(isSchemaReady()).toBe(true);
  });

  it('retracts the closed connection when the remount starts, not when its migrations land', async () => {
    vi.useFakeTimers();
    const first = createContendedDatabase();
    first.unlock();
    await initializeDatabase(first.db);
    expect(getDatabaseHandle()).toBe(first.db);

    // The replacement connection is contended, so its own init cannot publish for at
    // least one backoff. The old handle still has to go the instant onInit is called
    // for the new one: the teardown that closed first.db is landing right now, and
    // the sync scheduler and mutation drainer read the handle from outside React,
    // where nothing tells them a remount happened. Asserted BEFORE any await —
    // republishing on success alone would leave that whole window serving a corpse.
    const second = createContendedDatabase();
    const remount = initializeDatabase(second.db);
    expect(getDatabaseHandle()).toBeNull();
    expect(isSchemaReady()).toBe(false);

    await remount;
    second.unlock();
    await vi.advanceTimersByTimeAsync(FIRST_RETRY_DELAY_MS);

    expect(getDatabaseHandle()).toBe(second.db);
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it('retargets when the remount lands during the attempt that wins', async () => {
    const second = createContendedDatabase();
    second.unlock();
    let remounted = false;
    // The remount lands mid-attempt, so this chain publishes a connection that is
    // already being torn down. It has to notice on the way out and initialize the
    // replacement itself: the remount was handed this promise, so nothing else will.
    const first = createContendedDatabase({
      // Fires on the mutation-queue DDL — the same seam the contended tests use, and
      // late enough that `initializeDatabase` has finished assigning the single-flight
      // guard, so this really is a remount arriving into a running chain.
      onExec: (source) => {
        if (remounted || !/pending_mutations/i.test(source)) return;
        remounted = true;
        void initializeDatabase(second.db);
      },
    });
    first.unlock();

    await initializeDatabase(first.db);
    await vi.waitFor(() => {
      expect(getDatabaseHandle()).toBe(second.db);
    });

    expect(isSchemaReady()).toBe(true);
    expect(reportErrorMock).not.toHaveBeenCalled();
    // Working around a remount is not recovering from contention — no lock was ever
    // held, so the recovery event must stay quiet (#4325).
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('ignores a teardown for a connection a newer mount has already replaced', () => {
    const first = createContendedDatabase();
    const second = createContendedDatabase();
    setDatabaseHandle(second.db);

    // An effect cleanup can run after the replacement connection has published
    // itself. Retracting unconditionally here would switch offline storage off for a
    // database that is perfectly alive.
    releaseDatabaseHandle(first.db);
    expect(getDatabaseHandle()).toBe(second.db);
    expect(isSchemaReady()).toBe(true);

    // ...and the teardown that DOES own the published handle still retracts it.
    releaseDatabaseHandle(second.db);
    expect(getDatabaseHandle()).toBeNull();
    expect(isSchemaReady()).toBe(false);
  });

  // #5366: the retarget path the fix above introduced published the connection it was
  // retargeting AWAY from. `SQLiteProvider` closes a connection before the replacement
  // reaches `initializeDatabase`, so a superseded target is a closed one — and every
  // reader that took it got `Access to closed resource`, which is #5292's own symptom
  // list (offline search, climb detail, local ticks) reintroduced by #5292's fix.
  it('never serves the closed connection while it retargets onto the replacement', async () => {
    vi.useFakeTimers();
    // The replacement is lock-contended and never comes good, so the retarget spends
    // the whole ladder — the window a reader lives in.
    const handlesSeenDuringRetarget: unknown[] = [];
    const second = createContendedDatabase({
      onExec: () => {
        handlesSeenDuringRetarget.push(getDatabaseHandle());
      },
    });

    let remounted = false;
    // The remount lands mid-attempt, so this connection is torn down and closed the
    // moment its own setup succeeds.
    const first = createContendedDatabase({
      onExec: (source) => {
        if (remounted || !/pending_mutations/i.test(source)) return;
        remounted = true;
        void initializeDatabase(second.db);
      },
    });
    first.unlock();

    await initializeDatabase(first.db);
    await vi.advanceTimersByTimeAsync(WHOLE_LADDER_MS);

    // The retarget really did run, and not one of its statements ran while a reader
    // could have been handed the connection SQLiteProvider had already closed.
    expect(handlesSeenDuringRetarget.length).toBeGreaterThan(0);
    expect(handlesSeenDuringRetarget.every((handle) => handle === null)).toBe(true);

    // ...and the chain that gave up on the replacement leaves nothing published, so a
    // reader arriving after it falls back to the network instead of throwing.
    expect(getDatabaseHandle()).toBeNull();
    expect(isSchemaReady()).toBe(false);
    // The give-up is reported as the ordinary lock failure it is — the closed
    // connection never reaches Sentry as a sqlite-init artefact.
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    const [, context] = reportErrorMock.mock.calls[0];
    expect(context.tags).toMatchObject({ kind: 'sqlite-init', sqlite_code: 5 });
  });

  // Where #5355 and #5371 actually meet, and the one path neither could have pinned:
  // #5355 landed the interruptible backoff, #5371 landed the single gated publish, and
  // each was reviewed against a tree without the other. A retarget the WAKE started,
  // superseded again before it finishes, runs the publish gate on a connection the
  // chain reached through the wake rather than through a slept-out gap — so it is the
  // combination, not either change, that has to keep #5366's promise.
  it('never publishes a woken retarget that is superseded before it finishes', async () => {
    vi.useFakeTimers();
    const contended = createContendedDatabase();

    // What the chain ends up on. Every statement it runs must see a null handle: if the
    // gate let the woken (and by then closed) retarget publish, that connection would
    // already be on offer here.
    const handlesSeenAfterSupersede: unknown[] = [];
    const newest = createContendedDatabase({
      onExec: () => {
        handlesSeenAfterSupersede.push(getDatabaseHandle());
      },
    });
    newest.unlock();

    // The connection the wake retargets onto — closed out from under it by a third
    // mount while its own setup is still running.
    let supersededOnce = false;
    const replacement = createContendedDatabase({
      onExec: (source) => {
        if (supersededOnce || !/pending_mutations/i.test(source)) return;
        supersededOnce = true;
        void initializeDatabase(newest.db);
      },
    });
    replacement.unlock();

    await initializeDatabase(contended.db);
    // Park the chain in the first slow gap — the window a remount is invisible in
    // without the wake, and the reason #5355 exists.
    await vi.advanceTimersByTimeAsync(FAST_LADDER_MS);
    expect(getDatabaseHandle()).toBeNull();

    // The wake ends the gap and the loop retargets onto `replacement`.
    await initializeDatabase(replacement.db);
    await vi.advanceTimersByTimeAsync(1);

    // The interleaving really happened: without this the assertions below hold
    // vacuously against a chain that simply woke onto a connection nothing superseded.
    expect(supersededOnce).toBe(true);
    expect(handlesSeenAfterSupersede.length).toBeGreaterThan(0);
    expect(handlesSeenAfterSupersede.every((handle) => handle === null)).toBe(true);
    expect(getDatabaseHandle()).toBe(newest.db);
    expect(isSchemaReady()).toBe(true);
  });

  // #5366: the other half. Once the refunds run out the guard used to fall through to
  // the SUCCESS path, publishing the superseded connection as ready with no report at
  // all — the same dead storage as a give-up, and less diagnosable than the bug #5336
  // fixed.
  it('reports rather than publishes when the superseded restarts run out', async () => {
    // Five mounts, each superseding the one before mid-attempt: four refunds are
    // asked for and only three exist.
    const live = createContendedDatabase();
    live.unlock();
    const supersedingChain = [live];
    for (let index = 0; index < 4; index += 1) {
      const next = supersedingChain[0];
      let remounted = false;
      const earlier = createContendedDatabase({
        onExec: (source) => {
          if (remounted || !/pending_mutations/i.test(source)) return;
          remounted = true;
          void initializeDatabase(next.db);
        },
      });
      earlier.unlock();
      supersedingChain.unshift(earlier);
    }

    await initializeDatabase(supersedingChain[0].db);
    await vi.waitFor(() => {
      expect(reportErrorMock).toHaveBeenCalled();
    });

    // Nothing published: every connection this chain prepared was closed behind it,
    // and the live one was never reached.
    expect(getDatabaseHandle()).toBeNull();
    expect(isSchemaReady()).toBe(false);
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    const [, context] = reportErrorMock.mock.calls[0];
    // Its own kind: there was no lock here, and #4314 reads `sqlite-init` to decide
    // whether the lock problem is fixed.
    expect(context.tags).toMatchObject({ source: 'offline-sync', kind: 'sqlite-init-superseded' });
    expect(context.extra).toMatchObject({ attempts: 4, restarts: 3 });
    // Outrunning a remount loop is not recovering from contention.
    expect(trackMock).not.toHaveBeenCalled();
  });

  // The readiness store is what `useSQLiteContext()` consumers gate their writes on,
  // and they cannot see the handle at all. A null handle that still reads ready is the
  // shape #5366 produced: `schemaReady: true` with every query throwing.
  it('keeps schema readiness false for as long as the handle is null', async () => {
    vi.useFakeTimers();
    const contended = createContendedDatabase();

    await initializeDatabase(contended.db);
    expect(getDatabaseHandle()).toBeNull();
    expect(isSchemaReady()).toBe(false);

    // Still null after the whole window is spent, and still not ready.
    await vi.advanceTimersByTimeAsync(WHOLE_LADDER_MS);
    expect(getDatabaseHandle()).toBeNull();
    expect(isSchemaReady()).toBe(false);

    // ...and it only turns true against a handle a later mount actually publishes.
    const healthy = createContendedDatabase();
    healthy.unlock();
    await initializeDatabase(healthy.db);
    expect(getDatabaseHandle()).toBe(healthy.db);
    expect(isSchemaReady()).toBe(true);
  });

  // The exit invariant behind the publish gate: a chain that stops must not leave a
  // superseded connection published, whoever published it. Driven through the exported
  // setter — the same seam the teardown test above uses — because with the single
  // gated publish nothing inside the lifecycle can reach this state any more, and that
  // is exactly the property a future second publish site would break.
  it('retracts a superseded handle on the way out of a give-up', async () => {
    vi.useFakeTimers();
    const contended = createContendedDatabase();
    const stale = createContendedDatabase();

    await initializeDatabase(contended.db);

    // Published behind the chain's back, against a connection that is not the live one.
    setDatabaseHandle(stale.db);
    expect(getDatabaseHandle()).toBe(stale.db);

    await vi.advanceTimersByTimeAsync(WHOLE_LADDER_MS);

    expect(getDatabaseHandle()).toBeNull();
    expect(isSchemaReady()).toBe(false);
  });
});
