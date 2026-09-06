import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { getSetterStats } from '../setter-stats';
import type { BoardRouteParams } from '../types';
import type { DbInstance } from '../../../client/postgres';

const dialect = new PgDialect();

const SETTER_PARAMS: BoardRouteParams = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 10,
  set_ids: [1, 20],
  angle: 40,
};

/**
 * A drizzle stand-in that renders whatever WHERE the query builds and returns no
 * rows. The claim under test is which predicates reach Postgres, so rendering
 * the SQL is the assertion — running it would only re-check Postgres.
 */
function createFakeSetterStatsDb() {
  const whereClauses: string[] = [];

  const builder: Record<string, unknown> = {};
  for (const method of ['from', 'innerJoin', 'groupBy', 'orderBy', 'limit']) {
    builder[method] = () => builder;
  }
  builder.where = (condition: SQL | undefined) => {
    whereClauses.push(condition ? dialect.sqlToQuery(condition).sql : '');
    return builder;
  };
  builder.then = (
    onFulfilled?: ((value: unknown) => unknown) | null,
    onRejected?: ((reason: unknown) => unknown) | null,
  ) => Promise.resolve([]).then(onFulfilled, onRejected);

  const tx = {
    execute: () => Promise.resolve([]),
    select: () => builder,
  };

  const fakeDb = {
    transaction: (callback: (transactionDb: typeof tx) => unknown) => callback(tx),
  };

  return { fakeDb, whereClauses };
}

void describe('getSetterStats — community-hidden climbs (#5049)', () => {
  void it('never counts a hidden climb toward a setter total', async () => {
    const { fakeDb, whereClauses } = createFakeSetterStatsDb();

    await getSetterStats(fakeDb as unknown as DbInstance, SETTER_PARAMS);

    assert.equal(whereClauses.length, 1);
    assert.match(whereClauses[0], /"board_climbs"\."is_hidden" = \$\d+/);
  });

  void it('keeps the hidden filter when the autocomplete narrows by name', async () => {
    const { fakeDb, whereClauses } = createFakeSetterStatsDb();

    await getSetterStats(fakeDb as unknown as DbInstance, SETTER_PARAMS, 'ali');

    assert.match(whereClauses[0], /"board_climbs"\."is_hidden" = \$\d+/);
    assert.match(whereClauses[0], /ilike/i);
  });
});
