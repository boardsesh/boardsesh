/**
 * Regression net for the Postgres parallel-query DSM guard (#1969 / #2378 /
 * #3856 / #4105).
 *
 * Postgres allocates a dynamic-shared-memory segment per parallel worker; on a
 * container with a small /dev/shm a burst of concurrent parallel hash joins
 * raises `could not resize shared memory segment` (pgCode 53100) and the request
 * fails. The fix is `SET LOCAL max_parallel_workers_per_gather = 0`, which only
 * takes effect inside a transaction.
 *
 * These live in the backend suite on purpose: `packages/db` runs on node's test
 * runner and is not wired into CI, so a guard test placed next to the query
 * would never gate a PR.
 */

import { describe, it, expect } from 'vite-plus/test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { is, getTableName, Table, type SQL } from 'drizzle-orm';
import { withSerialPlan, getSetterStats, type SerialPlanDb } from '@boardsesh/db/queries';
import { boardClimbs } from '@boardsesh/db/schema';
import type { DbInstance } from '@boardsesh/db/client';

const dialect = new PgDialect();
const GUARD_PATTERN = /SET LOCAL max_parallel_workers_per_gather\s*=\s*0/i;

type RecordedQuery = { table: string | null };

/**
 * Minimal stand-in for a top-level Drizzle instance. Every select-chain method
 * returns the same builder, and awaiting it records that the query ran — so a
 * test can assert the SELECT executed AFTER the guard rather than instead of it.
 */
function createFakeDb() {
  const callOrder: string[] = [];
  const executedStatements: SQL[] = [];
  const queries: RecordedQuery[] = [];

  const makeSelectBuilder = () => {
    const recorded: RecordedQuery = { table: null };
    const builder: Record<string, unknown> = {};
    for (const method of ['innerJoin', 'leftJoin', 'where', 'groupBy', 'orderBy', 'limit', 'offset']) {
      builder[method] = () => builder;
    }
    builder.from = (source: unknown) => {
      recorded.table = is(source, Table) ? getTableName(source) : null;
      return builder;
    };
    // Deliberate: drizzle's query builder is awaitable, so the fake has to be a
    // real thenable for `await tx.select()...` to resolve like a genuine query.
    // oxlint-disable-next-line no-thenable
    builder.then = (
      onFulfilled?: ((value: unknown) => unknown) | null,
      onRejected?: ((reason: unknown) => unknown) | null,
    ) => {
      callOrder.push('select');
      queries.push(recorded);
      return Promise.resolve([]).then(onFulfilled, onRejected);
    };
    return builder;
  };

  const tx = {
    execute: (statement: SQL) => {
      callOrder.push('execute');
      executedStatements.push(statement);
      return Promise.resolve([]);
    },
    select: () => makeSelectBuilder(),
    selectDistinct: () => makeSelectBuilder(),
  };

  const fakeDb = {
    transaction: (callback: (transactionDb: typeof tx) => unknown) => callback(tx),
  };

  return { fakeDb, tx, callOrder, executedStatements, queries };
}

function renderedGuards(statements: SQL[]): string[] {
  return statements.map((statement) => dialect.sqlToQuery(statement).sql);
}

describe('withSerialPlan', () => {
  it('opens a transaction and issues the guard before running the query', async () => {
    const { fakeDb, callOrder, executedStatements } = createFakeDb();

    await withSerialPlan(fakeDb as unknown as SerialPlanDb, (tx) => tx.select().from(boardClimbs));

    expect(callOrder).toEqual(['execute', 'select']);
    expect(renderedGuards(executedStatements)[0]).toMatch(GUARD_PATTERN);
  });

  it('runs the query inside the transaction, not on the outer handle', async () => {
    // SET LOCAL is scoped to the transaction, so a query issued on the original
    // db handle would run on a different connection with parallelism still on.
    const { fakeDb, tx } = createFakeDb();
    let received: unknown;

    await withSerialPlan(fakeDb as unknown as SerialPlanDb, async (transactionDb) => {
      received = transactionDb;
      return [];
    });

    expect(received).toBe(tx);
  });

  it('returns the query result untouched', async () => {
    const { fakeDb } = createFakeDb();

    const result = await withSerialPlan(fakeDb as unknown as SerialPlanDb, async () => ['a', 'b']);

    expect(result).toEqual(['a', 'b']);
  });

  it('propagates a query failure and does not swallow it', async () => {
    const { fakeDb } = createFakeDb();

    await expect(
      withSerialPlan(fakeDb as unknown as SerialPlanDb, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('falls back to a bare execute for an execute-only test double', async () => {
    const executed: SQL[] = [];
    const executeOnly = {
      execute: (statement: SQL) => {
        executed.push(statement);
        return Promise.resolve([]);
      },
    };

    await withSerialPlan(executeOnly as unknown as SerialPlanDb, async () => 'ok');

    expect(renderedGuards(executed)[0]).toMatch(GUARD_PATTERN);
  });
});

describe('getSetterStats guard (#4105)', () => {
  it('issues the guard before the board_climbs aggregate', async () => {
    // This query hash-joins board_climbs x board_climb_stats over a whole layout
    // and groups by setter. It fires from the same search drawer as searchClimbs,
    // so it kept exhausting /dev/shm after #3856 guarded the search paths.
    const { fakeDb, callOrder, executedStatements, queries } = createFakeDb();

    await getSetterStats(fakeDb as unknown as DbInstance, {
      board_name: 'kilter',
      layout_id: 1,
      size_id: 10,
      set_ids: [1, 20],
      angle: 40,
    });

    expect(callOrder).toEqual(['execute', 'select']);
    expect(queries[0].table).toBe('board_climbs');
    expect(renderedGuards(executedStatements)[0]).toMatch(GUARD_PATTERN);
  });

  it('still guards the autocomplete branch that adds an ILIKE on setter_username', async () => {
    // The leading-wildcard ILIKE removes the last index-friendly predicate, which
    // makes a parallel plan *more* likely, not less.
    const { fakeDb, callOrder, executedStatements } = createFakeDb();

    await getSetterStats(
      fakeDb as unknown as DbInstance,
      { board_name: 'kilter', layout_id: 1, size_id: 10, set_ids: [1, 20], angle: 40 },
      'jack',
    );

    expect(callOrder).toEqual(['execute', 'select']);
    expect(renderedGuards(executedStatements)[0]).toMatch(GUARD_PATTERN);
  });
});
