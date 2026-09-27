process.env.AURORA_CREDENTIALS_SECRET = process.env.AURORA_CREDENTIALS_SECRET ?? 'test-aurora-secret';

import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '@boardsesh/db/client';
import {
  CLIMB_STATS_RECOMPUTE_BATCH_KEYS,
  DeferredClimbStatsRecompute,
  PENDING_RECOMPUTE_ORPHAN_AGE_MS,
  drainPendingClimbStatsRecomputes,
  markClimbStatsRecomputePending,
  recomputeClimbStatsInBatches,
  type ClimbStatsKey,
  type ProviderSyncDb,
  type SyncBatchRunner,
} from '@boardsesh/db/queries';
import { syncUserData } from '@boardsesh/aurora-sync/sync';
import { syncKilterUserData } from '@boardsesh/kilter-sync';
import {
  AURORA_USER_ID,
  FIXTURE_BOARD,
  fullSyncPage,
  insertLinkedKilterAccount,
  insertLinkedTensionAccount,
  removeFixtures,
  stubAuroraApi,
  stubKilterPowerSync,
} from '../workers/families/__tests__/provider-sync-fixtures';
import { climbStatsSelfHealFamily } from '../workers/families/climb-stats-self-heal';
import type { BackgroundJobContext } from '../workers/families';

// The PowerSync apply checks the access token's signature before it trusts the
// stream; the stand-in token's subject is the fixture's.
vi.mock('../../../kilter-sync/src/api/keycloak.ts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    verifyKeycloakToken: async () => ({ sub: 'psync-kilter-sub', preferredUsername: 'kilter-climber' }),
  };
});

const database = createDb();

/** The self-heal's context on the owner connection: the attempt fence is not under test here. */
function selfHealContext(): BackgroundJobContext {
  return {
    runId: randomUUID(),
    family: 'climb-stats-self-heal',
    signal: new AbortController().signal,
    expiresAt: Date.now() + 15 * 60 * 1000,
    database,
    transaction: (callback) => database.transaction(callback),
    enqueue: async () => {
      throw new Error('enqueue not expected');
    },
  };
}

/** A statement runner that counts statements, for the batch arithmetic. */
function countingRunner() {
  const batches: number[] = [];
  const runBatch = (async (callback) => {
    let statements = 0;
    const transaction = {
      execute: async () => {
        statements += 1;
        return [];
      },
    } as unknown as ProviderSyncDb;
    const result = await callback(transaction);
    batches.push(statements);
    return result;
  }) as SyncBatchRunner;
  return { runBatch, batches };
}

const key = (index: number): ClimbStatsKey => ({ boardType: 'tension', climbUuid: `climb-${index}`, angle: 40 });

describe('recomputeClimbStatsInBatches', () => {
  it('runs one transaction per 500 distinct keys: upsert-and-lock the markers, seed, update, clear', async () => {
    const { runBatch, batches } = countingRunner();
    const keys = Array.from({ length: 1_200 }, (_, index) => key(index));

    // Duplicates collapse before batching.
    const recomputed = await recomputeClimbStatsInBatches(runBatch, [...keys, ...keys.slice(0, 50)]);

    expect(recomputed).toBe(1_200);
    expect(CLIMB_STATS_RECOMPUTE_BATCH_KEYS).toBe(500);
    expect(batches).toEqual([4, 4, 4]);
  });

  it('opens no transaction for no keys', async () => {
    const { runBatch, batches } = countingRunner();
    expect(await recomputeClimbStatsInBatches(runBatch, [])).toBe(0);
    expect(batches).toEqual([]);
  });
});

describe('DeferredClimbStatsRecompute', () => {
  it('forgets the keys of a write transaction that did not commit', async () => {
    const deferred = new DeferredClimbStatsRecompute();
    let marks = 0;
    // Each collect marks its keys pending in the page's own transaction.
    const transaction = {
      execute: async () => {
        marks += 1;
        return [];
      },
    } as unknown as ProviderSyncDb;
    deferred.begin();
    await deferred.collect(transaction, [key(1), key(2)]);
    // The batch rolled back and runs again: only the retry's keys count.
    deferred.begin();
    await deferred.collect(transaction, [key(3)]);
    deferred.commit();
    deferred.begin();
    await deferred.collect(transaction, [key(3), key(4)]);
    deferred.commit();
    expect(deferred.pendingKeys).toBe(2);
    expect(marks).toBe(3);

    const { runBatch, batches } = countingRunner();
    expect(await deferred.flush(runBatch)).toBe(2);
    expect(batches).toEqual([4]);
    expect(deferred.pendingKeys).toBe(0);
  });

  it('keeps the keys of the batches that did not commit, so a retried flush still recomputes them', async () => {
    const deferred = new DeferredClimbStatsRecompute();
    const transaction = { execute: async () => [] } as unknown as ProviderSyncDb;
    deferred.begin();
    await deferred.collect(
      transaction,
      Array.from({ length: 5 }, (_, index) => key(index)),
    );
    deferred.commit();

    // Batches of two: the first commits, the second throws mid-flush.
    let batch = 0;
    const failingSecond = (async (callback) => {
      batch += 1;
      if (batch === 2) throw new Error('connection dropped');
      return callback(transaction);
    }) as SyncBatchRunner;
    await expect(deferred.flush(failingSecond, 2)).rejects.toThrow('connection dropped');
    expect(deferred.pendingKeys).toBe(3);

    const { runBatch, batches } = countingRunner();
    expect(await deferred.flush(runBatch, 2)).toBe(3);
    expect(batches).toEqual([4, 4]);
    expect(deferred.pendingKeys).toBe(0);
  });
});

/**
 * Wraps `database.transaction` and, just before each batch commits, records
 * whether the fixture climb has a stats row yet and how many of its keys are
 * marked pending. Only the recompute creates the stats row, so this shows
 * which transaction ran it. `failOnBatch` makes that batch throw instead, as a
 * worker dying between a page and its flush would.
 */
function statsProbeRunner(climbUuid: string, failOnBatch?: number) {
  const statsRowsAtCommit: number[] = [];
  const pendingAtCommit: number[] = [];
  let batch = 0;
  const runBatch = ((callback) => {
    batch += 1;
    if (batch === failOnBatch) return Promise.reject(new Error('worker stopped'));
    return database.transaction(async (transaction) => {
      const result = await callback(transaction);
      const [row] = await transaction.execute<{ stats: number; pending: number }>(sql`
        SELECT (SELECT count(*)::int FROM board_climb_stats WHERE climb_uuid = ${climbUuid}) AS stats,
               (SELECT count(*)::int FROM climb_stats_recompute_pending WHERE climb_uuid = ${climbUuid}) AS pending`);
      statsRowsAtCommit.push(row.stats);
      pendingAtCommit.push(row.pending);
      return result;
    });
  }) as SyncBatchRunner;
  return { runBatch, statsRowsAtCommit, pendingAtCommit };
}

const countRows = async (table: 'board_climb_stats' | 'climb_stats_recompute_pending', climbUuid: string) =>
  (
    await database.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM ${sql.identifier(table)} WHERE climb_uuid = ${climbUuid}`,
    )
  )[0].count;

/** Age a key's pending row past the drain's cutoff, derived from the cutoff itself. */
async function backdatePending(climbUuid: string): Promise<void> {
  const agedSeconds = (PENDING_RECOMPUTE_ORPHAN_AGE_MS + 60_000) / 1000;
  await database.execute(sql`
    UPDATE climb_stats_recompute_pending
       SET requested_at = now() - make_interval(secs => ${agedSeconds}::double precision)
     WHERE climb_uuid = ${climbUuid}`);
}

const ascensionistCount = async (climbUuid: string) =>
  (
    await database.execute<{ count: number }>(sql`
      SELECT coalesce(sum(ascensionist_count), 0)::int AS count FROM board_climb_stats
       WHERE climb_uuid = ${climbUuid}`)
  )[0].count;

const ASCENT_USER = 'psync-deferred-aurora';
const ASCENT_CLIMB = 'psync-climb-deferred';
const KILTER_USER = 'psync-deferred-kilter';
const KILTER_CLIMB = 'psync-kclimb-deferred';

beforeEach(async () => {
  await removeFixtures(database, [ASCENT_USER, KILTER_USER], [ASCENT_CLIMB, KILTER_CLIMB]);
});
afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await removeFixtures(database, [ASCENT_USER, KILTER_USER], [ASCENT_CLIMB, KILTER_CLIMB]);
});

describe('Aurora page transactions and the stats recompute', () => {
  it('recomputes after the page commits, in its own transaction, when a batch runner is injected', async () => {
    await insertLinkedTensionAccount(database, ASCENT_USER, ASCENT_CLIMB);
    stubAuroraApi({ pages: [fullSyncPage(ASCENT_CLIMB)] });
    const { runBatch, statsRowsAtCommit, pendingAtCommit } = statsProbeRunner(ASCENT_CLIMB);

    await syncUserData(database, FIXTURE_BOARD, 'token', AURORA_USER_ID, ASCENT_USER, {
      transaction: runBatch,
      log: () => {},
    });

    // The page committed with no stats row and its key marked pending; the next
    // batch recomputed it and cleared the mark.
    expect(statsRowsAtCommit).toEqual([0, 1]);
    expect(pendingAtCommit).toEqual([1, 0]);
    expect(await countRows('climb_stats_recompute_pending', ASCENT_CLIMB)).toBe(0);
  });

  it('leaves the key marked when the worker stops before the flush, and the self-heal drains it', async () => {
    await insertLinkedTensionAccount(database, ASCENT_USER, ASCENT_CLIMB);
    stubAuroraApi({ pages: [fullSyncPage(ASCENT_CLIMB)] });
    // The page commits; the recompute batch after it never runs.
    const { runBatch } = statsProbeRunner(ASCENT_CLIMB, 2);

    await expect(
      syncUserData(database, FIXTURE_BOARD, 'token', AURORA_USER_ID, ASCENT_USER, {
        transaction: runBatch,
        log: () => {},
      }),
    ).rejects.toThrow('worker stopped');

    // A first-link climb with no stats row yet: invisible to the tick scan,
    // but its key survived the crash.
    expect(await countRows('climb_stats_recompute_pending', ASCENT_CLIMB)).toBe(1);
    expect(await countRows('board_climb_stats', ASCENT_CLIMB)).toBe(0);

    // A fresh mark belongs to a live flush: the self-heal leaves it for two minutes.
    await climbStatsSelfHealFamily.execute(selfHealContext(), {});
    expect(await countRows('climb_stats_recompute_pending', ASCENT_CLIMB)).toBe(1);

    await backdatePending(ASCENT_CLIMB);
    await climbStatsSelfHealFamily.execute(selfHealContext(), {});

    expect(await countRows('climb_stats_recompute_pending', ASCENT_CLIMB)).toBe(0);
    expect(await countRows('board_climb_stats', ASCENT_CLIMB)).toBe(1);
  });

  it('climb-stats-self-heal re-derives a stats row a tick outran (the tick scan)', async () => {
    await insertLinkedTensionAccount(database, ASCENT_USER, ASCENT_CLIMB);
    stubAuroraApi({ pages: [fullSyncPage(ASCENT_CLIMB)] });
    await syncUserData(database, FIXTURE_BOARD, 'token', AURORA_USER_ID, ASCENT_USER, {
      transaction: (callback) => database.transaction(callback),
      log: () => {},
    });
    const [healthy] = await database.execute<{ row: Record<string, unknown> }>(sql`
      SELECT to_jsonb(s) AS row FROM board_climb_stats s WHERE climb_uuid = ${ASCENT_CLIMB}`);
    expect(healthy).toBeDefined();

    // A dropped debounced recompute: the stats row carries a wrong total and is
    // older than the tick. No pending row, so only the tick scan can find it.
    // Re-inserted rather than updated so no trigger restamps updated_at.
    const stale = { ...healthy.row, ascensionist_count: Number(healthy.row.ascensionist_count) + 7 };
    await database.execute(sql`DELETE FROM board_climb_stats WHERE climb_uuid = ${ASCENT_CLIMB}`);
    await database.execute(sql`
      INSERT INTO board_climb_stats
      SELECT (jsonb_populate_record(NULL::board_climb_stats, ${JSON.stringify(stale)}::jsonb)).*`);
    await database.execute(sql`
      UPDATE board_climb_stats SET updated_at = now() - interval '1 hour' WHERE climb_uuid = ${ASCENT_CLIMB}`);
    expect(await countRows('climb_stats_recompute_pending', ASCENT_CLIMB)).toBe(0);
    expect(await ascensionistCount(ASCENT_CLIMB)).toBe(Number(healthy.row.ascensionist_count) + 7);

    await climbStatsSelfHealFamily.execute(selfHealContext(), {});

    expect(await ascensionistCount(ASCENT_CLIMB)).toBe(Number(healthy.row.ascensionist_count));
  });

  it('keeps the daemon behaviour: the recompute stays inside the page transaction', async () => {
    await insertLinkedTensionAccount(database, ASCENT_USER, ASCENT_CLIMB);
    stubAuroraApi({ pages: [fullSyncPage(ASCENT_CLIMB)] });
    const { runBatch, statsRowsAtCommit } = statsProbeRunner(ASCENT_CLIMB);

    await syncUserData(database, FIXTURE_BOARD, 'token', AURORA_USER_ID, ASCENT_USER, {
      transaction: runBatch,
      deferStatsRecompute: false,
      log: () => {},
    });

    expect(statsRowsAtCommit).toEqual([1]);
  });
});

describe('climb_stats_recompute_pending orphan clock', () => {
  const PENDING_CLIMB = 'psync-pending-clock';

  afterEach(async () => {
    await database.execute(sql`DELETE FROM climb_stats_recompute_pending WHERE climb_uuid = ${PENDING_CLIMB}`);
  });

  it('keeps the oldest requested_at when a key is marked again', async () => {
    const pendingKey: ClimbStatsKey = { boardType: 'tension', climbUuid: PENDING_CLIMB, angle: 40 };
    await database.transaction((transaction) => markClimbStatsRecomputePending(transaction, [pendingKey]));
    await backdatePending(PENDING_CLIMB);

    // A page re-marks the key: it must not look freshly requested, or a key
    // that keeps being written would never age past the drain's cutoff.
    await database.transaction((transaction) => markClimbStatsRecomputePending(transaction, [pendingKey]));

    const [row] = await database.execute<{ age_ms: number }>(sql`
      SELECT (extract(epoch FROM now() - requested_at) * 1000)::float8 AS age_ms
        FROM climb_stats_recompute_pending WHERE climb_uuid = ${PENDING_CLIMB}`);
    expect(Number(row.age_ms)).toBeGreaterThan(PENDING_RECOMPUTE_ORPHAN_AGE_MS);
  });
});

describe('a recompute batch racing a sync page', () => {
  const dialect = new PgDialect();
  const statementText = (query: SQL | string) => (typeof query === 'string' ? query : dialect.sqlToQuery(query).sql);

  it('keeps the marker a page writes between the recompute and its DELETE, for the next drain', async () => {
    await insertLinkedTensionAccount(database, ASCENT_USER, ASCENT_CLIMB);
    // The stale-scan path: the key has no pending row when its batch starts.
    const raceKey: ClimbStatsKey = { boardType: FIXTURE_BOARD, climbUuid: ASCENT_CLIMB, angle: 40 };
    expect(await countRows('climb_stats_recompute_pending', ASCENT_CLIMB)).toBe(0);

    let page: Promise<void> | undefined;
    let pageWaited = false;
    const runBatch = ((callback) =>
      database.transaction((transaction) => {
        const intercepted = new Proxy(transaction, {
          get(target, property, receiver) {
            if (property !== 'execute') return Reflect.get(target, property, receiver);
            return async (query: SQL) => {
              if (!page && statementText(query).includes('DELETE FROM climb_stats_recompute_pending')) {
                // The recompute has read the ticks; a page now changes a tick
                // and marks the key, in its own transaction.
                page = database.transaction((pageTransaction) =>
                  markClimbStatsRecomputePending(pageTransaction, [raceKey]),
                );
                pageWaited = await Promise.race([
                  page.then(() => false),
                  new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 300)),
                ]);
              }
              return target.execute(query);
            };
          },
        });
        return callback(intercepted);
      })) as SyncBatchRunner;

    await recomputeClimbStatsInBatches(runBatch, [raceKey]);
    await page;

    // The page's upsert waited on the batch's marker lock, so its marker landed
    // after the DELETE and survives.
    expect(pageWaited).toBe(true);
    expect(await countRows('climb_stats_recompute_pending', ASCENT_CLIMB)).toBe(1);

    // The next pass takes it.
    await drainPendingClimbStatsRecomputes((callback) => database.transaction(callback), { olderThanMs: 0 });
    expect(await countRows('climb_stats_recompute_pending', ASCENT_CLIMB)).toBe(0);
  });
});

describe('Kilter flush transactions and the stats recompute', () => {
  it('recomputes a logs flush after it commits when a batch runner is injected', async () => {
    await insertLinkedKilterAccount(database, KILTER_USER, KILTER_CLIMB);
    stubKilterPowerSync(KILTER_CLIMB);
    const { runBatch, statsRowsAtCommit, pendingAtCommit } = statsProbeRunner(KILTER_CLIMB);

    await syncKilterUserData({
      db: database,
      userId: KILTER_USER,
      accessToken: 'kilter-access',
      transaction: runBatch,
    });

    // logs flush (no stats yet, key marked), its recompute, then ratings and circuits.
    expect(statsRowsAtCommit.slice(0, 2)).toEqual([0, 1]);
    expect(pendingAtCommit.slice(0, 2)).toEqual([1, 0]);
  });

  it('leaves the key marked when the worker stops before the flush, and the self-heal drains it', async () => {
    await insertLinkedKilterAccount(database, KILTER_USER, KILTER_CLIMB);
    stubKilterPowerSync(KILTER_CLIMB);
    // The logs flush commits; the recompute batch after it never runs.
    const { runBatch } = statsProbeRunner(KILTER_CLIMB, 2);

    await expect(
      syncKilterUserData({ db: database, userId: KILTER_USER, accessToken: 'kilter-access', transaction: runBatch }),
    ).rejects.toThrow();

    expect(await countRows('climb_stats_recompute_pending', KILTER_CLIMB)).toBe(1);
    expect(await countRows('board_climb_stats', KILTER_CLIMB)).toBe(0);

    await backdatePending(KILTER_CLIMB);
    await climbStatsSelfHealFamily.execute(selfHealContext(), {});

    expect(await countRows('climb_stats_recompute_pending', KILTER_CLIMB)).toBe(0);
    expect(await countRows('board_climb_stats', KILTER_CLIMB)).toBe(1);
  });

  it('keeps the daemon behaviour for Kilter too', async () => {
    await insertLinkedKilterAccount(database, KILTER_USER, KILTER_CLIMB);
    stubKilterPowerSync(KILTER_CLIMB);
    const { runBatch, statsRowsAtCommit } = statsProbeRunner(KILTER_CLIMB);

    await syncKilterUserData({
      db: database,
      userId: KILTER_USER,
      accessToken: 'kilter-access',
      transaction: runBatch,
      deferStatsRecompute: false,
    });

    expect(statsRowsAtCommit[0]).toBe(1);
  });
});
