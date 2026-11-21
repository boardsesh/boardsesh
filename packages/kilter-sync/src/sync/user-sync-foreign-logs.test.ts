import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// syncKilterUserData reports the logs it refused because another Boardsesh
// user owns them (#6687).
//
// Two Boardsesh accounts linked to one Kilter account: the first one's ticks
// carry every kilter_id, so applyLogs skips each of them for the second. That
// used to be log-only, so the second account's card said Connected over an
// empty logbook. The count is what the runner turns into a sync_error.
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => ({ ops: [] as Array<Record<string, unknown>> }));

vi.mock('../api/powersync-client', () => ({
  streamKilterPowerSync: async (args: { onOp: (op: Record<string, unknown>) => void | Promise<void> }) => {
    for (const op of hoisted.ops) {
      await args.onOp(op);
    }
  },
}));

// The real one fetches a remote JWKS; its sub must match the fixtures' user_uuid.
vi.mock('../api/keycloak', () => ({
  verifyKeycloakToken: async () => ({ sub: 'kilter-sub' }),
}));

import { auroraCredentials, boardClimbRatings, boardseshTicks } from '@boardsesh/db/schema';
import { FOREIGN_BOARD_ACCOUNT_LOGBOOK_SYNC_ERROR } from '@boardsesh/shared-schema/sync-error-codes';
import { SyncRunner } from '../runner/sync-runner';
import type { KilterCredentialRecord, RunCycleOptions, RunnerDb } from '../runner/types';

import { syncKilterUserData } from './user-sync';

type SyncArgs = Parameters<typeof syncKilterUserData>[0];

// STREAM_FLUSH_THRESHOLD in user-sync.ts: the buffer size that triggers a
// mid-stream flush, so one sync can apply logs in more than one transaction.
const STREAM_FLUSH_THRESHOLD = 500;

function logOp(logUuid: string): Record<string, unknown> {
  return {
    op_id: '1',
    op: 'PUT',
    object_type: 'logs',
    object_id: logUuid,
    data: {
      id: logUuid,
      log_uuid: logUuid,
      climb_uuid: 'climb-A',
      user_uuid: 'kilter-sub',
      gym_uuid: null,
      wall_uuid: null,
      product_layout_uuid: null,
      angle: 40,
      flashed: 0,
      topped: 1,
      attempts: 1,
      created_at: '2026-05-01T12:00:00.000Z',
    },
  };
}

/**
 * Every by-kilter_id lookup finds these logs under ANOTHER Boardsesh user, so
 * applyLogs takes the foreign-skip branch for all of them and writes nothing.
 */
function createDb(foreignLogUuids: string[], failAfterFlush?: 'logs' | 'ratings') {
  const foreignRows = foreignLogUuids.map((kilterId) => ({
    uuid: `tick-${kilterId}`,
    kilterId,
    ownerUserId: 'other-boardsesh-user',
  }));
  const writes: string[] = [];
  const credentialUpdates: Array<Record<string, unknown>> = [];
  const transactions = { count: 0, committedLogFlushes: 0 };
  let logLookups = 0;
  const tx: Record<string, unknown> = {
    execute: () => Promise.resolve([]),
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === boardseshTicks) {
            logLookups += 1;
            if (failAfterFlush === 'logs' && logLookups > 1) throw new Error('simulated later logs failure');
            return Promise.resolve(foreignRows);
          }
          if (table === boardClimbRatings && failAfterFlush === 'ratings') {
            throw new Error('simulated later ratings failure');
          }
          return Promise.resolve([]);
        },
      }),
    }),
    insert: () => {
      writes.push('insert');
      return { values: () => Promise.resolve() };
    },
    update: (table: unknown) => {
      if (table !== auroraCredentials) writes.push('update');
      return {
        set: (payload: Record<string, unknown>) => {
          if (table === auroraCredentials) credentialUpdates.push(payload);
          return { where: () => Object.assign(Promise.resolve(), { returning: () => Promise.resolve([]) }) };
        },
      };
    },
    delete: () => {
      writes.push('delete');
      return { where: () => Promise.resolve() };
    },
  };
  tx.transaction = (fn: (savepoint: unknown) => Promise<unknown>) => fn(tx);
  const runInTransaction = async <Result>(fn: (transaction: unknown) => Promise<Result>): Promise<Result> => {
    transactions.count += 1;
    const logLookupsBefore = logLookups;
    const result = await fn(tx);
    if (logLookups > logLookupsBefore) transactions.committedLogFlushes += 1;
    return result;
  };
  return {
    writes,
    credentialUpdates,
    transactions,
    runInTransaction,
    db: {
      // primeAliasCache: no alias rows, so every climb is its own canonical.
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
      transaction: runInTransaction,
      update: tx.update,
    },
  };
}

/**
 * 501 log ops: the first 500 trigger a mid-stream flush and the last one goes
 * through the end-of-stream flush. Both foreign log_uuids appear in both
 * flushes, so a per-flush sum would report 4 where there are 2 distinct logs.
 */
function opsAcrossTwoFlushes(): Array<Record<string, unknown>> {
  return [
    ...Array.from({ length: STREAM_FLUSH_THRESHOLD }, (_, index) => logOp(index % 2 === 0 ? 'log-F1' : 'log-F2')),
    logOp('log-F1'),
  ];
}

describe('syncKilterUserData — logs owned by another Boardsesh user (#6687)', () => {
  it('counts each foreign log once across flushes on the daemon path', async () => {
    hoisted.ops = opsAcrossTwoFlushes();
    const { db, writes, transactions } = createDb(['log-F1', 'log-F2']);

    const result = await syncKilterUserData({
      db,
      userId: 'user-b',
      accessToken: 'token',
      log: () => {},
    } as unknown as SyncArgs);

    expect(result).toEqual({ skippedForeignCircuits: 0, skippedForeignLogs: 2 });
    // Two logs flushes plus the circuits phase: the count spans both flushes.
    expect(transactions.count).toBeGreaterThanOrEqual(3);
    // Refused means refused: nothing inserted, adopted or detached for user-b.
    expect(writes).toEqual([]);
  });

  it('counts foreign logs on the background-job path too', async () => {
    // A `transaction` runner switches flushLogs to its deferred-stats branch,
    // which collects the result on its own line.
    hoisted.ops = opsAcrossTwoFlushes();
    const { db, runInTransaction } = createDb(['log-F1', 'log-F2']);

    const result = await syncKilterUserData({
      db,
      userId: 'user-b',
      accessToken: 'token',
      log: () => {},
      transaction: runInTransaction,
    } as unknown as SyncArgs);

    expect(result.skippedForeignLogs).toBe(2);
  });

  it.each([
    ['daemon', 'logs'],
    ['daemon', 'ratings'],
    ['deferred', 'logs'],
    ['deferred', 'ratings'],
  ] as const)(
    'keeps the %s cycle failed after a committed foreign-log flush and later %s failure',
    async (path, phase) => {
      hoisted.ops = opsAcrossTwoFlushes();
      if (phase === 'ratings') {
        hoisted.ops.push({
          op_id: 'rating-1',
          op: 'PUT',
          object_type: 'climb_ratings',
          object_id: 'rating-1',
          data: {
            id: 'rating-1',
            climb_rating_uuid: 'rating-1',
            user_uuid: 'kilter-sub',
            climb_uuid: 'climb-A',
            angle: 40,
            rating: 5,
            difficulty_grade_id: null,
            comment: null,
            created_at: '2026-05-01T12:00:00.000Z',
          },
        });
      }
      const { db, credentialUpdates, transactions, runInTransaction } = createDb(['log-F1', 'log-F2'], phase);
      const runner = new SyncRunner({ onLog: () => {}, onError: () => {} });
      const refreshTokenFor = runner as unknown as { refreshTokenFor: () => Promise<string> };
      vi.spyOn(refreshTokenFor, 'refreshTokenFor').mockResolvedValue('token');
      const credential: KilterCredentialRecord = {
        userId: 'user-b',
        boardType: 'kilter',
        encryptedRefreshToken: 'encrypted-test-token',
        syncStatus: 'active',
        syncError: FOREIGN_BOARD_ACCOUNT_LOGBOOK_SYNC_ERROR,
        lastSyncAt: null,
        consecutiveFailures: 0,
      };
      const options: RunCycleOptions = { skipCatalogSync: true };
      if (path === 'deferred') {
        options.transaction = runInTransaction as unknown as NonNullable<RunCycleOptions['transaction']>;
      }

      // Exercise the real importer AND runner: the first flush has committed its
      // foreign-skip result before a later transaction fails. Partial progress
      // must not convert the cycle into an active duplicate-account warning.
      const outcome = await runner.runCycleForCredential(db as unknown as RunnerDb, credential, options);

      expect(transactions.committedLogFlushes).toBeGreaterThan(0);
      expect(outcome.status).toBe('error');
      expect(outcome.error).toContain(`simulated later ${phase} failure`);
      expect(credentialUpdates).toHaveLength(1);
      expect(credentialUpdates[0]).toMatchObject({
        syncStatus: 'error',
        syncError: outcome.error,
        lastSyncError: outcome.error,
      });
      expect(credentialUpdates.some((update) => update.syncStatus === 'active')).toBe(false);
      expect(credentialUpdates[0]).not.toHaveProperty('lastSyncAt');
    },
  );

  it('reports zero when no log belongs to anyone else', async () => {
    hoisted.ops = [];
    const { db } = createDb([]);

    await expect(
      syncKilterUserData({ db, userId: 'user-b', accessToken: 'token', log: () => {} } as unknown as SyncArgs),
    ).resolves.toEqual({ skippedForeignCircuits: 0, skippedForeignLogs: 0 });
  });
});
