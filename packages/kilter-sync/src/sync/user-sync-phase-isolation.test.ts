import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Phase isolation in syncKilterUserData.
//
// A throw from the ratings phase used to propagate straight out of
// syncKilterUserData, so the circuits phase below it never ran. That is why the
// duplicate-key bug in applyClimbRatings cost affected users their playlist
// sync as well as their ratings — a detail invisible from the error itself,
// since the stack trace only ever named applyClimbRatings.
//
// These tests pin the two halves of the contract: every phase gets its turn,
// and a failure is still reported afterwards rather than swallowed.
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => ({ ops: [] as Array<Record<string, unknown>> }));

vi.mock('../api/powersync-client', () => ({
  streamKilterPowerSync: async (args: { onOp: (op: Record<string, unknown>) => void | Promise<void> }) => {
    for (const op of hoisted.ops) {
      await args.onOp(op);
    }
  },
}));

// The real one fetches a remote JWKS. The sub it returns is what scopes
// incoming circuits, so it has to match the fixtures' user_uuid.
vi.mock('../api/keycloak', () => ({
  verifyKeycloakToken: async () => ({ sub: 'kilter-sub' }),
}));

import { boardClimbRatings, boardseshTicks, playlists } from '@boardsesh/db/schema';

import { syncKilterUserData } from './user-sync';

type SyncArgs = Parameters<typeof syncKilterUserData>[0];

// STREAM_FLUSH_THRESHOLD in user-sync.ts — the buffer size that triggers a
// mid-stream flush, which is what lets one phase fail more than once per cycle.
const STREAM_FLUSH_THRESHOLD = 500;

function ratingOp(uuid = 'kr-1'): Record<string, unknown> {
  return {
    op_id: '1',
    op: 'PUT',
    object_type: 'climb_ratings',
    object_id: uuid,
    data: {
      id: uuid,
      climb_rating_uuid: uuid,
      user_uuid: 'kilter-sub',
      climb_uuid: 'climb-A',
      angle: 40,
      rating: 5,
      difficulty_grade_id: null,
      comment: null,
      created_at: '2026-05-01T12:00:00.000Z',
    },
  };
}

function circuitOp(): Record<string, unknown> {
  return {
    op_id: '2',
    op: 'PUT',
    object_type: 'circuits',
    object_id: 'circuit-1',
    data: {
      id: 'circuit-1',
      circuit_uuid: 'circuit-1',
      name: 'Warmups',
      description: null,
      color: null,
      is_public: 0,
      user_uuid: 'kilter-sub',
      product_layout_uuid: null,
    },
  };
}

/**
 * Minimal db shim.
 *
 * The phase is identified by the TABLE the transaction body touches, never by
 * call order. An earlier version keyed off a transaction counter, which was
 * correct only while flushLogs happened to short-circuit on an empty buffer —
 * an invisible invariant that any future statement opening a transaction ahead
 * of the ratings phase would have silently broken, shifting every assertion
 * without failing the test.
 */
function createDb(failPhase: 'ratings' | 'circuits' | 'none') {
  const phases: string[] = [];

  function phaseOfTable(table: unknown): string | undefined {
    if (table === boardClimbRatings) return 'ratings';
    if (table === playlists) return 'circuits';
    if (table === boardseshTicks) return 'logs';
    return undefined;
  }

  // Any table access inside the transaction body reveals which phase is running.
  // The first recognised table wins, then we either throw or record.
  function makeTx() {
    let settled = false;
    const observe = (table: unknown) => {
      const phase = phaseOfTable(table);
      if (!phase || settled) return;
      settled = true;
      phases.push(failPhase === phase ? `${phase}:threw` : `${phase}:ok`);
      if (failPhase === phase) {
        throw new Error(`simulated ${phase} failure`);
      }
    };
    const tx: Record<string, unknown> = {
      execute: () => Promise.resolve([]),
      select: () => ({
        from: (table: unknown) => {
          observe(table);
          const rows: unknown[] = [];
          return Object.assign(Promise.resolve(rows), {
            where: () => Object.assign(Promise.resolve(rows), { orderBy: () => Promise.resolve(rows) }),
            leftJoin: () => ({ where: () => Promise.resolve(rows) }),
            orderBy: () => Promise.resolve(rows),
          });
        },
      }),
      insert: (table: unknown) => {
        observe(table);
        const chain = {
          onConflictDoUpdate: () =>
            Object.assign(Promise.resolve(), { returning: () => Promise.resolve([{ id: BigInt(1) }]) }),
          onConflictDoNothing: () => Promise.resolve(),
        };
        return { values: () => Object.assign(Promise.resolve(), chain) };
      },
      update: (table: unknown) => {
        observe(table);
        return { set: () => ({ where: () => Promise.resolve() }) };
      },
      delete: (table: unknown) => {
        observe(table);
        return { where: () => Promise.resolve() };
      },
    };
    tx.transaction = (fn: (savepoint: unknown) => Promise<unknown>) => Promise.resolve(fn(tx));
    return tx;
  }

  return {
    phases,
    db: {
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const result = await fn(makeTx());
        return result ?? { skippedForeignCircuits: 0 };
      },
    },
  };
}

describe('syncKilterUserData phase isolation', () => {
  it('still runs the circuits phase when the ratings phase throws', async () => {
    hoisted.ops = [ratingOp(), circuitOp()];
    const { db, phases } = createDb('ratings');

    await expect(
      syncKilterUserData({ db, userId: 'user-1', accessToken: 'token', log: () => {} } as unknown as SyncArgs),
    ).rejects.toThrow(/climb_ratings/);

    // The point of the change: circuits ran anyway. On main the throw escaped
    // before this phase was ever reached.
    expect(phases).toEqual(['ratings:threw', 'circuits:ok']);
  });

  it('reports the failure rather than swallowing it', async () => {
    hoisted.ops = [ratingOp(), circuitOp()];
    const { db } = createDb('ratings');

    // Isolation must not become "pretend it worked" — the runner has to see a
    // failed user, or a permanently broken phase would look healthy forever.
    await expect(
      syncKilterUserData({ db, userId: 'user-1', accessToken: 'token', log: () => {} } as unknown as SyncArgs),
    ).rejects.toThrow(/failed in 1 phase/);
  });

  it('counts a phase that fails twice as one failed phase', async () => {
    // climb_ratings runs once per mid-stream threshold flush AND once at
    // end-of-stream, so the same phase can fail more than once in a cycle.
    // Reporting that as "failed in 2 phase(s)" would overstate the blast radius.
    // One MORE than the threshold: the mid-stream flush drains the buffer at
    // exactly 500, so the spare op is what gives the final flush something to
    // fail on and makes climb_ratings fail twice in one cycle.
    hoisted.ops = [
      ...Array.from({ length: STREAM_FLUSH_THRESHOLD + 1 }, (_, index) => ratingOp(`kr-${index}`)),
      circuitOp(),
    ];
    const { db } = createDb('ratings');

    await expect(
      syncKilterUserData({ db, userId: 'user-1', accessToken: 'token', log: () => {} } as unknown as SyncArgs),
    ).rejects.toThrow(/failed in 1 phase/);
  });

  it('resolves normally when every phase succeeds', async () => {
    hoisted.ops = [ratingOp(), circuitOp()];
    const { db, phases } = createDb('none');

    await expect(
      syncKilterUserData({ db, userId: 'user-1', accessToken: 'token', log: () => {} } as unknown as SyncArgs),
    ).resolves.toEqual({ skippedForeignCircuits: 0 });

    expect(phases).toEqual(['ratings:ok', 'circuits:ok']);
  });
});
