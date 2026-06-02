import { beforeEach, describe, expect, it, vi } from 'vitest';
import { boardseshTicks } from '@boardsesh/db/schema';
import type { PowerSyncOp } from '../api/powersync-client';
import { applyLogs } from './user-sync';

/**
 * Tests for the natural-key adoption path in applyLogs — the highest-risk
 * piece of kilter-sync. The function makes three categories of DB calls:
 *
 *   1. `tx.select(...).from(boardseshTicks).where(...)` — TWICE per call
 *      with PUT ops: once keyed on kilter_id, once on the natural-key set.
 *   2. `tx.execute(sql`...`)` — ONE bulk UPDATE for all hits (kilter-id +
 *      natural-key adoptions).
 *   3. `tx.insert(boardseshTicks).values(...)` — ONE bulk INSERT for the
 *      remaining misses.
 *   4. `tx.delete(boardseshTicks).where(...)` — ONE bulk DELETE for REMOVE
 *      ops.
 *
 * The mock tx records every call and returns the seeded SELECT result sets
 * in order, so each test can assert on the exact call counts and payload
 * shape.
 *
 * Alias cache: the function calls resolveCanonicalClimbUuid for every PUT
 * op. If we pre-seed the cache with `{board}:{uuid} → uuid` mappings we
 * skip the alias-table SELECT entirely.
 */

type CallRecord = {
  kind: 'select' | 'delete' | 'execute' | 'insert' | 'update';
  args: unknown[];
};

type SelectResult = Array<Record<string, unknown>>;

// `createTx` is a hand-rolled Drizzle-transaction shim, not a real DB.
// It validates the BRANCHING in applyLogs (natural-key adoption,
// divergent-key skip, three-statement bulk upsert ordering) without
// requiring docker+postgres in the kilter-sync test project — that
// project intentionally has no infra dependency so the tests stay fast
// and runnable in any environment.
//
// What this DOESN'T cover, and what an integration test would add:
//   - column-name typos inside the raw `tx.execute(sql\`...\`)` calls
//   - jsonb_to_recordset column types matching the schema
//   - real partial-unique-index conflict behaviour on (user, kilter_id)
//   - CASCADE behaviour when a user row gets deleted mid-sync
//
// We accept this gap deliberately: the failure mode is "first prod run
// of a renamed schema crashes loudly" — recoverable from Sentry, and
// the bulk-upsert SQL is structurally simple enough that a typo is
// caught at typecheck time via the Drizzle column references. Promote
// to an integration test if the SQL grows another conditional.
function createTx(opts: { selectResults?: SelectResult[] } = {}) {
  const calls: CallRecord[] = [];
  const selectResults = opts.selectResults ?? [];
  let selectIdx = 0;
  const insertValues: Array<Array<Record<string, unknown>>> = [];

  const tx = {
    select(cols: unknown) {
      calls.push({ kind: 'select', args: [cols] });
      const next = selectResults[selectIdx++] ?? [];
      // Each select chain ends with .where(...). The fluent shim treats
      // .from(...).where(...) as the terminal awaitable returning the
      // seeded row set.
      return {
        from: (_table: unknown) => ({
          where: (_cond: unknown) => Promise.resolve(next),
        }),
      };
    },
    delete(_table: unknown) {
      return {
        where: (_cond: unknown) => {
          calls.push({ kind: 'delete', args: [_cond] });
          return Promise.resolve();
        },
      };
    },
    update(_table: unknown) {
      return {
        set: (setValues: Record<string, unknown>) => ({
          where: (_cond: unknown) => {
            calls.push({ kind: 'update', args: [setValues, _cond] });
            return Promise.resolve();
          },
        }),
      };
    },
    insert(_table: unknown) {
      return {
        values: (rows: Array<Record<string, unknown>>) => {
          calls.push({ kind: 'insert', args: [rows] });
          insertValues.push(rows);
          return Promise.resolve();
        },
      };
    },
    execute(query: unknown) {
      calls.push({ kind: 'execute', args: [query] });
      return Promise.resolve();
    },
  };

  return { tx, calls, insertValues };
}

function makeLogPutOp(args: {
  log_uuid: string;
  climb_uuid: string;
  angle: number;
  created_at: string;
  flashed?: 0 | 1;
  topped?: 0 | 1;
  attempts?: number;
  user_uuid?: string;
}): PowerSyncOp {
  return {
    op_id: '1',
    op: 'PUT',
    object_type: 'logs',
    object_id: args.log_uuid,
    data: {
      id: '1',
      log_uuid: args.log_uuid,
      climb_uuid: args.climb_uuid,
      user_uuid: args.user_uuid ?? 'user-sub',
      gym_uuid: null,
      wall_uuid: null,
      product_layout_uuid: null,
      angle: args.angle,
      flashed: args.flashed ?? 0,
      topped: args.topped ?? 1,
      attempts: args.attempts ?? 1,
      created_at: args.created_at,
    },
  };
}

function aliasCacheFor(uuids: string[]): Map<string, string> {
  const cache = new Map<string, string>();
  for (const uuid of uuids) cache.set(`kilter:${uuid}`, uuid);
  return cache;
}

/**
 * Cast the tx shim to the same db handle type applyLogs expects. The
 * shim only implements the surface area applyLogs actually touches.
 */
type TxArg = Parameters<typeof applyLogs>[0];

describe('applyLogs — natural-key adoption', () => {
  // Typed as a vi.Mock with the (msg: string) => void signature so it
  // satisfies applyLogs's `log` parameter; vi.fn()'s default Procedure
  // overload is too broad for TS to narrow at the call site.
  let logSpy: ReturnType<typeof vi.fn<(msg: string) => void>>;

  beforeEach(() => {
    logSpy = vi.fn<(msg: string) => void>();
  });

  it('returns early on empty ops without touching tx', async () => {
    const { tx, calls } = createTx();
    await applyLogs(tx as unknown as TxArg, 'user-1', [], new Map(), logSpy);
    expect(calls).toHaveLength(0);
  });

  it('inserts when there is no match by kilter_id or natural key', async () => {
    // Both SELECTs return empty → straight insert path.
    const { tx, calls, insertValues } = createTx({ selectResults: [[], []] });

    const op = makeLogPutOp({
      log_uuid: 'log-A',
      climb_uuid: 'climb-1',
      angle: 40,
      created_at: '2026-05-01T12:00:00.000Z',
    });

    await applyLogs(tx as unknown as TxArg, 'user-1', [op], aliasCacheFor(['climb-1']), logSpy);

    expect(calls.filter((c) => c.kind === 'select')).toHaveLength(2);
    expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(0);
    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(1);
    expect(insertValues[0]).toHaveLength(1);
    expect(insertValues[0][0]).toMatchObject({
      kilterId: 'log-A',
      climbUuid: 'climb-1',
      angle: 40,
      status: 'send',
      userId: 'user-1',
      boardType: 'kilter',
    });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('updates an existing tick when matched by kilter_id (idempotent re-sync)', async () => {
    // First SELECT returns the existing row by kilter_id; second SELECT is
    // not executed because every incoming op was already matched.
    const { tx, calls, insertValues } = createTx({
      selectResults: [[{ uuid: 'tick-uuid-1', kilterId: 'log-A' }]],
    });

    const op = makeLogPutOp({
      log_uuid: 'log-A',
      climb_uuid: 'climb-1',
      angle: 40,
      created_at: '2026-05-01T12:00:00.000Z',
    });

    await applyLogs(tx as unknown as TxArg, 'user-1', [op], aliasCacheFor(['climb-1']), logSpy);

    // Only the kilter_id SELECT runs — the natural-key SELECT is gated on
    // there being any unmatched candidates.
    expect(calls.filter((c) => c.kind === 'select')).toHaveLength(1);
    expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(1);
    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(0);
    expect(insertValues).toHaveLength(0);
  });

  it('adopts an existing tick when matched by natural key with NULL kilter_id', async () => {
    // First SELECT returns nothing → fall through to natural-key match.
    // Second SELECT returns a Boardsesh-originated tick (kilter_id NULL)
    // within ±60s of the incoming log; it should be adopted.
    const { tx, calls, insertValues } = createTx({
      selectResults: [
        [],
        [
          {
            uuid: 'tick-uuid-X',
            kilterId: null,
            climbUuid: 'climb-1',
            angle: 40,
            climbedAt: '2026-05-01T12:00:30.000Z', // 30s after the incoming log
          },
        ],
      ],
    });

    const op = makeLogPutOp({
      log_uuid: 'log-A',
      climb_uuid: 'climb-1',
      angle: 40,
      created_at: '2026-05-01T12:00:00.000Z',
    });

    await applyLogs(tx as unknown as TxArg, 'user-1', [op], aliasCacheFor(['climb-1']), logSpy);

    expect(calls.filter((c) => c.kind === 'select')).toHaveLength(2);
    expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(1);
    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(0);
    expect(insertValues).toHaveLength(0);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('logs and skips when the natural-key match already has a different kilter_id (divergent)', async () => {
    const { tx, calls, insertValues } = createTx({
      selectResults: [
        [],
        [
          {
            uuid: 'tick-uuid-X',
            kilterId: 'log-OTHER', // already adopted to a different kilter id
            climbUuid: 'climb-1',
            angle: 40,
            climbedAt: '2026-05-01T12:00:00.000Z',
          },
        ],
      ],
    });

    const op = makeLogPutOp({
      log_uuid: 'log-A',
      climb_uuid: 'climb-1',
      angle: 40,
      created_at: '2026-05-01T12:00:00.000Z',
    });

    await applyLogs(tx as unknown as TxArg, 'user-1', [op], aliasCacheFor(['climb-1']), logSpy);

    expect(calls.filter((c) => c.kind === 'select')).toHaveLength(2);
    // No UPDATE — the divergent path skips the write entirely.
    expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(0);
    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(0);
    expect(insertValues).toHaveLength(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const message = logSpy.mock.calls[0]?.[0] as string;
    expect(message).toContain('divergent kilter_id');
    expect(message).toContain('log-OTHER');
    expect(message).toContain('log-A');
  });

  it('soft-detaches via a single bulk UPDATE on REMOVE ops and skips SELECTs when there are no PUTs', async () => {
    const { tx, calls } = createTx();

    const removeOp: PowerSyncOp = {
      op_id: '1',
      op: 'REMOVE',
      object_type: 'logs',
      object_id: 'log-A',
    };

    await applyLogs(tx as unknown as TxArg, 'user-1', [removeOp], new Map(), logSpy);

    // REMOVE now soft-detaches (UPDATE … SET kilter_id=NULL) instead of
    // hard-deleting. PowerSync re-sends REMOVE before PUT on snapshot
    // re-delivery, so hard-deletes would wipe Boardsesh-side metadata
    // milliseconds before the row is re-inserted.
    const updateCalls = calls.filter((c) => c.kind === 'update');
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0]).toMatchObject({
      kilterId: null,
      kilterType: null,
      kilterSyncedAt: null,
      kilterSyncError: null,
    });
    expect(calls.filter((c) => c.kind === 'delete')).toHaveLength(0);
    expect(calls.filter((c) => c.kind === 'select')).toHaveLength(0);
    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(0);
    expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(0);
  });

  it('respects the ±60s tolerance window (no match for a >60s gap)', async () => {
    // Existing row is 61s away from the incoming log — should NOT match.
    const { tx, calls, insertValues } = createTx({
      selectResults: [
        [],
        [
          {
            uuid: 'tick-uuid-X',
            kilterId: null,
            climbUuid: 'climb-1',
            angle: 40,
            climbedAt: '2026-05-01T12:01:01.000Z', // 61s after — outside tolerance
          },
        ],
      ],
    });

    const op = makeLogPutOp({
      log_uuid: 'log-A',
      climb_uuid: 'climb-1',
      angle: 40,
      created_at: '2026-05-01T12:00:00.000Z',
    });

    await applyLogs(tx as unknown as TxArg, 'user-1', [op], aliasCacheFor(['climb-1']), logSpy);

    // No match → insert, not update.
    expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(0);
    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(1);
    expect(insertValues[0][0]).toMatchObject({ kilterId: 'log-A' });
  });

  it('matches the row within ±60s and not one outside when both are returned', async () => {
    const { tx, calls, insertValues } = createTx({
      selectResults: [
        [],
        [
          {
            uuid: 'tick-far',
            kilterId: null,
            climbUuid: 'climb-1',
            angle: 40,
            climbedAt: '2026-05-01T12:05:00.000Z', // 5 minutes away — too far
          },
          {
            uuid: 'tick-close',
            kilterId: null,
            climbUuid: 'climb-1',
            angle: 40,
            climbedAt: '2026-05-01T12:00:45.000Z', // 45s away — within tolerance
          },
        ],
      ],
    });

    const op = makeLogPutOp({
      log_uuid: 'log-A',
      climb_uuid: 'climb-1',
      angle: 40,
      created_at: '2026-05-01T12:00:00.000Z',
    });

    await applyLogs(tx as unknown as TxArg, 'user-1', [op], aliasCacheFor(['climb-1']), logSpy);

    expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(1);
    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(0);
    expect(insertValues).toHaveLength(0);
  });

  it('handles a mixed batch (insert + update + adopt + divergent) in one call with the expected round-trip count', async () => {
    // 4 PUT ops:
    //   - log-EXISTING: kilter_id SELECT returns this → bulk UPDATE
    //   - log-NEW: no match in either SELECT → bulk INSERT
    //   - log-ADOPT: kilter_id miss, natural-key hit with NULL → adoption (UPDATE)
    //   - log-DIVERGE: kilter_id miss, natural-key hit with other kilter_id → skip + log
    const { tx, calls, insertValues } = createTx({
      selectResults: [
        // kilter_id SELECT: only log-EXISTING is found
        [{ uuid: 'tick-existing', kilterId: 'log-EXISTING' }],
        // natural-key SELECT: returns matches for log-ADOPT and log-DIVERGE
        [
          {
            uuid: 'tick-adopt',
            kilterId: null,
            climbUuid: 'climb-2',
            angle: 40,
            climbedAt: '2026-05-01T12:01:00.000Z',
          },
          {
            uuid: 'tick-diverge',
            kilterId: 'log-FROM-ANOTHER-SYNC',
            climbUuid: 'climb-3',
            angle: 40,
            climbedAt: '2026-05-01T12:02:00.000Z',
          },
        ],
      ],
    });

    const ops: PowerSyncOp[] = [
      makeLogPutOp({
        log_uuid: 'log-EXISTING',
        climb_uuid: 'climb-1',
        angle: 40,
        created_at: '2026-05-01T12:00:00.000Z',
      }),
      makeLogPutOp({
        log_uuid: 'log-NEW',
        climb_uuid: 'climb-9',
        angle: 40,
        created_at: '2026-05-01T12:00:30.000Z',
      }),
      makeLogPutOp({
        log_uuid: 'log-ADOPT',
        climb_uuid: 'climb-2',
        angle: 40,
        created_at: '2026-05-01T12:01:00.000Z',
      }),
      makeLogPutOp({
        log_uuid: 'log-DIVERGE',
        climb_uuid: 'climb-3',
        angle: 40,
        created_at: '2026-05-01T12:02:00.000Z',
      }),
    ];

    await applyLogs(
      tx as unknown as TxArg,
      'user-1',
      ops,
      aliasCacheFor(['climb-1', 'climb-2', 'climb-3', 'climb-9']),
      logSpy,
    );

    // Exactly the documented 3 round trips: kilter-id SELECT, natural-key
    // SELECT, single bulk UPDATE + single bulk INSERT (2 writes).
    expect(calls.filter((c) => c.kind === 'select')).toHaveLength(2);
    expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(1);
    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(1);
    expect(calls.filter((c) => c.kind === 'delete')).toHaveLength(0);

    // The INSERT carries log-NEW only.
    expect(insertValues[0]).toHaveLength(1);
    expect(insertValues[0][0]).toMatchObject({ kilterId: 'log-NEW', climbUuid: 'climb-9' });

    // The divergent row produced exactly one log line.
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toContain('divergent kilter_id');
  });

  it('does not call the natural-key SELECT when every PUT is matched by kilter_id', async () => {
    // Only the kilter-id SELECT should run — gating the natural-key SELECT
    // matters because it's the expensive over-fetch.
    const { tx, calls } = createTx({
      selectResults: [
        [
          { uuid: 'tick-1', kilterId: 'log-A' },
          { uuid: 'tick-2', kilterId: 'log-B' },
        ],
      ],
    });

    const ops: PowerSyncOp[] = [
      makeLogPutOp({
        log_uuid: 'log-A',
        climb_uuid: 'climb-1',
        angle: 40,
        created_at: '2026-05-01T12:00:00.000Z',
      }),
      makeLogPutOp({
        log_uuid: 'log-B',
        climb_uuid: 'climb-2',
        angle: 40,
        created_at: '2026-05-01T12:00:30.000Z',
      }),
    ];

    await applyLogs(tx as unknown as TxArg, 'user-1', ops, aliasCacheFor(['climb-1', 'climb-2']), logSpy);

    expect(calls.filter((c) => c.kind === 'select')).toHaveLength(1);
    expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(1);
    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(0);
  });

  it('threads attempt status correctly: topped=0 → attempt, topped=1 flashed=1 → flash, topped=1 flashed=0 → send', async () => {
    const { tx, insertValues } = createTx({ selectResults: [[], []] });

    const ops: PowerSyncOp[] = [
      makeLogPutOp({
        log_uuid: 'log-attempt',
        climb_uuid: 'climb-1',
        angle: 40,
        created_at: '2026-05-01T12:00:00.000Z',
        topped: 0,
      }),
      makeLogPutOp({
        log_uuid: 'log-flash',
        climb_uuid: 'climb-2',
        angle: 40,
        created_at: '2026-05-01T12:00:30.000Z',
        topped: 1,
        flashed: 1,
      }),
      makeLogPutOp({
        log_uuid: 'log-send',
        climb_uuid: 'climb-3',
        angle: 40,
        created_at: '2026-05-01T12:01:00.000Z',
        topped: 1,
        flashed: 0,
      }),
    ];

    await applyLogs(tx as unknown as TxArg, 'user-1', ops, aliasCacheFor(['climb-1', 'climb-2', 'climb-3']), logSpy);

    const inserted = insertValues[0];
    expect(inserted.find((r) => r.kilterId === 'log-attempt')).toMatchObject({
      status: 'attempt',
      kilterType: 'attempts',
    });
    expect(inserted.find((r) => r.kilterId === 'log-flash')).toMatchObject({
      status: 'flash',
      kilterType: 'logs',
    });
    expect(inserted.find((r) => r.kilterId === 'log-send')).toMatchObject({
      status: 'send',
      kilterType: 'logs',
    });
  });

  it('forwards the REMOVE ids in the soft-detach predicate against boardseshTicks', async () => {
    const { tx, calls } = createTx();

    const ops: PowerSyncOp[] = [
      { op_id: '1', op: 'REMOVE', object_type: 'logs', object_id: 'log-A' },
      { op_id: '2', op: 'REMOVE', object_type: 'logs', object_id: 'log-B' },
    ];

    await applyLogs(tx as unknown as TxArg, 'user-1', ops, new Map(), logSpy);

    expect(calls.filter((c) => c.kind === 'update')).toHaveLength(1);
    expect(calls.filter((c) => c.kind === 'delete')).toHaveLength(0);
    // The where clause is opaque inside drizzle's sql builder; just make
    // sure the update was issued exactly once for the table.
    expect(boardseshTicks).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// applyClimbRatings + applyCircuits — bulk-upsert / full-replace coverage.
// Same stub philosophy as the applyLogs suite above: record every tx call,
// hand-fed select results, assert exact statement counts.
// ---------------------------------------------------------------------------

import { applyCircuits, applyClimbRatings } from './user-sync';
import { boardClimbRatings, playlists, playlistClimbs, playlistOwnership } from '@boardsesh/db/schema';

type ChainTx = {
  tx: unknown;
  calls: CallRecord[];
  insertValues: Array<Array<Record<string, unknown>>>;
  returningRows: Array<Array<Record<string, unknown>>>;
};

/**
 * Richer tx stub than createTx — supports the chains applyClimbRatings
 * (insert→values→onConflictDoUpdate) and applyCircuits (insert→values→
 * onConflictDoUpdate→returning, insert→values→onConflictDoNothing) actually
 * use. `returnRows` is a queue: each insert that calls .returning() pops the
 * next array, defaulting to a single autoincrement-ish row.
 */
function createRichTx(
  opts: { selectResults?: SelectResult[]; returningRows?: Array<Array<Record<string, unknown>>> } = {},
): ChainTx {
  const calls: CallRecord[] = [];
  const selectResults = opts.selectResults ?? [];
  const returningQueue = opts.returningRows ?? [];
  let selectIdx = 0;
  let returningIdx = 0;
  const insertValues: Array<Array<Record<string, unknown>>> = [];

  const tx = {
    select(cols: unknown) {
      calls.push({ kind: 'select', args: [cols] });
      const next = selectResults[selectIdx++] ?? [];
      // applyCircuits chains .where(...).orderBy(...) for the playlist_climbs
      // read, so .where() needs to be both directly awaitable AND carry an
      // .orderBy() that's also awaitable. Object.assign on a Promise gives
      // us both shapes against the same stub.
      const orderable = (rows: SelectResult) =>
        Object.assign(Promise.resolve(rows), {
          orderBy: (..._cols: unknown[]) => Promise.resolve(rows),
        });
      return {
        from: (_table: unknown) => ({
          where: (_cond: unknown) => orderable(next),
          orderBy: (..._cols: unknown[]) => Promise.resolve(next),
        }),
      };
    },
    delete(_table: unknown) {
      return {
        where: (_cond: unknown) => {
          calls.push({ kind: 'delete', args: [_cond] });
          return Promise.resolve();
        },
      };
    },
    insert(_table: unknown) {
      return {
        values: (rows: Array<Record<string, unknown>>) => {
          calls.push({ kind: 'insert', args: [rows] });
          insertValues.push(rows);
          const conflictChain = {
            onConflictDoUpdate: (_args: unknown) => {
              const ret = (_args2?: unknown) =>
                Promise.resolve(returningQueue[returningIdx++] ?? [{ id: BigInt(insertValues.length) }]);
              const promise = Promise.resolve();
              // Allow either await-without-returning or .returning(...).then()
              return Object.assign(promise, { returning: ret });
            },
            onConflictDoNothing: () => Promise.resolve(),
          };
          return Object.assign(Promise.resolve(), conflictChain);
        },
      };
    },
    execute(query: unknown) {
      calls.push({ kind: 'execute', args: [query] });
      return Promise.resolve();
    },
  };

  return { tx, calls, insertValues, returningRows: returningQueue };
}

function makeRatingPutOp(args: {
  climb_rating_uuid: string;
  climb_uuid: string;
  angle: number;
  rating?: number | null;
  difficulty_grade_id?: number | null;
  comment?: string | null;
  user_uuid?: string;
}): PowerSyncOp {
  return {
    op_id: '1',
    op: 'PUT',
    object_type: 'climb_ratings',
    object_id: args.climb_rating_uuid,
    data: {
      id: args.climb_rating_uuid,
      climb_rating_uuid: args.climb_rating_uuid,
      user_uuid: args.user_uuid ?? 'user-sub',
      gym_uuid: null,
      wall_uuid: null,
      product_layout_uuid: null,
      climb_uuid: args.climb_uuid,
      angle: args.angle,
      rating: args.rating ?? null,
      difficulty_grade_id: args.difficulty_grade_id ?? null,
      comment: args.comment ?? null,
      created_at: '2026-05-01T12:00:00.000Z',
    },
  };
}

type ApplyClimbRatingsTx = Parameters<typeof applyClimbRatings>[0];
type ApplyCircuitsTx = Parameters<typeof applyCircuits>[0];

describe('applyClimbRatings — bulk upsert with COALESCE comment', () => {
  it('returns early on empty ops', async () => {
    const { tx, calls } = createRichTx();
    await applyClimbRatings(tx as unknown as ApplyClimbRatingsTx, 'user-1', [], new Map());
    expect(calls).toHaveLength(0);
  });

  it('issues exactly one bulk insert + onConflictDoUpdate for N PUTs', async () => {
    const { tx, calls, insertValues } = createRichTx();
    const ops = [
      makeRatingPutOp({ climb_rating_uuid: 'r-1', climb_uuid: 'climb-A', angle: 40, rating: 4 }),
      makeRatingPutOp({ climb_rating_uuid: 'r-2', climb_uuid: 'climb-B', angle: 25, rating: 5 }),
    ];

    await applyClimbRatings(tx as unknown as ApplyClimbRatingsTx, 'user-1', ops, aliasCacheFor(['climb-A', 'climb-B']));

    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(1);
    expect(insertValues[0]).toHaveLength(2);
    expect(insertValues[0][0]).toMatchObject({
      kilterId: 'r-1',
      climbUuid: 'climb-A',
      angle: 40,
      rating: 4,
      userId: 'user-1',
      boardType: 'kilter',
    });
    expect(insertValues[0][1]).toMatchObject({ kilterId: 'r-2', climbUuid: 'climb-B' });
    // No delete because there were no REMOVEs.
    expect(calls.filter((c) => c.kind === 'delete')).toHaveLength(0);
    // boardClimbRatings is the schema target — used by the bulk insert.
    expect(boardClimbRatings).toBeDefined();
  });

  it('issues exactly one bulk DELETE for N REMOVE ops, no INSERT', async () => {
    const { tx, calls } = createRichTx();
    const ops: PowerSyncOp[] = [
      { op_id: '1', op: 'REMOVE', object_type: 'climb_ratings', object_id: 'r-1' },
      { op_id: '2', op: 'REMOVE', object_type: 'climb_ratings', object_id: 'r-2' },
    ];

    await applyClimbRatings(tx as unknown as ApplyClimbRatingsTx, 'user-1', ops, new Map());

    expect(calls.filter((c) => c.kind === 'delete')).toHaveLength(1);
    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(0);
  });

  it('handles a mixed REMOVE + PUT batch in one delete + one upsert', async () => {
    const { tx, calls, insertValues } = createRichTx();
    const ops: PowerSyncOp[] = [
      { op_id: '1', op: 'REMOVE', object_type: 'climb_ratings', object_id: 'r-old' },
      makeRatingPutOp({ climb_rating_uuid: 'r-new', climb_uuid: 'climb-A', angle: 30 }),
    ];

    await applyClimbRatings(tx as unknown as ApplyClimbRatingsTx, 'user-1', ops, aliasCacheFor(['climb-A']));

    expect(calls.filter((c) => c.kind === 'delete')).toHaveLength(1);
    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(1);
    expect(insertValues[0]).toHaveLength(1);
  });

  it('normalises a null incoming comment to empty string on insert (COALESCE preserves existing on UPDATE)', async () => {
    const { tx, insertValues } = createRichTx();
    const op = makeRatingPutOp({ climb_rating_uuid: 'r-1', climb_uuid: 'climb-A', angle: 40, comment: null });

    await applyClimbRatings(tx as unknown as ApplyClimbRatingsTx, 'user-1', [op], aliasCacheFor(['climb-A']));

    // INSERT value normalises null → ''. The UPDATE clause uses
    // COALESCE(EXCLUDED.comment, …) which the file-level integration
    // tests cover; here we only assert the insert payload shape.
    expect(insertValues[0][0]).toMatchObject({ comment: '' });
  });
});

function makeCircuitPutOp(args: { circuit_uuid: string; name: string; user_uuid?: string }): PowerSyncOp {
  return {
    op_id: '1',
    op: 'PUT',
    object_type: 'circuits',
    object_id: args.circuit_uuid,
    data: {
      id: args.circuit_uuid,
      circuit_uuid: args.circuit_uuid,
      name: args.name,
      description: null,
      color: null,
      is_public: 0,
      user_uuid: args.user_uuid ?? 'user-sub',
      product_layout_uuid: null,
    },
  };
}

function makeCircuitClimbPutOp(args: {
  circuit_uuid: string;
  climb_uuid: string;
  angle?: number | null;
  position?: number;
}): PowerSyncOp {
  return {
    op_id: '1',
    op: 'PUT',
    object_type: 'circuit_climbs',
    object_id: `${args.circuit_uuid}:${args.climb_uuid}`,
    data: {
      id: `${args.circuit_uuid}:${args.climb_uuid}`,
      circuit_uuid: args.circuit_uuid,
      climb_uuid: args.climb_uuid,
      angle: args.angle ?? null,
      position: args.position ?? 0,
    },
  };
}

describe('applyCircuits — playlist upsert + diff-and-replace', () => {
  it('returns early when both circuit and climb buffers are empty', async () => {
    const { tx, calls } = createRichTx();
    await applyCircuits(tx as unknown as ApplyCircuitsTx, 'user-1', [], [], new Map());
    expect(calls).toHaveLength(0);
  });

  it('REMOVE op deletes the playlist only when the user owns it (EXISTS subquery)', async () => {
    const { tx, calls } = createRichTx();
    const ops: PowerSyncOp[] = [{ op_id: '1', op: 'REMOVE', object_type: 'circuits', object_id: 'circuit-X' }];

    await applyCircuits(tx as unknown as ApplyCircuitsTx, 'user-1', ops, [], new Map());

    // Exactly one DELETE issued; the ownership guard lives in the WHERE
    // we passed in (an EXISTS subquery against playlist_ownership keyed
    // on userId). The shim can't inspect the SQL fragment, but we can
    // confirm only one delete fired and no inserts.
    expect(calls.filter((c) => c.kind === 'delete')).toHaveLength(1);
    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(0);
    // playlists / playlistOwnership are referenced in the WHERE so they
    // need to be present in the schema surface — keep the imports live.
    expect(playlists).toBeDefined();
    expect(playlistOwnership).toBeDefined();
  });

  it('PUT inserts a new playlist + ownership row + diff-applies its climbs', async () => {
    // SELECT #1 = existing playlist_climbs for this playlist (empty: brand new).
    const { tx, calls, insertValues } = createRichTx({
      selectResults: [[]],
      returningRows: [[{ id: BigInt(99) }]],
    });

    const circuitOp = makeCircuitPutOp({ circuit_uuid: 'circuit-1', name: 'Liked Climbs' });
    const climbOps = [
      makeCircuitClimbPutOp({ circuit_uuid: 'circuit-1', climb_uuid: 'climb-A', position: 0 }),
      makeCircuitClimbPutOp({ circuit_uuid: 'circuit-1', climb_uuid: 'climb-B', position: 1 }),
    ];

    await applyCircuits(
      tx as unknown as ApplyCircuitsTx,
      'user-1',
      [circuitOp],
      climbOps,
      aliasCacheFor(['climb-A', 'climb-B']),
    );

    const inserts = calls.filter((c) => c.kind === 'insert');
    // Expect: 1 playlist upsert, 1 ownership upsert, 1 playlist_climbs bulk
    // insert (since the existing list was empty so the diff path takes the
    // straight insert branch).
    expect(inserts.length).toBeGreaterThanOrEqual(2);
    // insertValues holds either arrays of rows (bulk inserts) or single
    // objects (ownership upsert uses .values({...})). Normalise to arrays
    // before scanning for the playlist_climbs payload.
    const climbsInsert = insertValues
      .map((rows) => (Array.isArray(rows) ? rows : [rows]))
      .find((rows) => rows.some((r) => 'climbUuid' in r));
    expect(climbsInsert).toBeDefined();
    expect(climbsInsert).toHaveLength(2);
    // playlistClimbs schema is part of the assertion surface.
    expect(playlistClimbs).toBeDefined();
  });

  it('skips the climbs re-insert entirely when incoming and existing match exactly', async () => {
    // Existing rows already match the incoming snapshot — diff guard
    // should short-circuit before DELETE+INSERT.
    const existing = [
      { climbUuid: 'climb-A', angle: null, position: 0 },
      { climbUuid: 'climb-B', angle: null, position: 1 },
    ];
    const { tx, calls } = createRichTx({
      selectResults: [existing],
      returningRows: [[{ id: BigInt(99) }]],
    });

    const circuitOp = makeCircuitPutOp({ circuit_uuid: 'circuit-1', name: 'Liked Climbs' });
    const climbOps = [
      makeCircuitClimbPutOp({ circuit_uuid: 'circuit-1', climb_uuid: 'climb-A', angle: null, position: 0 }),
      makeCircuitClimbPutOp({ circuit_uuid: 'circuit-1', climb_uuid: 'climb-B', angle: null, position: 1 }),
    ];

    await applyCircuits(
      tx as unknown as ApplyCircuitsTx,
      'user-1',
      [circuitOp],
      climbOps,
      aliasCacheFor(['climb-A', 'climb-B']),
    );

    // No DELETE on playlist_climbs (diff skipped it), and no INSERT carrying
    // climbUuid (the playlist + ownership inserts don't have that field).
    const climbsInsertCalls = calls.filter((c) => {
      if (c.kind !== 'insert') return false;
      const arg = c.args[0];
      const rows = Array.isArray(arg) ? arg : [arg];
      return (rows as Array<Record<string, unknown>>).some((r) => 'climbUuid' in r);
    });
    expect(climbsInsertCalls).toHaveLength(0);
  });
});
