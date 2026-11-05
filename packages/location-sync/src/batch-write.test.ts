import { describe, expect, it } from 'vitest';
import { gyms, userBoards, users } from '@boardsesh/db/schema';
import { SYSTEM_USER_ID } from './ids';
import type { PublicBoardLocationInput } from './types';
import {
  applyPublicBoardLocationsInTransaction,
  planLocationWriteBatches,
  upsertPublicBoardLocations,
  upsertPublicBoardLocationsInBatches,
  type LocationSyncTransaction,
  type LocationWriteBatchRunner,
} from './upsert';

function record(gymSourceKey: string, overrides: Partial<PublicBoardLocationInput> = {}): PublicBoardLocationInput {
  return {
    sourceKey: `${gymSourceKey}:board`,
    gymSourceKey,
    name: 'Existing gym board',
    slugBase: 'existing-gym-board',
    locationName: null,
    latitude: 51,
    longitude: -1,
    gymName: 'Existing gym',
    gymAddress: null,
    boardType: 'moonboard',
    layoutId: 2,
    sizeId: 1,
    setIds: '1',
    angle: 40,
    isAngleAdjustable: false,
    ...overrides,
  };
}

type Statement = 'ensure user' | 'advisory lock' | 'lookup alias' | 'refresh gym' | 'upsert board' | 'fill serial';

type QueryMethod =
  | 'values'
  | 'set'
  | 'from'
  | 'innerJoin'
  | 'where'
  | 'limit'
  | 'onConflictDoNothing'
  | 'onConflictDoUpdate'
  | 'returning';
type RecordedQuery<Result> = Promise<Result> & Record<QueryMethod, (...arguments_: unknown[]) => RecordedQuery<Result>>;

/** Native Promise scheduling records the SQL boundary after builder construction. */
function recordedQuery<Result>(execute: () => Result): RecordedQuery<Result> {
  const query = Promise.resolve().then(execute) as RecordedQuery<Result>;
  const methods: QueryMethod[] = [
    'values',
    'set',
    'from',
    'innerJoin',
    'where',
    'limit',
    'onConflictDoNothing',
    'onConflictDoUpdate',
    'returning',
  ];
  for (const method of methods) query[method] = () => query;
  return query;
}

/** Scheduling/handle proof only; real SQL and rollback are covered separately. */
function transactionFixture(
  options: { afterStatement?: (statement: Statement) => void; afterSavepoint?: () => void } = {},
) {
  const statements: Statement[] = [];
  let savepoints = 0;
  const query = <Result>(statement: Statement, result: Result) =>
    recordedQuery(() => {
      statements.push(statement);
      options.afterStatement?.(statement);
      return result;
    });
  const handle = {
    execute: (_statement: unknown) => query('advisory lock', []),
    select: (_selection: unknown) =>
      query('lookup alias', [
        {
          id: 17,
          ownerId: SYSTEM_USER_ID,
          hasApprovedClaim: false,
          deletedAt: null,
          syncFrozenAt: null,
          mergedIntoGymId: null,
        },
      ]),
    insert(table: unknown) {
      if (table === users) return query('ensure user', []);
      if (table === userBoards) return query('upsert board', [{ id: 23 }]);
      throw new Error('Unexpected fixture INSERT');
    },
    update(table: unknown) {
      if (table === gyms) return query('refresh gym', []);
      if (table === userBoards) return query('fill serial', []);
      throw new Error('Unexpected fixture UPDATE');
    },
    async transaction<Result>(callback: (transaction: LocationSyncTransaction) => Promise<Result>): Promise<Result> {
      savepoints += 1;
      const result = await callback(handle as unknown as LocationSyncTransaction);
      options.afterSavepoint?.();
      return result;
    },
  };
  return { transaction: handle as unknown as LocationSyncTransaction, statements, savepointCount: () => savepoints };
}

describe('pure whole-gym location write planning', () => {
  it('keeps first-seen gym order, record order and duplicate references without mutating input', () => {
    const first = record('moonboard:first');
    const second = record('moonboard:second');
    const last = record('moonboard:last');
    const laterFirst = record('moonboard:first', { sourceKey: 'later-first' });
    const input = [first, second, laterFirst, first, last];
    const original = [...input];
    const batches = planLocationWriteBatches(input, 2);
    expect(batches).toEqual([[first, laterFirst, first, second], [last]]);
    expect(batches[0][0]).toBe(first);
    expect(batches[0][2]).toBe(first);
    expect(input).toEqual(original);
  });

  it('defaults to 25 whole gyms rather than a limit on records or valid coordinates', () => {
    const groups = Array.from({ length: 26 }, (_, index) => record(`moonboard:${index}`));
    const invalid = record('moonboard:0', { latitude: Number.NaN });
    const repeated = Array.from({ length: 400 }, () => groups[0]);
    const batches = planLocationWriteBatches([...groups, invalid, ...repeated]);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(426);
    expect(batches[0][0]).toBe(groups[0]);
    expect(batches[0][1]).toBe(invalid);
    expect(batches[0].slice(2, 402).every((entry) => entry === groups[0])).toBe(true);
    expect(batches[1]).toEqual([groups[25]]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid gym batch size %s', (size) => {
    expect(() => planLocationWriteBatches([], size)).toThrow('Invalid gyms per batch');
  });

  it('returns no batches for empty input', () => {
    expect(planLocationWriteBatches([])).toEqual([]);
  });
});

describe('caller-owned location transaction and synchronous checkpoints', () => {
  it('uses the supplied handle and nested gym transaction without inserting a user', async () => {
    const fixture = transactionFixture();
    const summary = await applyPublicBoardLocationsInTransaction(fixture.transaction, [record('moonboard:first')]);
    expect(summary).toMatchObject({ boardsSeen: 1, boardsUpserted: 1, boardsSkipped: 0, gymsSeen: 1 });
    expect(fixture.statements).toEqual(['advisory lock', 'lookup alias', 'refresh gym', 'upsert board']);
    expect(fixture.savepointCount()).toBe(1);
  });

  it('retains invalid records in the summary without creating an owner or issuing location SQL', async () => {
    const fixture = transactionFixture();
    const invalid = [
      record('moonboard:nan', { latitude: Number.NaN }),
      record('moonboard:infinity', { longitude: Number.POSITIVE_INFINITY }),
      record('moonboard:range', { latitude: 91 }),
    ];
    const summary = await applyPublicBoardLocationsInTransaction(fixture.transaction, invalid);
    expect(summary).toEqual({
      boardsSeen: 3,
      boardsUpserted: 0,
      boardsSkipped: 3,
      gymsSeen: 0,
      gymsUpserted: 0,
      skipped: invalid.map((entry) => ({ sourceKey: entry.sourceKey, reason: 'invalid coordinates' })),
    });
    expect(fixture.statements).toEqual([]);
    expect(fixture.savepointCount()).toBe(0);
  });

  it.each([{ input: [] }, { input: [record('moonboard:invalid', { latitude: Number.NaN })] }])(
    'keeps the legacy owner ensure before applying an empty or all-invalid input',
    async ({ input }) => {
      const fixture = transactionFixture();
      await upsertPublicBoardLocations(fixture.transaction, input);
      expect(fixture.statements).toEqual(['ensure user']);
    },
  );

  it('rejects an inactive operation before its first SQL or savepoint', async () => {
    const fixture = transactionFixture();
    const inactive = new Error('Owned cancellation');
    await expect(
      applyPublicBoardLocationsInTransaction(fixture.transaction, [record('moonboard:first')], {
        assertActive: () => {
          throw inactive;
        },
      }),
    ).rejects.toBe(inactive);
    expect(fixture.statements).toEqual([]);
    expect(fixture.savepointCount()).toBe(0);
  });

  it.each(['advisory lock', 'lookup alias', 'refresh gym', 'upsert board'] as const)(
    'observes cancellation after %s before another statement or a successful result',
    async (boundary) => {
      let active = true;
      const inactive = new Error('Owned cancellation');
      const fixture = transactionFixture({
        afterStatement: (statement) => {
          if (statement === boundary) active = false;
        },
      });
      await expect(
        applyPublicBoardLocationsInTransaction(fixture.transaction, [record('moonboard:first')], {
          assertActive: () => {
            if (!active) throw inactive;
          },
        }),
      ).rejects.toBe(inactive);
      const operations: Statement[] = ['advisory lock', 'lookup alias', 'refresh gym', 'upsert board'];
      expect(fixture.statements).toEqual(operations.slice(0, operations.indexOf(boundary) + 1));
    },
  );

  it('checks the completed nested savepoint before starting the board INSERT', async () => {
    let active = true;
    const inactive = new Error('Owned cancellation');
    const fixture = transactionFixture({
      afterSavepoint: () => {
        active = false;
      },
    });
    await expect(
      applyPublicBoardLocationsInTransaction(fixture.transaction, [record('moonboard:first')], {
        assertActive: () => {
          if (!active) throw inactive;
        },
      }),
    ).rejects.toBe(inactive);
    expect(fixture.statements).toEqual(['advisory lock', 'lookup alias', 'refresh gym']);
  });

  it('keeps the existing signal between batches instead of changing mid-batch cancellation', async () => {
    const signal = new AbortController();
    const abortReason = new Error('Owned between-batch cancellation');
    const fixture = transactionFixture({ afterStatement: () => signal.abort(abortReason) });
    let committed = 0;
    const runBatch: LocationWriteBatchRunner = async (callback) => {
      const result = await callback(fixture.transaction);
      committed += 1;
      return result;
    };
    await expect(
      upsertPublicBoardLocationsInBatches(runBatch, [record('moonboard:first'), record('moonboard:second')], {
        gymsPerBatch: 1,
        signal: signal.signal,
      }),
    ).rejects.toBe(abortReason);
    expect(committed).toBe(1);
    expect(fixture.statements).toContain('upsert board');
  });

  it('does not manufacture a rollback error when cancellation happens after the caller commits', async () => {
    let active = true;
    const fixture = transactionFixture();
    let committed = 0;
    const runBatch: LocationWriteBatchRunner = async (callback) => {
      const result = await callback(fixture.transaction);
      committed += 1;
      active = false;
      return result;
    };
    const summary = await upsertPublicBoardLocationsInBatches(runBatch, [record('moonboard:first')], {
      assertActive: () => {
        if (!active) throw new Error('Already committed');
      },
    });
    expect(committed).toBe(1);
    expect(summary.boardsUpserted).toBe(1);
  });

  it('makes no transaction call for empty batched input, including an already aborted signal', async () => {
    const runBatch: LocationWriteBatchRunner = () => {
      throw new Error('Unexpected outer transaction');
    };
    const summary = await upsertPublicBoardLocationsInBatches(runBatch, [], {
      signal: AbortSignal.abort(),
      assertActive: () => {
        throw new Error('Unexpected checkpoint');
      },
    });
    expect(summary).toEqual({
      boardsSeen: 0,
      boardsUpserted: 0,
      boardsSkipped: 0,
      gymsSeen: 0,
      gymsUpserted: 0,
      skipped: [],
    });
  });
});
