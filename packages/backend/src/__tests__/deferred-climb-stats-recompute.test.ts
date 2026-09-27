process.env.AURORA_CREDENTIALS_SECRET = process.env.AURORA_CREDENTIALS_SECRET ?? 'test-aurora-secret';

import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '@boardsesh/db/client';
import {
  CLIMB_STATS_RECOMPUTE_BATCH_KEYS,
  DeferredClimbStatsRecompute,
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
  it('runs one transaction per 500 distinct keys, each a seed and an update', async () => {
    const { runBatch, batches } = countingRunner();
    const keys = Array.from({ length: 1_200 }, (_, index) => key(index));

    // Duplicates collapse before batching.
    const recomputed = await recomputeClimbStatsInBatches(runBatch, [...keys, ...keys.slice(0, 50)]);

    expect(recomputed).toBe(1_200);
    expect(CLIMB_STATS_RECOMPUTE_BATCH_KEYS).toBe(500);
    expect(batches).toEqual([2, 2, 2]);
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
    const transaction = {} as ProviderSyncDb;
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

    const { runBatch, batches } = countingRunner();
    expect(await deferred.flush(runBatch)).toBe(2);
    expect(batches).toEqual([2]);
    expect(deferred.pendingKeys).toBe(0);
  });
});

/**
 * Wraps `database.transaction` and, just before each batch commits, records
 * whether the fixture climb has a stats row yet. Only the recompute creates
 * that row, so this shows which transaction ran it.
 */
function statsProbeRunner(climbUuid: string) {
  const statsRowsAtCommit: number[] = [];
  const runBatch = ((callback) =>
    database.transaction(async (transaction) => {
      const result = await callback(transaction);
      const [row] = await transaction.execute<{ count: number }>(
        sql`SELECT count(*)::int AS count FROM board_climb_stats WHERE climb_uuid = ${climbUuid}`,
      );
      statsRowsAtCommit.push(row.count);
      return result;
    })) as SyncBatchRunner;
  return { runBatch, statsRowsAtCommit };
}

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
    const { runBatch, statsRowsAtCommit } = statsProbeRunner(ASCENT_CLIMB);

    await syncUserData(database, FIXTURE_BOARD, 'token', AURORA_USER_ID, ASCENT_USER, {
      transaction: runBatch,
      log: () => {},
    });

    // The page committed with no stats row; the next batch was the recompute,
    // and nothing was left owed.
    expect(statsRowsAtCommit).toEqual([0, 1]);
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

describe('Kilter flush transactions and the stats recompute', () => {
  it('recomputes a logs flush after it commits when a batch runner is injected', async () => {
    await insertLinkedKilterAccount(database, KILTER_USER, KILTER_CLIMB);
    stubKilterPowerSync(KILTER_CLIMB);
    const { runBatch, statsRowsAtCommit } = statsProbeRunner(KILTER_CLIMB);

    await syncKilterUserData({
      db: database,
      userId: KILTER_USER,
      accessToken: 'kilter-access',
      transaction: runBatch,
    });

    // logs flush (no stats yet), its recompute, then ratings and circuits.
    expect(statsRowsAtCommit.slice(0, 2)).toEqual([0, 1]);
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
