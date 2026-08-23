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

import { syncKilterUserData } from './user-sync';

type SyncArgs = Parameters<typeof syncKilterUserData>[0];

function ratingOp(): Record<string, unknown> {
  return {
    op_id: '1',
    op: 'PUT',
    object_type: 'climb_ratings',
    object_id: 'kr-1',
    data: {
      id: 'kr-1',
      climb_rating_uuid: 'kr-1',
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
 * Minimal db shim. Phases are driven entirely through `db.transaction`, so
 * failing the Nth call is enough to simulate a phase blowing up without needing
 * a real database or stubbing same-module functions.
 */
function createDb(failOnTransaction: number) {
  const phases: string[] = [];
  let transactionCount = 0;
  const emptySelect = {
    from: () => ({ where: () => Promise.resolve([]) }),
  };
  return {
    phases,
    db: {
      select: () => emptySelect,
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        transactionCount += 1;
        // flushLogs returns early on an empty buffer without opening one, so
        // with ratings + circuits ops the order is #1 ratings, #2 circuits.
        const phase = transactionCount === 1 ? 'ratings' : 'circuits';
        if (transactionCount === failOnTransaction) {
          phases.push(`${phase}:threw`);
          throw new Error('simulated ratings failure');
        }
        phases.push(`${phase}:ok`);
        // applyCircuits' return shape; the real function never runs here.
        void fn;
        return { skippedForeignCircuits: 0 };
      },
    },
  };
}

describe('syncKilterUserData phase isolation', () => {
  it('still runs the circuits phase when the ratings phase throws', async () => {
    hoisted.ops = [ratingOp(), circuitOp()];
    // Only ratings and circuits reach a transaction — flushLogs returns early
    // on an empty buffer — so the ratings flush is transaction #1.
    const { db, phases } = createDb(1);

    await expect(
      syncKilterUserData({ db, userId: 'user-1', accessToken: 'token', log: () => {} } as unknown as SyncArgs),
    ).rejects.toThrow(/climb_ratings/);

    // The point of the change: circuits ran anyway. On main the throw escaped
    // before this phase was ever reached.
    expect(phases).toEqual(['ratings:threw', 'circuits:ok']);
  });

  it('reports the failure rather than swallowing it', async () => {
    hoisted.ops = [ratingOp(), circuitOp()];
    const { db } = createDb(1);

    // Isolation must not become "pretend it worked" — the runner has to see a
    // failed user, or a permanently broken phase would look healthy forever.
    await expect(
      syncKilterUserData({ db, userId: 'user-1', accessToken: 'token', log: () => {} } as unknown as SyncArgs),
    ).rejects.toThrow(/failed in 1 phase/);
  });

  it('resolves normally when every phase succeeds', async () => {
    hoisted.ops = [ratingOp(), circuitOp()];
    const { db, phases } = createDb(0);

    await expect(
      syncKilterUserData({ db, userId: 'user-1', accessToken: 'token', log: () => {} } as unknown as SyncArgs),
    ).resolves.toEqual({ skippedForeignCircuits: 0 });

    expect(phases).toEqual(['ratings:ok', 'circuits:ok']);
  });
});
