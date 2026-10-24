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

import { boardseshTicks } from '@boardsesh/db/schema';

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
function createDb(foreignLogUuids: string[]) {
  const foreignRows = foreignLogUuids.map((kilterId) => ({
    uuid: `tick-${kilterId}`,
    kilterId,
    ownerUserId: 'other-boardsesh-user',
  }));
  const writes: string[] = [];
  const tx: Record<string, unknown> = {
    execute: () => Promise.resolve([]),
    select: () => ({
      from: (table: unknown) => ({
        where: () => Promise.resolve(table === boardseshTicks ? foreignRows : []),
      }),
    }),
    insert: () => {
      writes.push('insert');
      return { values: () => Promise.resolve() };
    },
    update: () => {
      writes.push('update');
      return { set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) };
    },
    delete: () => {
      writes.push('delete');
      return { where: () => Promise.resolve() };
    },
  };
  tx.transaction = (fn: (savepoint: unknown) => Promise<unknown>) => fn(tx);
  const transactions = { count: 0 };
  const runInTransaction = async <Result>(fn: (transaction: unknown) => Promise<Result>): Promise<Result> => {
    transactions.count += 1;
    return fn(tx);
  };
  return {
    writes,
    transactions,
    runInTransaction,
    db: {
      // primeAliasCache: no alias rows, so every climb is its own canonical.
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
      transaction: runInTransaction,
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

  it('reports zero when no log belongs to anyone else', async () => {
    hoisted.ops = [];
    const { db } = createDb([]);

    await expect(
      syncKilterUserData({ db, userId: 'user-b', accessToken: 'token', log: () => {} } as unknown as SyncArgs),
    ).resolves.toEqual({ skippedForeignCircuits: 0, skippedForeignLogs: 0 });
  });
});
