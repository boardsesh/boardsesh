/**
 * Postgres DSM guard for the public `userTicks` read (#4528, Sentry BOARDSESH-AK).
 *
 * `userTicks` selects a climber's ENTIRE logbook with no LIMIT and fans it out
 * through five LEFT JOINs, two of them against the big catalog tables
 * (`board_climbs`, `board_climb_stats`). Production plans that as a parallel
 * hash join, and enough concurrent profile loads exhaust Postgres's dynamic
 * shared memory on our small /dev/shm — pgCode 53100. It was the single largest
 * remaining source of those events.
 *
 * The fix is the same one the You-page fan-out already uses: run the select
 * inside a transaction that has issued `SET LOCAL
 * max_parallel_workers_per_gather = 0` first. This pins that the select really
 * lands on the transaction handle rather than the bare pool — passing the wrong
 * handle silently skips the guard with no error.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { tickQueries } from '../graphql/resolvers/ticks/queries';

const GUARD_PATTERN = /SET LOCAL max_parallel_workers_per_gather\s*=\s*0/i;

const { fakeDb, state } = vi.hoisted(() => {
  const state = {
    /** Rendered SQL of every `execute`d statement, in order. Real renderer assigned below. */
    render: (_statement: unknown): string => '',
    executed: [] as string[],
    /** Which handle each execute ran on: 'db' (top-level pool) or 'tx' (transaction). */
    executeHandles: [] as string[],
    /** Which handle each awaited select builder ran on. */
    selectHandles: [] as string[],
    transactions: 0,
    selectRows: [] as unknown[],
  };

  const makeSelectBuilder = (handle: string) => {
    const builder: Record<string, unknown> = {};
    for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'groupBy', 'having', 'orderBy', 'limit', 'as']) {
      builder[method] = () => builder;
    }
    // Deliberate: drizzle's query builder is awaitable, so the fake has to be a
    // real thenable for `await tx.select()...` to resolve like a genuine query.
    // oxlint-disable-next-line no-thenable
    builder.then = (
      onFulfilled?: ((value: unknown) => unknown) | null,
      onRejected?: ((reason: unknown) => unknown) | null,
    ) => {
      state.selectHandles.push(handle);
      return Promise.resolve(state.selectRows).then(onFulfilled, onRejected);
    };
    return builder;
  };

  const makeExecute = (handle: string) => (statement: unknown) => {
    state.executed.push(state.render(statement));
    state.executeHandles.push(handle);
    return Promise.resolve([]);
  };

  const fakeTx = {
    execute: makeExecute('tx'),
    select: () => makeSelectBuilder('tx'),
    selectDistinct: () => makeSelectBuilder('tx'),
  };

  const fakeDb = {
    execute: makeExecute('db'),
    select: () => makeSelectBuilder('db'),
    selectDistinct: () => makeSelectBuilder('db'),
    transaction: (callback: (transactionDb: typeof fakeTx) => unknown) => {
      state.transactions += 1;
      return callback(fakeTx);
    },
  };

  return { fakeDb, state };
});

vi.mock('../db/client', () => ({ db: fakeDb, dbRead: fakeDb }));

const dialect = new PgDialect();
state.render = (statement: unknown) => dialect.sqlToQuery(statement as SQL).sql;

const TICK_ROW = {
  tick: {
    uuid: 'tick-1',
    userId: 'user-123',
    boardType: 'kilter',
    climbUuid: 'climb-1',
    angle: 40,
    isMirror: false,
    status: 'sent',
    attemptCount: 1,
    quality: 3,
    difficulty: null,
    isBenchmark: false,
    comment: null,
    climbedAt: new Date('2026-08-01T12:00:00.000Z'),
    createdAt: new Date('2026-08-01T12:00:00.000Z'),
    updatedAt: new Date('2026-08-01T12:00:00.000Z'),
    sessionId: null,
    auroraType: null,
    auroraId: null,
    auroraSyncedAt: null,
  },
  layoutId: 8,
  effectiveDifficulty: 20,
  boardseshDifficulty: 20.5,
  boardseshConfidence: 0.9,
  effectiveQuality: 3,
};

beforeEach(() => {
  state.executed.length = 0;
  state.executeHandles.length = 0;
  state.selectHandles.length = 0;
  state.transactions = 0;
  state.selectRows = [];
});

describe('userTicks serial-plan guard', () => {
  it('runs SET LOCAL and the logbook select on the same transaction handle', async () => {
    state.selectRows = [TICK_ROW];

    const ticks = (await tickQueries.userTicks(null, { userId: 'user-123', boardType: 'kilter' })) as Array<{
      uuid: string;
      layoutId: number;
    }>;

    expect(ticks).toHaveLength(1);
    expect(ticks[0].uuid).toBe('tick-1');
    expect(ticks[0].layoutId).toBe(8);

    expect(state.transactions).toBe(1);
    expect(state.executed).toHaveLength(1);
    expect(state.executed[0]).toMatch(GUARD_PATTERN);
    // Nothing on the bare pool: SET LOCAL only covers its own transaction, so a
    // select that leaked back to `db` would be unguarded.
    expect(state.executeHandles).toEqual(['tx']);
    expect(state.selectHandles).toEqual(['tx']);
  });

  it('rejects an unknown board type before opening a transaction', async () => {
    await expect(tickQueries.userTicks(null, { userId: 'user-123', boardType: 'nope' })).rejects.toThrow();

    expect(state.transactions).toBe(0);
    expect(state.executed).toHaveLength(0);
    expect(state.selectHandles).toHaveLength(0);
  });
});
