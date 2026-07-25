import { beforeEach, describe, expect, it, vi } from 'vitest';
import { boardseshTicks } from '@boardsesh/db/schema';
import type { PowerSyncOp } from '../api/powersync-client';

// Stub the shared stats recompute so it doesn't run its own tx.execute()s —
// that keeps the execute-count assertions below about applyLogs's own writes.
// resolveCanonicalClimbUuid stays real (pre-seeded alias cache → no DB hit).
vi.mock('@boardsesh/db/queries', async (importActual) => {
  const actual = await importActual<typeof import('@boardsesh/db/queries')>();
  return { ...actual, recomputeClimbStatsBulk: vi.fn() };
});

import { recomputeClimbStatsBulk, type ClimbStatsKey } from '@boardsesh/db/queries';
import { applyLogs } from './user-sync';

const recomputeMock = vi.mocked(recomputeClimbStatsBulk);

// Distinct (climbUuid, angle) keys the recompute was asked to refresh.
function recomputedKeys(): Array<{ climbUuid: string; angle: number }> {
  const keys = (recomputeMock.mock.calls.at(-1)?.[1] ?? []) as ClimbStatsKey[];
  return keys.map((key) => ({ climbUuid: key.climbUuid, angle: key.angle }));
}

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
  // `conflict` records the ON CONFLICT clause an insert was given, so a test
  // can assert the ownership `setWhere` guard was attached.
  kind: 'select' | 'delete' | 'execute' | 'insert' | 'update' | 'conflict';
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
//   - real conflict behaviour on the GLOBAL boardsesh_ticks_kilter_id_unique
//     index (kilter_id alone, not scoped to user)
//   - CASCADE behaviour when a user row gets deleted mid-sync
//
// We accept this gap deliberately: the failure mode is "first prod run
// of a renamed schema crashes loudly" — recoverable from Sentry, and
// the bulk-upsert SQL is structurally simple enough that a typo is
// caught at typecheck time via the Drizzle column references. Promote
// to an integration test if the SQL grows another conditional.
function createTx(
  opts: { selectResults?: SelectResult[]; removeResult?: SelectResult; executeResults?: unknown[] } = {},
) {
  const calls: CallRecord[] = [];
  const selectResults = opts.selectResults ?? [];
  const removeResult = opts.removeResult ?? [];
  const executeResults = opts.executeResults ?? [];
  let selectIdx = 0;
  let executeIdx = 0;
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
            // applyLogs's soft-detach REMOVE path chains .returning(...) to
            // collect the detached rows' keys for the stats recompute.
            return { returning: (_cols: unknown) => Promise.resolve(removeResult) };
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
      return Promise.resolve(executeResults[executeIdx++]);
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
    recomputeMock.mockClear();
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
      // Freshly pulled from Kilter — stamped so the double-count guard
      // excludes it from the Boardsesh count.
      origin: 'kilter_pull',
    });
    expect(logSpy).not.toHaveBeenCalled();
    // The written (climb, angle) key is handed to the stats recompute.
    expect(recomputeMock).toHaveBeenCalledTimes(1);
    expect(recomputedKeys()).toEqual([{ climbUuid: 'climb-1', angle: 40 }]);
  });

  it('updates an existing tick when matched by kilter_id (idempotent re-sync)', async () => {
    // First SELECT returns the existing row by kilter_id; second SELECT is
    // not executed because every incoming op was already matched.
    const { tx, calls, insertValues } = createTx({
      selectResults: [[{ uuid: 'tick-uuid-1', kilterId: 'log-A', ownerUserId: 'user-1' }]],
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
    expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(2);
    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(0);
    expect(insertValues).toHaveLength(0);
  });

  it('recomputes the PRIOR key too when a Kilter edit moves a log to another climb/angle', async () => {
    // The tick currently sits on climb-old/45; the incoming snapshot moved the
    // same log to climb-1/40. Both keys must be recomputed: the old one loses
    // the ascent, the new one gains it.
    const { tx } = createTx({
      selectResults: [[{ uuid: 'tick-uuid-1', kilterId: 'log-A', ownerUserId: 'user-1' }]],
      executeResults: [[{ climb_uuid: 'climb-old', angle: 45 }]],
    });

    const op = makeLogPutOp({
      log_uuid: 'log-A',
      climb_uuid: 'climb-1',
      angle: 40,
      created_at: '2026-05-01T12:00:00.000Z',
    });

    await applyLogs(tx as unknown as TxArg, 'user-1', [op], aliasCacheFor(['climb-1']), logSpy);

    expect(recomputeMock).toHaveBeenCalledTimes(1);
    expect(recomputedKeys()).toEqual([
      { climbUuid: 'climb-old', angle: 45 },
      { climbUuid: 'climb-1', angle: 40 },
    ]);
  });

  it('re-sync by kilter_id applies an incoming attempt that downgrades a send (Kilter is source of truth — no status guard here)', async () => {
    // Locks the intentional asymmetry: the natural-key path refuses an
    // attempt→completion downgrade (it protects a heuristic match), but the
    // kilter_id re-sync path MUST let it through — the row is the SAME Kilter
    // log and Kilter is authoritative, so a genuine un-top edit flows in.
    // Only the kilter_id SELECT runs; the incoming attempt updates in place
    // (no insert, no natural-key SELECT). If someone adds the status guard to
    // the re-sync path, this flips to an insert and the test fails.
    const { tx, calls, insertValues } = createTx({
      selectResults: [[{ uuid: 'tick-uuid-1', kilterId: 'log-A', ownerUserId: 'user-1' }]],
    });

    const op = makeLogPutOp({
      log_uuid: 'log-A',
      climb_uuid: 'climb-1',
      angle: 40,
      created_at: '2026-05-01T12:00:00.000Z',
      topped: 0, // attempt — blocked on the natural-key path, allowed on re-sync
    });

    await applyLogs(tx as unknown as TxArg, 'user-1', [op], aliasCacheFor(['climb-1']), logSpy);

    expect(calls.filter((c) => c.kind === 'select')).toHaveLength(1);
    expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(2);
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
    expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(2);
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
    const { tx, calls } = createTx({
      // The soft-detach returns the detached rows' keys for the recompute.
      removeResult: [{ climbUuid: 'climb-1', angle: 40 }],
    });

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
    // The detach stamps kilter_detached_at so push-back and the recompute can
    // tell an upstream-deleted row apart from a never-pushed native tick.
    expect(typeof (updateCalls[0].args[0] as Record<string, unknown>).kilterDetachedAt).toBe('string');
    expect(calls.filter((c) => c.kind === 'delete')).toHaveLength(0);
    expect(calls.filter((c) => c.kind === 'select')).toHaveLength(0);
    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(0);
    expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(0);
    // A detach changes what board_climb_stats should show, so the detached
    // row's key is recomputed even though there were no PUTs.
    expect(recomputeMock).toHaveBeenCalledTimes(1);
    expect(recomputedKeys()).toEqual([{ climbUuid: 'climb-1', angle: 40 }]);
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

    expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(2);
    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(0);
    expect(insertValues).toHaveLength(0);
  });

  it('adopts one existing tick and INSERTS the second when two logs match the same NULL-kilter_id row (no tick loss)', async () => {
    // Two incoming logs share the same canonical climb_uuid + angle and
    // both fall within ±60s of ONE existing Boardsesh-originated tick
    // (kilter_id NULL). Without the claimed-set both would adopt the same
    // uuid; the bulk UPDATE applies once and the loser is dropped forever.
    // Correct behaviour: the existing tick adopts the first log, the
    // second falls through to the INSERT path as its own tick.
    const { tx, calls, insertValues } = createTx({
      selectResults: [
        // kilter_id SELECT: neither log is known yet.
        [],
        // natural-key SELECT: a single NULL-kilter_id candidate.
        [
          {
            uuid: 'tick-uuid-shared',
            kilterId: null,
            climbUuid: 'climb-1',
            angle: 40,
            climbedAt: '2026-05-01T12:00:15.000Z',
          },
        ],
      ],
    });

    const ops: PowerSyncOp[] = [
      makeLogPutOp({
        log_uuid: 'log-FIRST',
        climb_uuid: 'climb-1',
        angle: 40,
        created_at: '2026-05-01T12:00:00.000Z',
      }),
      makeLogPutOp({
        log_uuid: 'log-SECOND',
        climb_uuid: 'climb-1',
        angle: 40,
        created_at: '2026-05-01T12:00:30.000Z',
      }),
    ];

    await applyLogs(tx as unknown as TxArg, 'user-1', ops, aliasCacheFor(['climb-1']), logSpy);

    // One adoption (bulk UPDATE) and one INSERT — the second log is NOT lost.
    expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(2);
    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(1);
    expect(insertValues[0]).toHaveLength(1);
    // The shared tick was claimed by the first log, so the second is the
    // insert. Either log_uuid could win the adoption depending on order;
    // the invariant is that exactly one of the two becomes the insert.
    const insertedKilterId = insertValues[0][0].kilterId as string;
    expect(['log-FIRST', 'log-SECOND']).toContain(insertedKilterId);
    expect(insertValues[0][0]).toMatchObject({ climbUuid: 'climb-1', angle: 40 });
    // No divergent skip — both logs were handled.
    expect(logSpy).not.toHaveBeenCalled();
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
        [{ uuid: 'tick-existing', kilterId: 'log-EXISTING', ownerUserId: 'user-1' }],
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
    expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(2);
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
          { uuid: 'tick-1', kilterId: 'log-A', ownerUserId: 'user-1' },
          { uuid: 'tick-2', kilterId: 'log-B', ownerUserId: 'user-1' },
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
    expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(2);
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

  it('dedupes two PUTs with the same log_uuid into a single insert (last-op-wins, no kilter_id collision)', async () => {
    // PowerSync's oplog can deliver the same row (object_id = log_uuid)
    // more than once in a snapshot. Both selects empty → insert path. The
    // two ops carry the SAME log_uuid; without dedup the bulk INSERT would
    // carry two rows with identical kilter_id and violate the global
    // boardsesh_ticks_kilter_id_unique index. After dedup exactly one row
    // inserts, and the LAST op wins (freshest state).
    const { tx, calls, insertValues } = createTx({ selectResults: [[], []] });

    const ops: PowerSyncOp[] = [
      makeLogPutOp({
        log_uuid: 'log-DUP',
        climb_uuid: 'climb-1',
        angle: 40,
        created_at: '2026-05-01T12:00:00.000Z',
        topped: 1,
        flashed: 0, // first delivery: a send
      }),
      makeLogPutOp({
        log_uuid: 'log-DUP',
        climb_uuid: 'climb-1',
        angle: 40,
        created_at: '2026-05-01T12:00:00.000Z',
        topped: 0,
        attempts: 3, // second delivery: re-logged as a 3-try attempt
      }),
    ];

    await applyLogs(tx as unknown as TxArg, 'user-1', ops, aliasCacheFor(['climb-1']), logSpy);

    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(1);
    expect(insertValues[0]).toHaveLength(1);
    // Last op wins: the attempt, not the send.
    expect(insertValues[0][0]).toMatchObject({
      kilterId: 'log-DUP',
      status: 'attempt',
      attemptCount: 3,
    });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('does NOT let an incoming attempt adopt (downgrade) an existing send — inserts as its own tick', async () => {
    // Natural-key match ignores status. The incoming op is an attempt
    // (topped=0) within ±60s of an existing send. Adopting would overwrite
    // the send → attempt. Instead the send is left alone and the attempt
    // inserts separately.
    const { tx, calls, insertValues } = createTx({
      selectResults: [
        [],
        [
          {
            uuid: 'tick-send',
            kilterId: null,
            climbUuid: 'climb-1',
            angle: 40,
            climbedAt: '2026-05-01T12:00:20.000Z',
            status: 'send',
          },
        ],
      ],
    });

    const op = makeLogPutOp({
      log_uuid: 'log-attempt',
      climb_uuid: 'climb-1',
      angle: 40,
      created_at: '2026-05-01T12:00:00.000Z',
      topped: 0,
    });

    await applyLogs(tx as unknown as TxArg, 'user-1', [op], aliasCacheFor(['climb-1']), logSpy);

    // No adoption UPDATE; the attempt is a fresh insert.
    expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(0);
    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(1);
    expect(insertValues[0][0]).toMatchObject({ kilterId: 'log-attempt', status: 'attempt' });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('DOES let an incoming send adopt an existing attempt (upgrade)', async () => {
    const { tx, calls, insertValues } = createTx({
      selectResults: [
        [],
        [
          {
            uuid: 'tick-attempt',
            kilterId: null,
            climbUuid: 'climb-1',
            angle: 40,
            climbedAt: '2026-05-01T12:00:20.000Z',
            status: 'attempt',
          },
        ],
      ],
    });

    const op = makeLogPutOp({
      log_uuid: 'log-send',
      climb_uuid: 'climb-1',
      angle: 40,
      created_at: '2026-05-01T12:00:00.000Z',
      topped: 1,
      flashed: 0,
    });

    await applyLogs(tx as unknown as TxArg, 'user-1', [op], aliasCacheFor(['climb-1']), logSpy);

    // Adoption UPDATE, no insert.
    expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(2);
    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(0);
    expect(insertValues).toHaveLength(0);
  });

  it('skips and logs a log_uuid already owned by a different Boardsesh user (duplicate Kilter account link)', async () => {
    // The global kilter_id SELECT finds the incoming log under ANOTHER
    // user. Inserting it would collide on the global unique index; adopting
    // it would stamp a globally-taken kilter_id. It must be skipped-and-
    // logged, never inserted/adopted. With the only op foreign, the
    // natural-key candidate set is empty so the second SELECT never runs.
    const { tx, calls, insertValues } = createTx({
      selectResults: [[{ uuid: 'tick-other-user', kilterId: 'log-FOREIGN', ownerUserId: 'other-user' }]],
    });

    const op = makeLogPutOp({
      log_uuid: 'log-FOREIGN',
      climb_uuid: 'climb-1',
      angle: 40,
      created_at: '2026-05-01T12:00:00.000Z',
    });

    await applyLogs(tx as unknown as TxArg, 'user-1', [op], aliasCacheFor(['climb-1']), logSpy);

    expect(calls.filter((c) => c.kind === 'select')).toHaveLength(1);
    expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(0);
    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(0);
    expect(insertValues).toHaveLength(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const message = logSpy.mock.calls[0]?.[0] as string;
    expect(message).toContain('different Boardsesh user');
    expect(message).toContain('log-FOREIGN');
  });
});

// ---------------------------------------------------------------------------
// applyLogs — PR4: per-user offset inference (the 3,208-duplicate fix) and the
// by-kilter-id edit-clobber / no-op guards. Same mock-tx harness.
// ---------------------------------------------------------------------------

/** A full existing-tick row shaped like the by-kilter-id SELECT returns. */
function existingKilterTick(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uuid: 'tick-1',
    kilterId: 'log-A',
    ownerUserId: 'user-1',
    climbUuid: 'climb-1',
    angle: 40,
    status: 'send',
    attemptCount: 1,
    climbedAt: '2026-05-01T12:00:00.000Z',
    kilterType: 'logs',
    updatedAt: '2026-05-01T12:00:00.000Z',
    kilterSyncedAt: '2026-05-01T12:00:00.000Z',
    ...overrides,
  };
}

describe('applyLogs — PR4 offset inference + edit guard', () => {
  let logSpy: ReturnType<typeof vi.fn<(msg: string) => void>>;

  beforeEach(() => {
    logSpy = vi.fn<(msg: string) => void>();
    recomputeMock.mockClear();
  });

  it('adopts a timezone-shifted original via the inferred +10h offset (the 3,208-dup fix)', async () => {
    // The existing Aurora/JSON original stored local wall time (UTC+10)
    // relabelled as UTC — 10h AHEAD of the honest-UTC Kilter created_at. The
    // old ±60s window never matched; per-user offset inference now adopts it.
    const { tx, calls, insertValues } = createTx({
      selectResults: [
        [], // no kilter_id match
        [
          {
            uuid: 'tick-shifted',
            kilterId: null,
            climbUuid: 'climb-1',
            angle: 40,
            climbedAt: '2026-05-01T22:00:00.000Z', // +10h ahead of the incoming log
            status: 'send',
          },
        ],
      ],
    });

    const op = makeLogPutOp({
      log_uuid: 'log-A',
      climb_uuid: 'climb-1',
      angle: 40,
      created_at: '2026-05-01T12:00:00.000Z',
      topped: 1,
      flashed: 0,
    });

    await applyLogs(tx as unknown as TxArg, 'user-1', [op], aliasCacheFor(['climb-1']), logSpy);

    // Adoption UPDATE (priorKey SELECT + bulk UPDATE = 2 executes), no insert.
    expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(2);
    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(0);
    expect(insertValues).toHaveLength(0);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('does NOT adopt an implausibly-shifted row (gap beyond ±14h, no offset)', async () => {
    // A 20h gap is not a real UTC offset; inference finds nothing and the fast
    // path rejects it → the incoming log inserts as its own tick.
    const { tx, calls, insertValues } = createTx({
      selectResults: [
        [],
        [
          {
            uuid: 'tick-far',
            kilterId: null,
            climbUuid: 'climb-1',
            angle: 40,
            climbedAt: '2026-05-02T08:00:00.000Z', // +20h — implausible offset
            status: 'send',
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

    expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(0);
    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(1);
    expect(insertValues[0][0]).toMatchObject({ kilterId: 'log-A', origin: 'kilter_pull' });
  });

  it('skips overwriting a locally-edited row on a kilter_id re-sync (edit-clobber guard)', async () => {
    // The row was edited locally (updated_at > kilter_synced_at) after the last
    // sync — a pending push-back. Kilter's stale snapshot must not stomp it.
    const { tx, calls, insertValues } = createTx({
      selectResults: [[existingKilterTick({ updatedAt: '2026-05-02T00:00:00.000Z' })]],
    });

    const op = makeLogPutOp({
      log_uuid: 'log-A',
      climb_uuid: 'climb-1',
      angle: 40,
      created_at: '2026-05-01T12:00:00.000Z',
      topped: 0, // incoming attempt would downgrade the local send — but it's guarded
    });

    await applyLogs(tx as unknown as TxArg, 'user-1', [op], aliasCacheFor(['climb-1']), logSpy);

    // Only the kilter_id SELECT runs; no UPDATE (local edit protected), no insert.
    expect(calls.filter((c) => c.kind === 'select')).toHaveLength(1);
    expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(0);
    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(0);
    expect(insertValues).toHaveLength(0);
  });

  it('skips a no-op kilter_id re-sync when the payload is identical (no trigger churn)', async () => {
    const { tx, calls } = createTx({
      selectResults: [[existingKilterTick()]],
    });

    const op = makeLogPutOp({
      log_uuid: 'log-A',
      climb_uuid: 'climb-1',
      angle: 40,
      created_at: '2026-05-01T12:00:00.000Z', // same climbed_at
      topped: 1,
      flashed: 0, // send, attempts default 1 — identical to stored
    });

    await applyLogs(tx as unknown as TxArg, 'user-1', [op], aliasCacheFor(['climb-1']), logSpy);

    // Payload unchanged → no UPDATE.
    expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(0);
    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(0);
  });

  it('still applies a real kilter_id edit (changed status) despite the guards', async () => {
    // Not locally edited (updated_at <= kilter_synced_at) and the payload
    // differs (attempt → send) → the edit flows through.
    const { tx, calls } = createTx({
      selectResults: [[existingKilterTick({ status: 'attempt', kilterType: 'attempts' })]],
    });

    const op = makeLogPutOp({
      log_uuid: 'log-A',
      climb_uuid: 'climb-1',
      angle: 40,
      created_at: '2026-05-01T12:00:00.000Z',
      topped: 1,
      flashed: 0, // now a send
    });

    await applyLogs(tx as unknown as TxArg, 'user-1', [op], aliasCacheFor(['climb-1']), logSpy);

    // priorKey SELECT + bulk UPDATE.
    expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(2);
    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// applyClimbRatings + applyCircuits — bulk-upsert / full-replace coverage.
// Same stub philosophy as the applyLogs suite above: record every tx call,
// hand-fed select results, assert exact statement counts.
// ---------------------------------------------------------------------------

import { PgDialect } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import {
  foreignPlaylistOwnerGuard,
  selectUpstreamPlaylistOwners,
  upstreamPlaylistOwnersQuery,
} from '@boardsesh/db/queries';

/**
 * Driverless drizzle handle. `.toSQL()` renders without ever opening a
 * connection, so query-shape assertions need no database.
 */
const renderOnlyDb = drizzle({} as never);
import { applyCircuits, applyClimbRatings, sanitizeKilterRating } from './user-sync';

describe('sanitizeKilterRating', () => {
  it('keeps valid 1-5 ratings', () => {
    for (const r of [1, 2, 3, 4, 5]) expect(sanitizeKilterRating(r)).toBe(r);
  });
  it('maps 0 (Kilter "cleared") and out-of-range / non-finite to NULL so the CHECK accepts the row', () => {
    expect(sanitizeKilterRating(0)).toBeNull();
    expect(sanitizeKilterRating(-1)).toBeNull();
    expect(sanitizeKilterRating(6)).toBeNull();
    expect(sanitizeKilterRating(null)).toBeNull();
    expect(sanitizeKilterRating(undefined)).toBeNull();
    expect(sanitizeKilterRating(Number.NaN)).toBeNull();
  });
});
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
      // applyCircuits' owner lookup chains .leftJoin(...) before .where(...),
      // so the join step has to return the same awaitable shape.
      const source = {
        where: (_cond: unknown) => orderable(next),
        orderBy: (..._cols: unknown[]) => Promise.resolve(next),
        leftJoin: (_table: unknown, _on: unknown) => source,
        innerJoin: (_table: unknown, _on: unknown) => source,
      };
      return {
        from: (_table: unknown) => source,
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
              calls.push({ kind: 'conflict', args: [_args] });
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

  it('sanitizes a Kilter rating=0 to NULL so the batch does not violate the CHECK', () => {
    const { tx, insertValues } = createRichTx();
    const ops = [makeRatingPutOp({ climb_rating_uuid: 'r-0', climb_uuid: 'climb-A', angle: 40, rating: 0 })];
    return applyClimbRatings(tx as unknown as ApplyClimbRatingsTx, 'user-1', ops, aliasCacheFor(['climb-A'])).then(
      () => {
        expect(insertValues[0]).toHaveLength(1);
        expect(insertValues[0][0]).toMatchObject({ kilterId: 'r-0', rating: null });
      },
    );
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

  it('dedupes two PUTs that alias to one canonical climb_uuid at the same angle+user to a single upsert row', async () => {
    // Two ratings carry DISTINCT source climb_uuids that both alias to one
    // canonical (a deduped climb). At the same angle + user they collapse
    // to one conflict key (board_type, climb_uuid, angle, user_id).
    // Without dedup the VALUES list carries two rows with the same conflict
    // key and Postgres aborts the whole flush ("ON CONFLICT DO UPDATE
    // command cannot affect row a second time"). The dedup must hand the
    // upsert exactly one row, last-write-wins.
    const { tx, calls, insertValues } = createRichTx();
    // Both source uuids resolve to the same canonical via the alias cache.
    const aliasCache = new Map<string, string>();
    aliasCache.set('kilter:climb-src-a', 'climb-canonical');
    aliasCache.set('kilter:climb-src-b', 'climb-canonical');

    const ops = [
      makeRatingPutOp({ climb_rating_uuid: 'r-a', climb_uuid: 'climb-src-a', angle: 40, rating: 3 }),
      makeRatingPutOp({ climb_rating_uuid: 'r-b', climb_uuid: 'climb-src-b', angle: 40, rating: 5 }),
    ];

    await applyClimbRatings(tx as unknown as ApplyClimbRatingsTx, 'user-1', ops, aliasCache);

    // Exactly one bulk insert carrying ONE deduped values row.
    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(1);
    expect(insertValues[0]).toHaveLength(1);
    // Last write wins: the second PUT (r-b, rating 5) is the survivor.
    expect(insertValues[0][0]).toMatchObject({
      climbUuid: 'climb-canonical',
      angle: 40,
      userId: 'user-1',
      rating: 5,
      kilterId: 'r-b',
    });
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

  it('REMOVE op deletes the playlist when the user is its sole owner (EXISTS subquery)', async () => {
    // SELECT #1 = the owner lookup: this user, and only this user, owns it.
    const { tx, calls } = createRichTx({ selectResults: [[{ upstreamId: 'circuit-X', ownerUserId: 'user-1' }]] });
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
    // SELECT #1 = owner lookup (no playlist yet), #2 = existing
    // playlist_climbs for this playlist (empty: brand new).
    const { tx, calls, insertValues } = createRichTx({
      selectResults: [[], []],
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
      // SELECT #1 = owner lookup (ours), #2 = existing playlist_climbs.
      selectResults: [[{ upstreamId: 'circuit-1', ownerUserId: 'user-1' }], existing],
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

  it('rewrites playlist_climbs when only a climb angle changed (same uuids + order)', async () => {
    // Same climb_uuids in the same order, but climb-A's angle moved
    // 40 → 25. The diff must compare angle too, otherwise this angle-only
    // edit is dropped and the playlist keeps the stale angle.
    const existing = [
      { climbUuid: 'climb-A', angle: 40, position: 0 },
      { climbUuid: 'climb-B', angle: 25, position: 1 },
    ];
    const { tx, calls } = createRichTx({
      // SELECT #1 = owner lookup (ours), #2 = existing playlist_climbs.
      selectResults: [[{ upstreamId: 'circuit-1', ownerUserId: 'user-1' }], existing],
      returningRows: [[{ id: BigInt(99) }]],
    });

    const circuitOp = makeCircuitPutOp({ circuit_uuid: 'circuit-1', name: 'Liked Climbs' });
    const climbOps = [
      makeCircuitClimbPutOp({ circuit_uuid: 'circuit-1', climb_uuid: 'climb-A', angle: 25, position: 0 }),
      makeCircuitClimbPutOp({ circuit_uuid: 'circuit-1', climb_uuid: 'climb-B', angle: 25, position: 1 }),
    ];

    await applyCircuits(
      tx as unknown as ApplyCircuitsTx,
      'user-1',
      [circuitOp],
      climbOps,
      aliasCacheFor(['climb-A', 'climb-B']),
    );

    // The angle change must trigger the wipe-and-reinsert path.
    expect(calls.filter((c) => c.kind === 'delete')).toHaveLength(1);
    const climbsInsertCalls = calls.filter((c) => {
      if (c.kind !== 'insert') return false;
      const arg = c.args[0];
      const rows = Array.isArray(arg) ? arg : [arg];
      return (rows as Array<Record<string, unknown>>).some((r) => 'climbUuid' in r);
    });
    expect(climbsInsertCalls).toHaveLength(1);
  });
});

/**
 * #3526: one Kilter account linked to two Boardsesh accounts. `kilter_id` is a
 * GLOBAL unique index, so user B's `ON CONFLICT (kilter_id) DO UPDATE` used to
 * land on user A's playlist row — overwriting its name/description/visibility,
 * wiping and re-inserting its climbs, and handing B an `owner` edge. From there
 * a circuit delete on either Kilter stream destroyed the playlist for both.
 */
describe('applyCircuits — foreign-owner guard (#3526)', () => {
  /** Every write applyCircuits can make. A refusal must produce none of them. */
  const writeCalls = (calls: CallRecord[]) => calls.filter((c) => c.kind !== 'select' && c.kind !== 'conflict');

  it('PUT on a circuit owned by ANOTHER Boardsesh user issues no insert, no update and no delete', async () => {
    const logged: string[] = [];
    const { tx, calls } = createRichTx({
      // Owner lookup: circuit-1's playlist belongs to user-2.
      selectResults: [[{ upstreamId: 'circuit-1', ownerUserId: 'user-2' }]],
      returningRows: [[{ id: BigInt(99) }]],
    });

    const result = await applyCircuits(
      tx as unknown as ApplyCircuitsTx,
      'user-1',
      [makeCircuitPutOp({ circuit_uuid: 'circuit-1', name: 'Renamed By User 1' })],
      [makeCircuitClimbPutOp({ circuit_uuid: 'circuit-1', climb_uuid: 'climb-A', position: 0 })],
      aliasCacheFor(['climb-A']),
      (msg) => logged.push(msg),
    );

    // All three write kinds, asserted separately — the upsert is only one of
    // the ways this used to corrupt the other user's playlist. The ownership
    // INSERT is what granted the second owner; the playlist_climbs DELETE is
    // what wiped their climb list.
    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(0);
    expect(calls.filter((c) => c.kind === 'delete')).toHaveLength(0);
    expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(0);
    expect(writeCalls(calls)).toHaveLength(0);

    expect(result.skippedForeignCircuits).toBe(1);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('circuit-1');
    expect(logged[0]).toContain('user-1');
    expect(logged[0]).toContain('already owned by a different Boardsesh user');
  });

  it('PUT on an already cross-linked playlist this user co-owns is refused as ambiguous', async () => {
    // The 44 legacy prod rows: two `owner` edges on one playlist. Neither
    // co-owner may write it until a human resolves the duplicate accounts.
    const logged: string[] = [];
    const { tx, calls } = createRichTx({
      selectResults: [
        [
          { upstreamId: 'circuit-1', ownerUserId: 'user-1' },
          { upstreamId: 'circuit-1', ownerUserId: 'user-2' },
        ],
      ],
    });

    const result = await applyCircuits(
      tx as unknown as ApplyCircuitsTx,
      'user-1',
      [makeCircuitPutOp({ circuit_uuid: 'circuit-1', name: 'Liked Climbs' })],
      [],
      new Map(),
      (msg) => logged.push(msg),
    );

    expect(writeCalls(calls)).toHaveLength(0);
    expect(result.skippedForeignCircuits).toBe(1);
    expect(logged[0]).toContain('two owners');
  });

  it('PUT still writes when the same user owns the playlist twice over (join fan-out)', async () => {
    // A duplicated row from the join must read as `own`, not `ambiguous`.
    const { tx, calls } = createRichTx({
      selectResults: [
        [
          { upstreamId: 'circuit-1', ownerUserId: 'user-1' },
          { upstreamId: 'circuit-1', ownerUserId: 'user-1' },
        ],
        [],
      ],
      returningRows: [[{ id: BigInt(99) }]],
    });

    const result = await applyCircuits(
      tx as unknown as ApplyCircuitsTx,
      'user-1',
      [makeCircuitPutOp({ circuit_uuid: 'circuit-1', name: 'Liked Climbs' })],
      [],
      new Map(),
    );

    expect(result.skippedForeignCircuits).toBe(0);
    expect(calls.filter((c) => c.kind === 'insert').length).toBeGreaterThan(0);
  });

  it('REMOVE for a circuit owned by another user does not delete their playlist', async () => {
    const logged: string[] = [];
    const { tx, calls } = createRichTx({
      selectResults: [[{ upstreamId: 'circuit-X', ownerUserId: 'user-2' }]],
    });

    const result = await applyCircuits(
      tx as unknown as ApplyCircuitsTx,
      'user-1',
      [{ op_id: '1', op: 'REMOVE', object_type: 'circuits', object_id: 'circuit-X' }],
      [],
      new Map(),
      (msg) => logged.push(msg),
    );

    expect(calls.filter((c) => c.kind === 'delete')).toHaveLength(0);
    expect(result.skippedForeignCircuits).toBe(1);
    expect(logged).toHaveLength(1);
  });

  it('REMOVE on a co-owned playlist does not delete it for either owner', async () => {
    // The pre-fix EXISTS guard passed for BOTH co-owners, so whichever user
    // deleted the circuit on Kilter destroyed it for the other one too.
    const logged: string[] = [];
    const { tx, calls } = createRichTx({
      selectResults: [
        [
          { upstreamId: 'circuit-X', ownerUserId: 'user-1' },
          { upstreamId: 'circuit-X', ownerUserId: 'user-2' },
        ],
      ],
    });

    const result = await applyCircuits(
      tx as unknown as ApplyCircuitsTx,
      'user-1',
      [{ op_id: '1', op: 'REMOVE', object_type: 'circuits', object_id: 'circuit-X' }],
      [],
      new Map(),
      (msg) => logged.push(msg),
    );

    expect(calls.filter((c) => c.kind === 'delete')).toHaveLength(0);
    expect(result.skippedForeignCircuits).toBe(1);
    expect(logged[0]).toContain('two owners');
  });

  it('REMOVE for a circuit we never had is skipped quietly (not a duplicate-account signal)', async () => {
    const logged: string[] = [];
    const { tx, calls } = createRichTx({ selectResults: [[]] });

    const result = await applyCircuits(
      tx as unknown as ApplyCircuitsTx,
      'user-1',
      [{ op_id: '1', op: 'REMOVE', object_type: 'circuits', object_id: 'circuit-gone' }],
      [],
      new Map(),
      (msg) => logged.push(msg),
    );

    expect(calls.filter((c) => c.kind === 'delete')).toHaveLength(0);
    expect(result.skippedForeignCircuits).toBe(0);
    expect(logged).toHaveLength(0);
  });

  it('claims an orphaned playlist that has no owner edge at all', async () => {
    // LEFT join: the playlist row exists but every ownership row is gone.
    // Claimable, not foreign.
    const { tx, calls } = createRichTx({
      selectResults: [[{ upstreamId: 'circuit-1', ownerUserId: null }], []],
      returningRows: [[{ id: BigInt(99) }]],
    });

    const result = await applyCircuits(
      tx as unknown as ApplyCircuitsTx,
      'user-1',
      [makeCircuitPutOp({ circuit_uuid: 'circuit-1', name: 'Orphan' })],
      [],
      new Map(),
    );

    expect(result.skippedForeignCircuits).toBe(0);
    const ownershipInsert = calls.find((c) => {
      if (c.kind !== 'insert') return false;
      const arg = c.args[0];
      const rows = Array.isArray(arg) ? arg : [arg];
      return (rows as Array<Record<string, unknown>>).some((r) => 'role' in r);
    });
    expect(ownershipInsert).toBeDefined();
  });

  it('counts every refused circuit in a mixed batch and writes only the owned one', async () => {
    const logged: string[] = [];
    const { tx } = createRichTx({
      selectResults: [
        [
          { upstreamId: 'mine', ownerUserId: 'user-1' },
          { upstreamId: 'theirs', ownerUserId: 'user-2' },
          { upstreamId: 'shared', ownerUserId: 'user-1' },
          { upstreamId: 'shared', ownerUserId: 'user-2' },
        ],
        [],
      ],
      returningRows: [[{ id: BigInt(99) }]],
    });

    const result = await applyCircuits(
      tx as unknown as ApplyCircuitsTx,
      'user-1',
      [
        makeCircuitPutOp({ circuit_uuid: 'mine', name: 'Mine' }),
        makeCircuitPutOp({ circuit_uuid: 'theirs', name: 'Theirs' }),
        makeCircuitPutOp({ circuit_uuid: 'shared', name: 'Shared' }),
      ],
      [],
      new Map(),
      (msg) => logged.push(msg),
    );

    expect(result.skippedForeignCircuits).toBe(2);
    expect(logged).toHaveLength(2);
  });

  it('renders a correlated NOT EXISTS ownership guard for the ON CONFLICT clause', () => {
    // The JS decision gate takes a consistent read inside the transaction, but
    // two daemons syncing two Boardsesh users on the SAME Kilter account can
    // both read "no playlist yet" and both INSERT — the loser's ON CONFLICT
    // would adopt the winner's row. #3539 (no cross-instance mutual exclusion)
    // widens that window, so the SQL-level guard is load-bearing. Render the
    // production fragment rather than trusting the query builder.
    const rendered = new PgDialect().sqlToQuery(foreignPlaylistOwnerGuard('user-b'));
    expect(rendered.sql).toContain('not exists');
    expect(rendered.sql).toContain('from "playlist_ownership"');
    // Correlated to the CONFLICTING row, which is what makes it valid inside
    // ON CONFLICT DO UPDATE … WHERE.
    expect(rendered.sql).toContain('"playlist_ownership"."playlist_id" = "playlists"."id"');
    expect(rendered.sql).toContain('"playlist_ownership"."user_id" <>');
    expect(rendered.params).toContain('owner');
    expect(rendered.params).toContain('user-b');
  });

  it('attaches that guard to the playlist upsert, not just to a helper nobody calls', async () => {
    const { tx, calls } = createRichTx({
      selectResults: [[], []],
      returningRows: [[{ id: BigInt(99) }]],
    });

    await applyCircuits(
      tx as unknown as ApplyCircuitsTx,
      'user-1',
      [makeCircuitPutOp({ circuit_uuid: 'circuit-1', name: 'Liked Climbs' })],
      [],
      new Map(),
    );

    const conflictClause = calls.find((c) => c.kind === 'conflict')?.args[0] as
      | { target?: unknown; setWhere?: unknown }
      | undefined;
    expect(conflictClause).toBeDefined();
    expect(conflictClause?.setWhere).toBeDefined();
  });

  it('still deletes when a PUT and a REMOVE for the same circuit arrive in one batch', async () => {
    // The owner map is snapshotted before the loop, so the PUT's freshly
    // created ownership edge has to be written back into it — otherwise the
    // REMOVE reads a stale 'adopt', skips the delete, and leaves a row upstream
    // has tombstoned. PowerSync never replays tombstones, so that divergence
    // would be permanent.
    const { tx, calls } = createRichTx({
      // Owner lookup: nothing exists yet. Then the playlist_climbs read.
      selectResults: [[], []],
      returningRows: [[{ id: BigInt(99) }]],
    });

    const result = await applyCircuits(
      tx as unknown as ApplyCircuitsTx,
      'user-1',
      [
        makeCircuitPutOp({ circuit_uuid: 'circuit-1', name: 'Created then deleted' }),
        { op_id: '2', op: 'REMOVE', object_type: 'circuits', object_id: 'circuit-1' },
      ],
      [],
      new Map(),
    );

    // Exactly one delete: the playlists delete from the REMOVE. (The climbs
    // diff short-circuits — incoming and existing are both empty.)
    expect(calls.filter((c) => c.kind === 'delete')).toHaveLength(1);
    expect(result.skippedForeignCircuits).toBe(0);
  });

  it('does not touch climbs or ownership when the SQL race guard suppresses the upsert', async () => {
    // setWhere matched nothing → DO UPDATE was a no-op → .returning() is empty.
    // The rest of the op must be abandoned, not run against an undefined id.
    const { tx, calls } = createRichTx({
      selectResults: [[], []],
      returningRows: [[]],
    });

    const result = await applyCircuits(
      tx as unknown as ApplyCircuitsTx,
      'user-1',
      [makeCircuitPutOp({ circuit_uuid: 'circuit-1', name: 'Lost the race' })],
      [makeCircuitClimbPutOp({ circuit_uuid: 'circuit-1', climb_uuid: 'climb-A', position: 0 })],
      aliasCacheFor(['climb-A']),
    );

    // The playlist upsert itself fired; nothing after it did.
    expect(calls.filter((c) => c.kind === 'delete')).toHaveLength(0);
    const ownershipOrClimbInserts = calls.filter((c) => {
      if (c.kind !== 'insert') return false;
      const arg = c.args[0];
      const rows = Array.isArray(arg) ? arg : [arg];
      return (rows as Array<Record<string, unknown>>).some((r) => 'role' in r || 'climbUuid' in r);
    });
    expect(ownershipOrClimbInserts).toHaveLength(0);
    expect(result.skippedForeignCircuits).toBe(0);
  });

  it('renders the owner lookup with the role filter, LEFT JOIN and kilter_id column', () => {
    // The transaction stub ignores SQL entirely, so without this the owner
    // lookup — which decides every case above — would have no coverage:
    // dropping `role = 'owner'` or swapping the join keeps every other test
    // green.
    // Renders the query selectUpstreamPlaylistOwners actually awaits — a
    // driverless drizzle handle is enough, .toSQL() never touches a connection.
    const rendered = upstreamPlaylistOwnersQuery(renderOnlyDb, playlists.kilterId, ['circuit-1']).toSQL();
    expect(rendered.sql).toContain('from "playlists"');
    expect(rendered.sql).toContain('left join "playlist_ownership"');
    expect(rendered.sql).toContain('"playlist_ownership"."role" =');
    expect(rendered.sql).toContain('"playlists"."kilter_id" in');
    expect(rendered.params).toContain('owner');
    expect(rendered.params).toContain('circuit-1');
  });

  it('renders the REMOVE ownership guard as sole-ownership, not mere membership', async () => {
    // The pre-fix DELETE only asked "do I have an ownership row", which is true
    // for BOTH co-owners of a cross-linked playlist — so either user's circuit
    // delete destroyed the other's. The composed WHERE has to assert both
    // halves: I own it AND nobody else does.
    //
    // Rendered from the condition PRODUCTION passed to .delete().where(), NOT
    // rebuilt here: a rebuilt copy stays green when someone drops
    // foreignPlaylistOwnerGuard from user-sync.ts, silently restoring the
    // destructive half of #3526.
    const { tx, calls } = createRichTx({
      selectResults: [[{ upstreamId: 'circuit-X', ownerUserId: 'user-1' }]],
    });

    await applyCircuits(
      tx as unknown as ApplyCircuitsTx,
      'user-1',
      [{ op_id: '1', op: 'REMOVE', object_type: 'circuits', object_id: 'circuit-X' }],
      [],
      new Map(),
    );

    const deleteCondition = calls.find((c) => c.kind === 'delete')?.args[0];
    expect(deleteCondition).toBeDefined();
    const rendered = new PgDialect().sqlToQuery(deleteCondition as never);
    // "I own it"
    expect(rendered.sql).toContain('exists');
    expect(rendered.sql).toContain('"playlist_ownership"."user_id" =');
    // "...and nobody else does"
    expect(rendered.sql).toContain('not exists');
    expect(rendered.sql).toContain('"playlist_ownership"."user_id" <>');
    // Both correlated to the row being deleted.
    expect(rendered.sql).toContain('"playlist_ownership"."playlist_id" = "playlists"."id"');
    expect(rendered.params.filter((param) => param === 'owner')).toHaveLength(2);
    expect(rendered.params.filter((param) => param === 'user-1')).toHaveLength(2);
  });

  it('chunks the owner lookup so a huge circuit batch stays under the parameter ceiling', async () => {
    // 1200 circuits → 3 statements of 500/500/200, and every uuid must still be
    // probed. An off-by-one in the slice silently drops owners, which reads as
    // 'adopt' and re-opens the cross-link.
    const circuitUuids = Array.from({ length: 1200 }, (_, index) => `circuit-${index}`);
    const seenIds: string[][] = [];
    const stubDb = {
      select: () => ({
        from: () => {
          const source = {
            leftJoin: () => source,
            where: (condition: unknown) => {
              // Pull the bound ids back out of the rendered statement.
              const { params } = new PgDialect().sqlToQuery(condition as never);
              seenIds.push(params.filter((param): param is string => typeof param === 'string' && param !== 'owner'));
              return Promise.resolve([]);
            },
          };
          return source;
        },
      }),
    };

    await selectUpstreamPlaylistOwners(stubDb as never, playlists.kilterId, circuitUuids);

    expect(seenIds.map((ids) => ids.length)).toEqual([500, 500, 200]);
    expect(seenIds.flat()).toEqual(circuitUuids);
  });

  it('refuses a Boardsesh-origin playlist that push-back stamped for the OTHER user (#3525 landmine)', async () => {
    // pushPendingCircuits is stubbed behind pushNotWired today, but the moment
    // it is wired it starts stamping kilter_id onto Boardsesh-ORIGIN playlists.
    // Then user A pushes their hand-built playlist, Kilter hands back a
    // circuit_uuid, and user B — same Kilter login — pulls that circuit. This
    // asserts the guard holds for that direction too: B must not adopt, must
    // not rename, must not wipe A's climbs, and must not be granted ownership
    // of a playlist A built by hand.
    const logged: string[] = [];
    const { tx, calls } = createRichTx({
      selectResults: [[{ upstreamId: 'pushed-circuit', ownerUserId: 'user-a' }]],
      returningRows: [[{ id: BigInt(42) }]],
    });

    const result = await applyCircuits(
      tx as unknown as ApplyCircuitsTx,
      'user-b',
      [makeCircuitPutOp({ circuit_uuid: 'pushed-circuit', name: "A's hand-built list" })],
      [makeCircuitClimbPutOp({ circuit_uuid: 'pushed-circuit', climb_uuid: 'climb-A', position: 0 })],
      aliasCacheFor(['climb-A']),
      (msg) => logged.push(msg),
    );

    expect(writeCalls(calls)).toHaveLength(0);
    expect(result.skippedForeignCircuits).toBe(1);
    expect(logged[0]).toContain('already owned by a different Boardsesh user');
  });
});
