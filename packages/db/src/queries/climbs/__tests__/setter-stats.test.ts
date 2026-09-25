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

const MOONBOARD_PARAMS: BoardRouteParams = {
  board_name: 'moonboard',
  layout_id: 1,
  size_id: 1,
  set_ids: [1],
  angle: 40,
};

const WOODS_PARAMS: BoardRouteParams = {
  board_name: 'woods',
  layout_id: 1,
  size_id: 1,
  set_ids: [1],
  angle: 25,
};

// The browsed-angle restriction (#5642) as the dialect renders it.
const RESTRICTION_PATTERN =
  /\("board_climbs"\."angle" = \$\d+ or "board_climbs"\."angle" is null or "board_climb_stats"\."climb_uuid" is not null\)/i;

/**
 * A drizzle stand-in that renders whatever WHERE the query builds and returns no
 * rows. The claim under test is which predicates reach Postgres, so rendering
 * the SQL is the assertion — running it would only re-check Postgres.
 *
 * `innerJoin` is deliberately absent from the stubbed methods: the query must not
 * INNER JOIN `board_climb_stats` (#5404), and a re-added join should blow up here
 * rather than slip through green. `leftJoin` is recorded, because the one join the
 * query may make — the browsed-angle stats row a restricted Woods count probes
 * (#5642) — has to be visible to the tests that say when it happens.
 */
function createFakeSetterStatsDb() {
  const whereClauses: string[] = [];
  const orderByClauses: string[] = [];
  const leftJoinConditions: string[] = [];

  const builder: Record<string, unknown> = {};
  for (const method of ['from', 'groupBy', 'limit']) {
    builder[method] = () => builder;
  }
  builder.leftJoin = (_table: unknown, condition: SQL | undefined) => {
    leftJoinConditions.push(condition ? dialect.sqlToQuery(condition).sql : '');
    return builder;
  };
  builder.where = (condition: SQL | undefined) => {
    whereClauses.push(condition ? dialect.sqlToQuery(condition).sql : '');
    return builder;
  };
  builder.orderBy = (...expressions: SQL[]) => {
    orderByClauses.push(expressions.map((expression) => dialect.sqlToQuery(expression).sql).join(', '));
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

  return { fakeDb, whereClauses, orderByClauses, leftJoinConditions };
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

void describe('getSetterStats — angle-blind setter universe (#5404)', () => {
  void it('never scopes the aggregate by board_climb_stats', async () => {
    const { fakeDb, whereClauses, leftJoinConditions } = createFakeSetterStatsDb();

    await getSetterStats(fakeDb as unknown as DbInstance, SETTER_PARAMS);

    assert.deepEqual(leftJoinConditions, [], 'a Kilter picker joins nothing');

    // The angle-scoped INNER JOIN is the bug: it hid every setter with no climb
    // graded at the board's current tilt. Nothing may reference the stats table.
    assert.ok(
      !whereClauses[0].includes('board_climb_stats'),
      `expected no board_climb_stats reference, got: ${whereClauses[0]}`,
    );
    assert.ok(!whereClauses[0].includes('angle'), `expected no angle predicate, got: ${whereClauses[0]}`);
  });

  void it('excludes unlisted climbs and drafts, which the dropped join used to exclude for free', async () => {
    const { fakeDb, whereClauses } = createFakeSetterStatsDb();

    await getSetterStats(fakeDb as unknown as DbInstance, SETTER_PARAMS);

    assert.match(whereClauses[0], /"board_climbs"\."is_listed" = \$\d+/);
    assert.match(whereClauses[0], /"board_climbs"\."is_draft" = \$\d+/);
  });

  void it('scopes to the sets the board is fitted with', async () => {
    const { fakeDb, whereClauses } = createFakeSetterStatsDb();

    await getSetterStats(fakeDb as unknown as DbInstance, SETTER_PARAMS);

    assert.match(whereClauses[0], /"board_climbs"\."required_set_ids" <@ ARRAY\[/);
    // Kilter is size-scoped, so the size containment predicate stays.
    assert.match(whereClauses[0], /"board_climbs"\."compatible_size_ids" @> ARRAY\[/);
  });

  void it('breaks count ties on the username so the 50-row cut is stable', async () => {
    const { fakeDb, orderByClauses } = createFakeSetterStatsDb();

    await getSetterStats(fakeDb as unknown as DbInstance, SETTER_PARAMS);

    // The tail of this list is one-climb setters, so ties at the LIMIT 50 boundary
    // are common. Without the second key Postgres may return a different 50 each
    // time and the picker flickers between refetches.
    assert.equal(orderByClauses.length, 1);
    assert.match(orderByClauses[0], /count\(\*\) DESC/);
    assert.match(orderByClauses[0], /"board_climbs"\."setter_username" ASC/);
  });

  void it('lets MoonBoard climbs through while required_set_ids is still backfilling', async () => {
    const { fakeDb, whereClauses } = createFakeSetterStatsDb();

    await getSetterStats(fakeDb as unknown as DbInstance, MOONBOARD_PARAMS);

    assert.match(whereClauses[0], /"board_climbs"\."required_set_ids" is null/i);
    // MoonBoard never populates compatible_size_ids — the size predicate is skipped
    // entirely for it (#4008), so the draft/listed guards are all that stand between
    // the picker and other people's drafts.
    assert.ok(
      !whereClauses[0].includes('compatible_size_ids'),
      `expected no size predicate for MoonBoard, got: ${whereClauses[0]}`,
    );
    assert.match(whereClauses[0], /"board_climbs"\."is_draft" = \$\d+/);
  });
});

// Issue #5642. A Woods list keeps only the climbs for the browsed angle unless the
// search opts in, so the picker applies the same restriction or it offers a setter
// whose climbs the list cannot show.
void describe('getSetterStats — the Woods browsed-angle restriction (#5642)', () => {
  void it('joins the browsed-angle stats row and applies the list predicate by default', async () => {
    const { fakeDb, whereClauses, leftJoinConditions } = createFakeSetterStatsDb();

    await getSetterStats(fakeDb as unknown as DbInstance, WOODS_PARAMS);

    assert.match(whereClauses[0], RESTRICTION_PATTERN);
    assert.equal(leftJoinConditions.length, 1);
    // The full stats primary key, so at most one row per climb joins.
    assert.match(leftJoinConditions[0], /"board_climb_stats"\."climb_uuid" = "board_climbs"\."uuid"/);
    assert.match(leftJoinConditions[0], /"board_climb_stats"\."board_type" = \$\d+/);
    assert.match(leftJoinConditions[0], /"board_climb_stats"\."angle" = \$\d+/);
  });

  void it('keeps it when the autocomplete narrows by setter name, which is not a climb name', async () => {
    const { fakeDb, whereClauses } = createFakeSetterStatsDb();

    await getSetterStats(fakeDb as unknown as DbInstance, WOODS_PARAMS, 'ali');

    assert.match(whereClauses[0], RESTRICTION_PATTERN);
  });

  void it('drops the join and the predicate with the opt-in', async () => {
    const { fakeDb, whereClauses, leftJoinConditions } = createFakeSetterStatsDb();

    await getSetterStats(fakeDb as unknown as DbInstance, WOODS_PARAMS, undefined, undefined, {
      crossAngleStats: true,
    });

    assert.deepEqual(leftJoinConditions, []);
    assert.ok(!whereClauses[0].includes('board_climb_stats'), `expected no stats reference, got: ${whereClauses[0]}`);
    assert.ok(!whereClauses[0].includes('angle'), `expected no angle predicate, got: ${whereClauses[0]}`);
  });

  void it('ignores the opt-in on Kilter, which was never restricted', async () => {
    const { fakeDb, whereClauses, leftJoinConditions } = createFakeSetterStatsDb();

    await getSetterStats(fakeDb as unknown as DbInstance, SETTER_PARAMS, undefined, undefined, {
      crossAngleStats: true,
    });

    assert.deepEqual(leftJoinConditions, []);
    assert.ok(!whereClauses[0].includes('angle'), `expected no angle predicate, got: ${whereClauses[0]}`);
  });
});
