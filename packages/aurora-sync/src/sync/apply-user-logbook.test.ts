import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// Stub only the stats recompute; keep the offset-inference helpers real so the
// cross-source claim exercises the actual matching logic.
vi.mock('@boardsesh/db/queries', async (importActual) => {
  const actual = await importActual<typeof import('@boardsesh/db/queries')>();
  return { ...actual, acquireUserTickMutationLock: vi.fn(), recomputeClimbStatsBulk: vi.fn() };
});

import { recomputeClimbStatsBulk } from '@boardsesh/db/queries';
import { logbookSyncSkips } from '@boardsesh/db/schema';
import { applyAuroraAscents, applyAuroraBids } from './apply-user-logbook';

const recomputeMock = vi.mocked(recomputeClimbStatsBulk);

type CallKind =
  | 'select'
  | 'delete'
  | 'update'
  | 'insert'
  | 'execute'
  // Writes to logbook_sync_skips are tracked under their own kinds so the
  // quarantine (#3871) never inflates the tick-write counts the rest of this
  // suite asserts on.
  | 'skip-insert'
  | 'skip-delete'
  // A savepoint that rolled back — what keeps the caller's cross-table
  // transaction alive when a batched chunk write is refused.
  | 'rollback';
type CallRecord = { kind: CallKind; args: unknown[]; where?: unknown };
type Row = Record<string, unknown>;

/** Everything a write carries, flattened, so a test can match a poison row in it. */
function writeFingerprint(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/**
 * Hand-rolled Drizzle-tx shim, same philosophy as the kilter-sync suite: no
 * real DB, records every call, returns seeded SELECT results in order.
 *
 * `rejectTickWritesContaining` simulates Postgres refusing a statement: ANY
 * boardsesh_ticks write whose bound content mentions the marker throws, exactly
 * as a real constraint violation would — so a batched write covering the poison
 * row fails, and the row-by-row replay then fails only on that one row.
 */
function createTx(opts: { selectResults?: Row[][]; rejectTickWritesContaining?: string } = {}) {
  const calls: CallRecord[] = [];
  const selectResults = opts.selectResults ?? [];
  let selectIdx = 0;
  const insertValues: Row[][] = [];
  const skipRows: Row[] = [];
  const marker = opts.rejectTickWritesContaining;

  const refuseIfPoisoned = (fingerprint: string) => {
    if (marker !== undefined && fingerprint.includes(marker)) {
      const error = new Error(`null value in column "angle" violates not-null constraint (marker ${marker})`);
      Object.assign(error, { code: '23502' });
      throw error;
    }
  };

  const tx = {
    select(cols: unknown) {
      const call: CallRecord = { kind: 'select', args: [cols] };
      calls.push(call);
      const next = selectResults[selectIdx++] ?? [];
      return {
        from: (_t: unknown) => ({
          where: (cond: unknown) => {
            call.where = cond;
            return Promise.resolve(next);
          },
        }),
      };
    },
    delete(table: unknown) {
      const isSkips = table === logbookSyncSkips;
      return {
        where: (cond: unknown) => {
          calls.push({ kind: isSkips ? 'skip-delete' : 'delete', args: [cond] });
          return Promise.resolve();
        },
      };
    },
    update(_t: unknown) {
      return {
        set: (setValues: Row) => ({
          where: (cond: unknown) => {
            calls.push({ kind: 'update', args: [setValues, cond] });
            return Promise.resolve();
          },
        }),
      };
    },
    insert(table: unknown) {
      const isSkips = table === logbookSyncSkips;
      return {
        values: (rows: Row[]) => {
          calls.push({ kind: isSkips ? 'skip-insert' : 'insert', args: [rows] });
          if (isSkips) {
            skipRows.push(...rows);
          } else {
            refuseIfPoisoned(writeFingerprint(rows));
            insertValues.push(rows);
          }
          // Thenable so both `await …values(rows)` and
          // `await …values(rows).onConflictDoUpdate(…)` work.
          const result = Promise.resolve();
          return Object.assign(result, { onConflictDoUpdate: (_cfg: unknown) => result });
        },
      };
    },
    execute(query: unknown) {
      calls.push({ kind: 'execute', args: [query] });
      refuseIfPoisoned(writeFingerprint(new PgDialect().sqlToQuery(query as SQL).params));
      return Promise.resolve([]);
    },
    /**
     * drizzle's nested transaction — a SAVEPOINT on postgres-js. On throw the
     * real driver issues ROLLBACK TO SAVEPOINT and rethrows, leaving the OUTER
     * transaction usable; that is precisely the property under test, so the
     * shim reproduces it rather than swallowing.
     */
    // `inner` is deliberately `unknown`: annotating it as `typeof tx` would make
    // tx self-referential (TS7022). Production casts the handle anyway.
    async transaction<T>(fn: (inner: unknown) => Promise<T>): Promise<T> {
      try {
        return await fn(tx);
      } catch (error) {
        calls.push({ kind: 'rollback', args: [error] });
        throw error;
      }
    },
  };

  return { tx, calls, insertValues, skipRows };
}

type Db = Parameters<typeof applyAuroraAscents>[0];

function ascent(overrides: Row = {}): Row {
  return {
    uuid: 'aur-1',
    climb_uuid: 'climb-1',
    angle: 40,
    is_mirror: false,
    attempt_id: 2,
    bid_count: 3,
    quality: 3,
    difficulty: 20,
    is_benchmark: false,
    is_listed: true,
    comment: '',
    climbed_at: '2026-05-01 22:00:00',
    created_at: '2026-05-01 22:05:00',
    ...overrides,
  };
}

function bid(overrides: Row = {}): Row {
  return {
    uuid: 'bid-1',
    climb_uuid: 'climb-2',
    angle: 25,
    is_mirror: false,
    bid_count: 2,
    comment: '',
    climbed_at: '2026-05-01 09:00:00',
    created_at: '2026-05-01 09:05:00',
    ...overrides,
  };
}

beforeEach(() => recomputeMock.mockClear());

describe('applyAuroraAscents — timezone + insert', () => {
  it('stores climbed_at as UTC ISO (naive Aurora string pinned to UTC, not server-local)', async () => {
    const { tx, insertValues, calls } = createTx({ selectResults: [[], []] });
    await applyAuroraAscents(tx as unknown as Db, 'kilter', 'user-1', [ascent()]);

    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(1);
    const row = insertValues[0][0];
    // "2026-05-01 22:00:00" is UTC → exactly this instant, regardless of host TZ.
    expect(row.climbedAt).toBe('2026-05-01T22:00:00.000Z');
    expect(row.createdAt).toBe('2026-05-01T22:05:00.000Z');
    expect(row).toMatchObject({
      auroraId: 'aur-1',
      origin: 'aurora_pull',
      status: 'send',
      attemptCount: 3,
      // raw Aurora quality 3 → Boardsesh 5.
      quality: 5,
      auroraType: 'ascents',
    });
    expect(recomputeMock).toHaveBeenCalledTimes(1);
  });
});

describe('applyAuroraAscents — cross-source claim', () => {
  it('claims an existing json_import row instead of inserting a twin (same UTC climbed_at)', async () => {
    const { tx, calls, insertValues } = createTx({
      selectResults: [
        [], // byAuroraId miss (new real uuid)
        [
          {
            uuid: 'tick-json',
            climbUuid: 'climb-1',
            angle: 40,
            climbedAt: '2026-05-01T22:00:00.000Z', // identical instant after normalize
            status: 'send',
          },
        ],
      ],
    });

    await applyAuroraAscents(tx as unknown as Db, 'kilter', 'user-1', [ascent()]);

    // Claim UPDATE (execute), no insert twin.
    expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(1);
    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(0);
    expect(insertValues).toHaveLength(0);
  });

  it('claims a timezone-shifted json_import original via the inferred offset', async () => {
    // Existing original 10h ahead (pre-fix shifted); the pull is honest UTC.
    const { tx, calls, insertValues } = createTx({
      selectResults: [
        [],
        [
          {
            uuid: 'tick-json',
            climbUuid: 'climb-1',
            angle: 40,
            climbedAt: '2026-05-02T08:00:00.000Z', // +10h vs the incoming 22:00Z
            status: 'send',
          },
        ],
      ],
    });

    await applyAuroraAscents(tx as unknown as Db, 'kilter', 'user-1', [ascent()]);

    expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(1);
    expect(insertValues).toHaveLength(0);
  });

  it("never touches another user's row holding the same aurora_id (duplicate account link)", async () => {
    // The by-aurora-id SELECT is global (the unique index means one row
    // table-wide); a hit owned by a DIFFERENT user must be skipped entirely:
    // no update (cross-user clobber), no claim, and no insert (which would
    // collide on boardsesh_ticks_aurora_id_unique and abort the chunk).
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { tx, calls, insertValues } = createTx({
        selectResults: [
          [
            {
              uuid: 'tick-foreign',
              auroraId: 'aur-1', // same aurora_id as the incoming ascent
              ownerUserId: 'user-OTHER', // owned by a different Boardsesh user
              climbUuid: 'climb-1',
              angle: 40,
              isMirror: false,
              status: 'send',
              attemptCount: 3,
              quality: 3,
              difficulty: 20,
              isBenchmark: false,
              comment: '',
              climbedAt: '2026-05-01T22:00:00.000Z',
              updatedAt: '2026-05-01T22:00:00.000Z',
              auroraSyncedAt: '2026-05-01T22:00:00.000Z',
              origin: 'aurora_pull',
            },
          ],
        ],
      });

      await applyAuroraAscents(tx as unknown as Db, 'kilter', 'user-1', [ascent()]);

      // Only the by-aurora-id SELECT ran — the foreign id is excluded from the
      // misses, so no claim SELECT, no UPDATE, no INSERT: the foreign row is
      // untouched and nothing collides.
      expect(calls.filter((c) => c.kind === 'select')).toHaveLength(1);
      expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(0);
      expect(calls.filter((c) => c.kind === 'update')).toHaveLength(0);
      expect(insertValues).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('already linked to a different Boardsesh user'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('fetches claim candidates with a row-value (climb_uuid, angle) tuple filter, not a cartesian pair of IN-lists', async () => {
    // Two misses at DIFFERENT (climb, angle) pairs. Separate
    // IN(climb_uuid) × IN(angle) lists would also fetch the cross pairs
    // (climb-1, 25) and (climb-2, 40); the tuple filter must pin exactly the
    // two real pairs.
    const { tx, calls } = createTx({ selectResults: [[], []] });

    await applyAuroraAscents(tx as unknown as Db, 'kilter', 'user-1', [
      ascent({ uuid: 'aur-1', climb_uuid: 'climb-1', angle: 40 }),
      ascent({ uuid: 'aur-2', climb_uuid: 'climb-2', angle: 25 }),
    ]);

    const claimSelect = calls.filter((c) => c.kind === 'select')[1];
    expect(claimSelect).toBeDefined();
    const rendered = new PgDialect().sqlToQuery(claimSelect.where as SQL);

    // Row-value tuple membership, not two independent column IN-lists.
    expect(rendered.sql).toContain('("boardsesh_ticks"."climb_uuid", "boardsesh_ticks"."angle") IN (');
    expect(rendered.sql).not.toMatch(/"climb_uuid" in \(/i);
    expect(rendered.sql).not.toMatch(/"angle" in \(/i);
    // Exactly the two real pairs are bound, adjacent per tuple — the cross
    // pairs never reach SQL.
    const pairParams = rendered.params.filter((p) => p === 'climb-1' || p === 'climb-2' || p === 40 || p === 25);
    expect(pairParams).toEqual(['climb-1', 40, 'climb-2', 25]);
  });

  it('excludes already-Aurora-linked rows from claim candidates (only unlinked / json-import placeholders are claimable)', async () => {
    const { tx, calls } = createTx({ selectResults: [[], []] });

    await applyAuroraAscents(tx as unknown as Db, 'kilter', 'user-1', [ascent()]);

    const claimSelect = calls.filter((c) => c.kind === 'select')[1];
    const rendered = new PgDialect().sqlToQuery(claimSelect.where as SQL);
    const lower = rendered.sql.toLowerCase();
    // A row already carrying a real aurora_id must not be a claim candidate —
    // overwriting it would orphan the original upstream link.
    expect(lower).toContain('"aurora_id" is null');
    expect(lower).toContain("like 'json-import-%'");
  });
});

describe('applyAuroraAscents — is_listed soft-delete', () => {
  it('deletes a pull-owned (aurora_pull) row on is_listed=false', async () => {
    const { tx, calls } = createTx({
      selectResults: [[{ uuid: 'tick-pull', climbUuid: 'climb-1', angle: 40, origin: 'aurora_pull' }]],
    });

    await applyAuroraAscents(tx as unknown as Db, 'kilter', 'user-1', [ascent({ is_listed: false })]);

    expect(calls.filter((c) => c.kind === 'delete')).toHaveLength(1);
    expect(calls.filter((c) => c.kind === 'update')).toHaveLength(0);
    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(0);
    expect(recomputeMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a claimed native/json_import row but clears its aurora markers on is_listed=false', async () => {
    const { tx, calls } = createTx({
      selectResults: [[{ uuid: 'tick-native', climbUuid: 'climb-1', angle: 40, origin: 'native' }]],
    });

    await applyAuroraAscents(tx as unknown as Db, 'kilter', 'user-1', [ascent({ is_listed: false })]);

    expect(calls.filter((c) => c.kind === 'delete')).toHaveLength(0);
    const updates = calls.filter((c) => c.kind === 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0].args[0]).toMatchObject({
      auroraId: null,
      auroraType: null,
      auroraSyncedAt: null,
      auroraSyncError: null,
    });
  });
});

describe('applyAuroraAscents — edit-clobber guard', () => {
  it('does not overwrite a locally-edited row on a by-aurora-id re-sync', async () => {
    const { tx, calls } = createTx({
      selectResults: [
        [
          {
            uuid: 'tick-1',
            auroraId: 'aur-1',
            ownerUserId: 'user-1',
            climbUuid: 'climb-1',
            angle: 40,
            isMirror: false,
            status: 'send',
            attemptCount: 1, // differs from incoming (3) — a real change...
            quality: 5,
            difficulty: 20,
            isBenchmark: false,
            comment: '',
            climbedAt: '2026-05-01T22:00:00.000Z',
            updatedAt: '2026-05-02T00:00:00.000Z', // ...but locally edited after sync
            auroraSyncedAt: '2026-05-01T22:05:00.000Z',
            origin: 'aurora_pull',
          },
        ],
      ],
    });

    await applyAuroraAscents(tx as unknown as Db, 'kilter', 'user-1', [ascent()]);

    // No claim/update execute, no insert — the local edit is protected.
    expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(0);
    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(0);
  });

  it('skips a no-op by-aurora-id re-sync (payload identical)', async () => {
    const { tx, calls } = createTx({
      selectResults: [
        [
          {
            uuid: 'tick-1',
            auroraId: 'aur-1',
            ownerUserId: 'user-1',
            climbUuid: 'climb-1',
            angle: 40,
            isMirror: false,
            status: 'send',
            attemptCount: 3,
            quality: 5,
            difficulty: 20,
            isBenchmark: false,
            comment: '',
            climbedAt: '2026-05-01T22:00:00.000Z',
            updatedAt: '2026-05-01T22:05:00.000Z',
            auroraSyncedAt: '2026-05-01T22:05:00.000Z',
            origin: 'aurora_pull',
          },
        ],
      ],
    });

    await applyAuroraAscents(tx as unknown as Db, 'kilter', 'user-1', [ascent()]);

    expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(0);
    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(0);
  });

  it('applies a real by-aurora-id change (quality edit upstream)', async () => {
    const { tx, calls } = createTx({
      selectResults: [
        [
          {
            uuid: 'tick-1',
            auroraId: 'aur-1',
            ownerUserId: 'user-1',
            climbUuid: 'climb-1',
            angle: 40,
            isMirror: false,
            status: 'send',
            attemptCount: 3,
            quality: 3, // stored 3, incoming resolves to 5 → real change
            difficulty: 20,
            isBenchmark: false,
            comment: '',
            climbedAt: '2026-05-01T22:00:00.000Z',
            updatedAt: '2026-05-01T22:05:00.000Z',
            auroraSyncedAt: '2026-05-01T22:05:00.000Z',
            origin: 'aurora_pull',
          },
        ],
      ],
    });

    await applyAuroraAscents(tx as unknown as Db, 'kilter', 'user-1', [ascent()]);

    expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(1);
    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(0);
  });
});

describe('applyAuroraAscents — corrected legacy climbed_at is not reverted (#3909)', () => {
  /**
   * The self-revert loop. Once a legacy tick's climbed_at is corrected to the
   * true UTC instant, the Aurora pull keeps sending the climber's local wall
   * clock relabelled UTC — so stored − incoming is a whole zone offset. Without
   * the guard the by-aurora-id update path calls that a payload change and
   * writes the shifted value straight back, inside one sync cycle.
   */
  const correctedRow = (overrides: Row = {}): Row => ({
    uuid: 'tick-1',
    auroraId: 'aur-1',
    ownerUserId: 'user-1',
    climbUuid: 'climb-1',
    angle: 40,
    isMirror: false,
    status: 'send',
    attemptCount: 3,
    quality: 5,
    difficulty: 20,
    isBenchmark: false,
    comment: '',
    // Corrected: the pull will send "2026-05-01 22:00:00" (local wall clock),
    // 10h ahead of this true instant.
    climbedAt: '2026-05-01T12:00:00.000Z',
    updatedAt: '2026-05-01T22:05:00.000Z',
    auroraSyncedAt: '2026-05-01T22:05:00.000Z',
    origin: 'json_import',
    ...overrides,
  });

  it('writes nothing when the ONLY difference is a whole-offset shift', async () => {
    const { tx, calls } = createTx({ selectResults: [[correctedRow()]] });

    await applyAuroraAscents(tx as unknown as Db, 'kilter', 'user-1', [ascent()]);

    expect(calls.filter((c) => c.kind === 'execute')).toHaveLength(0);
    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(0);
  });

  it('still applies other upstream edits, but keeps the corrected timestamp', async () => {
    const { tx, calls } = createTx({ selectResults: [[correctedRow({ quality: 3 })]] });

    await applyAuroraAscents(tx as unknown as Db, 'kilter', 'user-1', [ascent()]);

    const executes = calls.filter((c) => c.kind === 'execute');
    expect(executes).toHaveLength(1);
    const params = new PgDialect().sqlToQuery(executes[0].args[0] as SQL).params;
    const payload = JSON.parse(params.find((p) => typeof p === 'string' && p.startsWith('[{')) as string) as Array<{
      climbed_at: string;
    }>;
    // The quality edit lands; climbed_at is the STORED corrected instant, not
    // the shifted "2026-05-01T22:00:00.000Z" the pull sent.
    expect(payload[0].climbed_at).toBe('2026-05-01T12:00:00.000Z');
  });

  it('does NOT swallow a genuine sub-hour edit to climbed_at', async () => {
    // 5 minutes is a real correction by the climber upstream and must still
    // propagate — the guard is deliberately narrower than the ±60s adoption
    // fast path for exactly this reason.
    const { tx, calls } = createTx({
      selectResults: [[correctedRow({ climbedAt: '2026-05-01T21:55:00.000Z' })]],
    });

    await applyAuroraAscents(tx as unknown as Db, 'kilter', 'user-1', [ascent()]);

    const executes = calls.filter((c) => c.kind === 'execute');
    expect(executes).toHaveLength(1);
    const params = new PgDialect().sqlToQuery(executes[0].args[0] as SQL).params;
    const payload = JSON.parse(params.find((p) => typeof p === 'string' && p.startsWith('[{')) as string) as Array<{
      climbed_at: string;
    }>;
    expect(payload[0].climbed_at).toBe('2026-05-01T22:00:00.000Z');
  });
});

describe('applyAuroraBids', () => {
  it('inserts an attempt with UTC climbed_at and no tombstone handling', async () => {
    const { tx, insertValues, calls } = createTx({ selectResults: [[], []] });
    await applyAuroraBids(tx as unknown as Db, 'kilter', 'user-1', [
      {
        uuid: 'bid-1',
        climb_uuid: 'climb-2',
        angle: 25,
        is_mirror: false,
        bid_count: 2,
        comment: '',
        climbed_at: '2026-05-01 09:00:00',
        created_at: '2026-05-01 09:00:00',
      },
    ]);

    expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(1);
    expect(insertValues[0][0]).toMatchObject({
      status: 'attempt',
      origin: 'aurora_pull',
      auroraType: 'bids',
      climbedAt: '2026-05-01T09:00:00.000Z',
      attemptCount: 2,
    });
  });
});

// #3520: the reported crash site (an unguarded `new Date(item.created_at)`
// directly in the bids upsert case of user-sync.ts) was already removed by
// the 71937db6a timezone-correctness refactor, which routed both ascents and
// bids through the shared normalize functions below with an identical
// created_at → climbed_at fallback. This block is a regression test for that
// fallback on the bids side specifically (previously only asserted for
// ascents), plus coverage for the same-family gaps that refactor left open:
// climbedAt has no fallback at all, and the created_at ternary only guards
// falsy values, not malformed-but-truthy ones.
describe('applyAuroraBids — created_at guard', () => {
  it('falls back to climbed_at when created_at is missing (mirrors the ascents guard)', async () => {
    const { tx, insertValues } = createTx({ selectResults: [[], []] });
    await applyAuroraBids(tx as unknown as Db, 'kilter', 'user-1', [bid({ created_at: undefined })]);

    expect(insertValues[0][0]).toMatchObject({
      climbedAt: '2026-05-01T09:00:00.000Z',
      createdAt: '2026-05-01T09:00:00.000Z',
    });
  });
});

// The actual remaining bug behind #3520 staying open: applyAuroraBids and
// applyAuroraAscents run inside syncUserData's single cross-table
// transaction, so an uncaught throw while normalizing ONE row rolls back
// every other table already synced this attempt and blocks the checkpoint
// from advancing — the next attempt just re-fetches and re-crashes on the
// same poison row forever. These tests assert a malformed row is logged and
// skipped instead of thrown, and every other row in the same payload still
// lands.
describe('applyAuroraBids — malformed-row isolation (#3520)', () => {
  it('skips a bid with an unparseable created_at, warns, and still inserts the rest of the batch', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { tx, insertValues, calls } = createTx({ selectResults: [[], []] });
      await applyAuroraBids(tx as unknown as Db, 'kilter', 'user-1', [
        bid({ uuid: 'bid-bad', created_at: 'not-a-date' }),
        bid({ uuid: 'bid-good' }),
      ]);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('bid-bad'));
      expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(1);
      expect(insertValues[0]).toHaveLength(1);
      expect(insertValues[0][0]).toMatchObject({ auroraId: 'bid-good' });
      expect(recomputeMock).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('skips a bid with a missing climbed_at, warns, and still inserts the rest of the batch', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { tx, insertValues, calls } = createTx({ selectResults: [[], []] });
      await applyAuroraBids(tx as unknown as Db, 'kilter', 'user-1', [
        bid({ uuid: 'bid-bad', climbed_at: undefined }),
        bid({ uuid: 'bid-good' }),
      ]);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('bid-bad'));
      expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(1);
      expect(insertValues[0]).toHaveLength(1);
      expect(insertValues[0][0]).toMatchObject({ auroraId: 'bid-good' });
      expect(recomputeMock).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('applyAuroraAscents — malformed-row isolation (#3520)', () => {
  it('skips an ascent with a missing climbed_at, warns, and still inserts the rest of the batch', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { tx, insertValues, calls } = createTx({ selectResults: [[], []] });
      await applyAuroraAscents(tx as unknown as Db, 'kilter', 'user-1', [
        ascent({ uuid: 'aur-bad', climbed_at: undefined }),
        ascent({ uuid: 'aur-good' }),
      ]);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('aur-bad'));
      expect(calls.filter((c) => c.kind === 'insert')).toHaveLength(1);
      expect(insertValues[0]).toHaveLength(1);
      expect(insertValues[0][0]).toMatchObject({ auroraId: 'aur-good' });
      expect(recomputeMock).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('applyLogbookChunk — DB-level write isolation (#3871)', () => {
  it("does not abort the caller's transaction when Postgres refuses a row: rolls back to the savepoint and resolves", async () => {
    // THE bug. applyAuroraAscents runs inside syncUserData's ONE transaction
    // spanning every synced table plus the sync checkpoint, and ascents are
    // applied BEFORE bids, tags and circuits. A throw here rolls all of them
    // back and stops the watermark advancing, so the next cycle re-fetches the
    // same row and re-crashes — forever. Resolving is what lets the rest of
    // that loop run at all.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { tx, calls } = createTx({
        selectResults: [[], []],
        rejectTickWritesContaining: 'aur-poison',
      });

      await expect(
        applyAuroraAscents(tx as unknown as Db, 'kilter', 'user-1', [
          ascent({ uuid: 'aur-poison', climb_uuid: 'climb-1' }),
        ]),
      ).resolves.toBeUndefined();

      // The savepoint absorbed it — that is the whole mechanism.
      expect(calls.filter((c) => c.kind === 'rollback').length).toBeGreaterThan(0);
      // And the handle stayed usable afterwards: the quarantine write ran on it.
      expect(calls.filter((c) => c.kind === 'skip-insert')).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('replays the chunk row by row so only the refused row is lost', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { tx, insertValues, calls } = createTx({
        selectResults: [[], []],
        rejectTickWritesContaining: 'aur-poison',
      });

      await applyAuroraAscents(tx as unknown as Db, 'kilter', 'user-1', [
        ascent({ uuid: 'aur-ok-1', climb_uuid: 'climb-1' }),
        ascent({ uuid: 'aur-poison', climb_uuid: 'climb-2' }),
        ascent({ uuid: 'aur-ok-2', climb_uuid: 'climb-3' }),
      ]);

      // Batched INSERT refused → three single-row INSERTs, two of which land.
      const landed = insertValues.flat().map((row) => row.auroraId);
      expect(landed).toEqual(['aur-ok-1', 'aur-ok-2']);
      expect(calls.filter((c) => c.kind === 'rollback')).toHaveLength(2); // batch + the one bad row
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('isolates a refused row in the jsonb_to_recordset UPDATE path too, not just the INSERT', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const stored = (auroraId: string, climbUuid: string): Row => ({
        uuid: `tick-${auroraId}`,
        auroraId,
        ownerUserId: 'user-1',
        climbUuid,
        angle: 40,
        isMirror: false,
        status: 'send',
        attemptCount: 1, // differs from the incoming bid_count → a real update
        quality: 5,
        difficulty: 20,
        isBenchmark: false,
        comment: '',
        climbedAt: '2026-05-01T22:00:00.000Z',
        updatedAt: '2026-05-01T22:00:00.000Z',
        auroraSyncedAt: '2026-05-01T22:30:00.000Z',
        origin: 'aurora_pull',
      });

      const { tx, calls, skipRows } = createTx({
        selectResults: [[stored('aur-ok-1', 'climb-1'), stored('aur-poison', 'climb-2')]],
        rejectTickWritesContaining: 'aur-poison',
      });

      await applyAuroraAscents(tx as unknown as Db, 'kilter', 'user-1', [
        ascent({ uuid: 'aur-ok-1', climb_uuid: 'climb-1' }),
        ascent({ uuid: 'aur-poison', climb_uuid: 'climb-2' }),
      ]);

      expect(calls.filter((c) => c.kind === 'rollback')).toHaveLength(2);
      expect(skipRows).toHaveLength(1);
      expect(skipRows[0]).toMatchObject({ auroraId: 'aur-poison', reason: 'db_write_rejected' });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('quarantines the refused row with its payload so the drop is replayable, not silent data loss', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { tx, skipRows } = createTx({
        selectResults: [[], []],
        rejectTickWritesContaining: 'aur-poison',
      });

      await applyAuroraAscents(tx as unknown as Db, 'kilter', 'user-1', [
        ascent({ uuid: 'aur-poison', climb_uuid: 'climb-9', angle: 45 }),
      ]);

      expect(skipRows).toHaveLength(1);
      expect(skipRows[0]).toMatchObject({
        userId: 'user-1',
        boardType: 'kilter',
        auroraType: 'ascents',
        auroraId: 'aur-poison',
        reason: 'db_write_rejected',
        seenCount: 1,
      });
      // The payload is the point: without it a drop is indistinguishable from
      // throwing the climber's send away.
      expect(skipRows[0].payload).toMatchObject({ auroraId: 'aur-poison', climbUuid: 'climb-9', angle: 45 });
      expect(String(skipRows[0].detail)).toContain('not-null constraint');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('pre-write validation (#3871)', () => {
  it('never lets a non-finite angle reach the DB or the stats recompute', async () => {
    // The row-by-row fallback does NOT cover this: `angle` also feeds
    // recomputeClimbStatsBulk's own jsonb_to_recordset(… angle integer) +
    // INSERT INTO board_climb_stats, which runs after the chunk loop and
    // outside any write fallback. Validation is the only guard there.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { tx, insertValues, calls } = createTx({ selectResults: [[], []] });

      await applyAuroraAscents(tx as unknown as Db, 'kilter', 'user-1', [
        ascent({ uuid: 'aur-bad-angle', angle: 'not-a-number' }),
        ascent({ uuid: 'aur-good', climb_uuid: 'climb-good' }),
      ]);

      // Never bound into a statement…
      const written = insertValues.flat().map((row) => row.auroraId);
      expect(written).toEqual(['aur-good']);
      // …and never handed to the recompute either.
      const keys = recomputeMock.mock.calls[0][1];
      expect(keys.every((key) => Number.isInteger(key.angle))).toBe(true);
      expect(keys.some((key) => key.climbUuid === 'climb-1')).toBe(false);
      // No DB write was even attempted, so this is validation, not the fallback.
      expect(calls.filter((c) => c.kind === 'rollback')).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('records an angle drop under its own reason code, distinct from a DB refusal', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { tx, skipRows } = createTx({ selectResults: [[], []] });

      await applyAuroraAscents(tx as unknown as Db, 'kilter', 'user-1', [
        ascent({ uuid: 'aur-bad-angle', angle: Number.NaN }),
      ]);

      expect(skipRows).toHaveLength(1);
      expect(skipRows[0]).toMatchObject({ auroraId: 'aur-bad-angle', reason: 'invalid_angle' });
      // The raw upstream item is kept, so a fixed row can be replayed.
      expect(skipRows[0].payload).toMatchObject({ uuid: 'aur-bad-angle', climb_uuid: 'climb-1' });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('coerces a garbage bid_count to the column default instead of dropping the send', async () => {
    const { tx, insertValues } = createTx({ selectResults: [[], []] });

    await applyAuroraAscents(tx as unknown as Db, 'kilter', 'user-1', [ascent({ bid_count: 'lots' })]);

    expect(insertValues[0][0]).toMatchObject({ auroraId: 'aur-1', attemptCount: 1 });
  });

  it('nulls a fractional difficulty rather than letting "21.5" hit an integer column', async () => {
    const { tx, insertValues } = createTx({ selectResults: [[], []] });

    await applyAuroraAscents(tx as unknown as Db, 'kilter', 'user-1', [ascent({ difficulty: 21.5 })]);

    expect(insertValues[0][0]).toMatchObject({ auroraId: 'aur-1', difficulty: null });
  });

  it('strips a NUL byte from a comment and still writes the send', async () => {
    const { tx, insertValues } = createTx({ selectResults: [[], []] });

    await applyAuroraAscents(tx as unknown as Db, 'kilter', 'user-1', [ascent({ comment: 'sick \u0000line' })]);

    expect(insertValues[0][0]).toMatchObject({ auroraId: 'aur-1', comment: 'sick line' });
  });

  it('drops a row whose identity column carries an unstorable byte', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { tx, insertValues, skipRows } = createTx({ selectResults: [[], []] });

      await applyAuroraAscents(tx as unknown as Db, 'kilter', 'user-1', [
        ascent({ uuid: 'aur-bad', climb_uuid: 'climb\u0000-1' }),
        ascent({ uuid: 'aur-good', climb_uuid: 'climb-2' }),
      ]);

      expect(insertValues.flat().map((row) => row.auroraId)).toEqual(['aur-good']);
      expect(skipRows[0]).toMatchObject({ auroraId: 'aur-bad', reason: 'invalid_identity' });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('collapses a duplicate aurora_id in one payload before it can collide on the unique index', async () => {
    // Both copies are misses, so both would be INSERTed and
    // boardsesh_ticks_aurora_id_unique would abort the chunk —
    // deterministically, every cycle, forever.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { tx, insertValues } = createTx({ selectResults: [[], []] });

      await applyAuroraAscents(tx as unknown as Db, 'kilter', 'user-1', [
        ascent({ uuid: 'aur-dup', comment: 'first' }),
        ascent({ uuid: 'aur-dup', comment: 'second' }),
      ]);

      const written = insertValues.flat();
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({ auroraId: 'aur-dup', comment: 'second' });
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('logbook_sync_skips reconciliation (#3871)', () => {
  it('clears the quarantine for a row that now syncs cleanly, so the table is state and not a growing log', async () => {
    const { tx, calls } = createTx({ selectResults: [[], []] });

    await applyAuroraAscents(tx as unknown as Db, 'kilter', 'user-1', [ascent({ uuid: 'aur-1' })]);

    expect(calls.filter((c) => c.kind === 'skip-delete')).toHaveLength(1);
    expect(calls.filter((c) => c.kind === 'skip-insert')).toHaveLength(0);
  });

  it('does not clear the quarantine for a row that was refused again in the same run', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { tx, calls } = createTx({
        selectResults: [[], []],
        rejectTickWritesContaining: 'aur-poison',
      });

      await applyAuroraAscents(tx as unknown as Db, 'kilter', 'user-1', [
        ascent({ uuid: 'aur-poison', climb_uuid: 'climb-1' }),
      ]);

      // Nothing resolved → no DELETE at all; the record must survive to be seen.
      expect(calls.filter((c) => c.kind === 'skip-delete')).toHaveLength(0);
      expect(calls.filter((c) => c.kind === 'skip-insert')).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('records a bid skip under aurora_type=bids', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { tx, skipRows } = createTx({ selectResults: [[], []] });

      await applyAuroraBids(tx as unknown as Db, 'tension', 'user-2', [bid({ uuid: 'bid-bad', angle: undefined })]);

      expect(skipRows[0]).toMatchObject({
        userId: 'user-2',
        boardType: 'tension',
        auroraType: 'bids',
        auroraId: 'bid-bad',
        reason: 'invalid_angle',
      });
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('applyLogbookChunk — claim UPDATE isolation (#3871)', () => {
  it('isolates a refused row in the cross-source claim UPDATE, the third write path', async () => {
    // The claim path binds only {uuid, aurora_id}, so it looks harmless — but
    // it is a batched statement like the other two and fails the same way.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { tx, calls, skipRows } = createTx({
        selectResults: [
          [], // byAuroraId: both incoming rows are misses
          [
            // Claimable json_import originals at the same instant.
            {
              uuid: 'tick-ok',
              climbUuid: 'climb-1',
              angle: 40,
              climbedAt: '2026-05-01T22:00:00.000Z',
              status: 'send',
            },
            {
              uuid: 'tick-poison',
              climbUuid: 'climb-2',
              angle: 40,
              climbedAt: '2026-05-01T22:00:00.000Z',
              status: 'send',
            },
          ],
        ],
        rejectTickWritesContaining: 'aur-poison',
      });

      await applyAuroraAscents(tx as unknown as Db, 'kilter', 'user-1', [
        ascent({ uuid: 'aur-ok', climb_uuid: 'climb-1' }),
        ascent({ uuid: 'aur-poison', climb_uuid: 'climb-2' }),
      ]);

      // Batched claim refused, then replayed per row: the clean claim lands.
      expect(calls.filter((c) => c.kind === 'rollback')).toHaveLength(2);
      expect(skipRows).toHaveLength(1);
      expect(skipRows[0]).toMatchObject({ auroraId: 'aur-poison', reason: 'db_write_rejected' });
      // The quarantined payload carries the whole row, not just the link —
      // {uuid, aurora_id} alone could never be replayed into a tick.
      expect(skipRows[0].payload).toMatchObject({
        claimedTickUuid: 'tick-poison',
        row: { auroraId: 'aur-poison', climbUuid: 'climb-2', angle: 40 },
      });
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('applyAuroraBids — DB-level write isolation (#3871)', () => {
  it('isolates a refused bid the same way as an ascent, end to end through applyAuroraBids', async () => {
    // applyAuroraBids shares applyLogbookChunk with ascents, but "shares the
    // machinery" is an inference; bids reach it via a different entry point
    // (no tombstone pass, different claim statuses), so drive it directly.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { tx, insertValues, calls, skipRows } = createTx({
        selectResults: [[], []],
        rejectTickWritesContaining: 'bid-poison',
      });

      await expect(
        applyAuroraBids(tx as unknown as Db, 'tension', 'user-2', [
          bid({ uuid: 'bid-ok-1', climb_uuid: 'climb-1' }),
          bid({ uuid: 'bid-poison', climb_uuid: 'climb-2' }),
          bid({ uuid: 'bid-ok-2', climb_uuid: 'climb-3' }),
        ]),
      ).resolves.toBeUndefined();

      expect(insertValues.flat().map((row) => row.auroraId)).toEqual(['bid-ok-1', 'bid-ok-2']);
      expect(calls.filter((c) => c.kind === 'rollback')).toHaveLength(2);
      expect(skipRows).toHaveLength(1);
      expect(skipRows[0]).toMatchObject({
        userId: 'user-2',
        boardType: 'tension',
        auroraType: 'bids',
        auroraId: 'bid-poison',
        reason: 'db_write_rejected',
      });
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('quarantine payload fidelity (#3871)', () => {
  it('keeps an absent upstream field as an explicit null instead of dropping the key', async () => {
    // The missing field is usually the reason the row was refused, so
    // "angle was absent" must not be indistinguishable from "the quarantine
    // never captured angle" — JSON.stringify drops undefined-valued keys.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { tx, skipRows } = createTx({ selectResults: [[], []] });

      await applyAuroraAscents(tx as unknown as Db, 'kilter', 'user-1', [
        ascent({ uuid: 'aur-no-angle', angle: undefined }),
      ]);

      expect(skipRows).toHaveLength(1);
      expect(skipRows[0]).toMatchObject({ auroraId: 'aur-no-angle', reason: 'invalid_angle' });
      const payload = skipRows[0].payload as Record<string, unknown>;
      expect('angle' in payload).toBe(true);
      expect(payload.angle).toBeNull();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
