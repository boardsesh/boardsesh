import { describe, it, expect } from 'vite-plus/test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { is, getTableName, Table, type SQL } from 'drizzle-orm';
import {
  createClimbFilters,
  getSetterStats,
  resolveBrowsedAngleRestriction,
  resolveCrossAngleStats,
  resolveDetailCrossAngleStats,
  type BoardRouteParams,
} from '@boardsesh/db/queries';
import type { DbInstance } from '@boardsesh/db/client';

// Issue #5642, the pure half: which searches an angle-bound board (Woods)
// restricts to the browsed angle, and the SQL that restriction renders to.
//
// Why this lives in the backend suite: packages/db runs its tests with
// `tsx --test`, and CI runs only a hand-picked few of those files (see
// ci.yml's MoonBoard replay step). The truth table below is copied from
// packages/db/src/queries/climbs/__tests__/effective-stats.test.ts, and the
// builder cases from create-climb-filters.test.ts, so the rule every list,
// count and setter picker reads is guarded on every PR. Keep both copies in
// step. The end-to-end behaviour against a real database is in
// climb-queries.test.ts (list, count, detail) and setter-stats-moonboard.test.ts
// (the setter picker).

const woods: Pick<BoardRouteParams, 'board_name'> = { board_name: 'woods' };
const kilter: Pick<BoardRouteParams, 'board_name'> = { board_name: 'kilter' };
const moonboard: Pick<BoardRouteParams, 'board_name'> = { board_name: 'moonboard' };
const spray: Pick<BoardRouteParams, 'board_name'> = { board_name: 'spray' };

const dialect = new PgDialect();

// The restriction as the dialect renders it: set here, no set angle recorded, or a
// stats row here — the last arm on the UNALIASED browsed-angle stats table.
const RESTRICTION_PATTERN =
  /\("board_climbs"\."angle" = \$\d+ or "board_climbs"\."angle" is null or "board_climb_stats"\."climb_uuid" is not null\)/i;

describe('resolveCrossAngleStats', () => {
  it('is off on Woods unless the search opts in — omitted and false alike', () => {
    expect(resolveCrossAngleStats(woods, {})).toBe(false);
    expect(resolveCrossAngleStats(woods, { crossAngleStats: false })).toBe(false);
    expect(resolveCrossAngleStats(woods, { crossAngleStats: true })).toBe(true);
  });

  it('turns on for a by-name search on Woods, whatever the opt-in says', () => {
    expect(resolveCrossAngleStats(woods, { name: 'Crimp' })).toBe(true);
    expect(resolveCrossAngleStats(woods, { name: 'Crimp', crossAngleStats: false })).toBe(true);
    // An empty name is no name, the same reading the community-hidden filter uses.
    expect(resolveCrossAngleStats(woods, { name: '' })).toBe(false);
  });

  it('leaves Kilter on the opt-in alone — a name search does not turn it on', () => {
    expect(resolveCrossAngleStats(kilter, {})).toBe(false);
    expect(resolveCrossAngleStats(kilter, { crossAngleStats: false })).toBe(false);
    expect(resolveCrossAngleStats(kilter, { name: 'Crimp' })).toBe(false);
    expect(resolveCrossAngleStats(kilter, { crossAngleStats: true })).toBe(true);
  });

  it('treats MoonBoard like Kilter, because its capability is off', () => {
    expect(resolveCrossAngleStats(moonboard, {})).toBe(false);
    expect(resolveCrossAngleStats(moonboard, { name: 'Crimp' })).toBe(false);
    expect(resolveCrossAngleStats(moonboard, { crossAngleStats: true })).toBe(true);
  });
});

describe('resolveBrowsedAngleRestriction', () => {
  it('restricts a Woods search that is not cross-angle', () => {
    expect(resolveBrowsedAngleRestriction(woods, {})).toBe(true);
    expect(resolveBrowsedAngleRestriction(woods, { crossAngleStats: false })).toBe(true);
    expect(resolveBrowsedAngleRestriction(woods, { name: '' })).toBe(true);
  });

  it('is the complement of cross-angle on Woods', () => {
    expect(resolveBrowsedAngleRestriction(woods, { crossAngleStats: true })).toBe(false);
    expect(resolveBrowsedAngleRestriction(woods, { name: 'Crimp' })).toBe(false);
  });

  it.each([
    ['kilter', kilter],
    ['moonboard', moonboard],
    ['spray', spray],
  ])('never restricts %s, whose climbs are not angle-bound', (_label, board) => {
    expect(resolveBrowsedAngleRestriction(board, {})).toBe(false);
    expect(resolveBrowsedAngleRestriction(board, { crossAngleStats: false })).toBe(false);
    expect(resolveBrowsedAngleRestriction(board, { crossAngleStats: true })).toBe(false);
  });
});

describe('resolveDetailCrossAngleStats', () => {
  // A Woods climb reached at another angle — a name search, an opted-in list, a
  // playlist — opens with its set-angle grade, not a blank one.
  it('stays on for Woods and off for boards that are not angle-bound', () => {
    expect(resolveDetailCrossAngleStats(woods)).toBe(true);
    expect(resolveDetailCrossAngleStats(kilter)).toBe(false);
    expect(resolveDetailCrossAngleStats(moonboard)).toBe(false);
  });
});

// The builder carries the predicate in getClimbWhereConditions — the one array
// both searchClimbs and countClimbs build their WHERE from — and only when asked.
describe('createClimbFilters: browsed-angle restriction', () => {
  const woodsParams: BoardRouteParams = { board_name: 'woods', layout_id: 1, size_id: 1, set_ids: [1], angle: 30 };
  const restricted = { restrictToBrowsedAngle: true };
  const renderWhere = (filters: ReturnType<typeof createClimbFilters>) =>
    filters
      .getClimbWhereConditions()
      .map((fragment) => dialect.sqlToQuery(fragment))
      .map((query) => ({ sql: query.sql, params: query.params }));

  it('adds set-here, no-set-angle and stats-here arms, bound to the browsed angle', () => {
    const filters = createClimbFilters(woodsParams, {}, undefined, restricted);
    expect(filters.isBrowsedAngleRestricted).toBe(true);
    const restriction = renderWhere(filters).find((query) => RESTRICTION_PATTERN.test(query.sql));
    expect(restriction).toBeDefined();
    expect(restriction?.params).toEqual([30]);
    // The stats arm is on the UNALIASED browsed-angle join, never the set-angle one.
    expect(restriction?.sql).not.toMatch(/stats_set_angle/);
  });

  // The holds heatmap reuses getClimbWhereConditions from a FROM with no
  // board_climbs and no board_climb_stats; it passes no options.
  it('stays out of the WHERE for a caller that passes no options', () => {
    const filters = createClimbFilters(woodsParams, {});
    expect(filters.isBrowsedAngleRestricted).toBe(false);
    expect(renderWhere(filters).some((query) => RESTRICTION_PATTERN.test(query.sql))).toBe(false);
  });

  it("exempts a user's own drafts list", () => {
    const filters = createClimbFilters(woodsParams, { onlyDrafts: true }, 'user-1', restricted);
    expect(filters.isOnlyDrafts).toBe(true);
    expect(filters.isBrowsedAngleRestricted).toBe(false);
    expect(renderWhere(filters).some((query) => RESTRICTION_PATTERN.test(query.sql))).toBe(false);
  });

  it('keeps it for onlyDrafts without a user, which is not a drafts query', () => {
    const filters = createClimbFilters(woodsParams, { onlyDrafts: true }, undefined, restricted);
    expect(filters.isBrowsedAngleRestricted).toBe(true);
  });

  it('gives cross-angle precedence when a caller passes both', () => {
    const filters = createClimbFilters(woodsParams, {}, undefined, { ...restricted, crossAngleStats: true });
    expect(filters.isCrossAngleStats).toBe(true);
    expect(filters.isBrowsedAngleRestricted).toBe(false);
    expect(renderWhere(filters).some((query) => RESTRICTION_PATTERN.test(query.sql))).toBe(false);
  });
});

/**
 * A drizzle stand-in for `getSetterStats` that renders the WHERE and every join
 * the query builds, and returns no rows. Which predicates and joins reach
 * Postgres is the claim under test; the real-database half is
 * setter-stats-moonboard.test.ts. `innerJoin` is deliberately not stubbed: the
 * picker must never INNER JOIN stats again (#5404), and one that did should throw
 * here rather than pass.
 */
function createFakeSetterStatsDb() {
  const whereClauses: string[] = [];
  const leftJoins: { table: string | null; on: string }[] = [];

  const builder: Record<string, unknown> = {};
  for (const method of ['from', 'groupBy', 'orderBy', 'limit']) {
    builder[method] = () => builder;
  }
  builder.leftJoin = (table: unknown, condition: SQL | undefined) => {
    leftJoins.push({
      table: is(table, Table) ? getTableName(table) : null,
      on: condition ? dialect.sqlToQuery(condition).sql : '',
    });
    return builder;
  };
  builder.where = (condition: SQL | undefined) => {
    whereClauses.push(condition ? dialect.sqlToQuery(condition).sql : '');
    return builder;
  };
  // Deliberate: drizzle's query builder is awaitable, so the fake has to be a
  // real thenable for `await tx.select()...` to resolve like a genuine query.
  // oxlint-disable-next-line no-thenable
  builder.then = (
    onFulfilled?: ((value: unknown) => unknown) | null,
    onRejected?: ((reason: unknown) => unknown) | null,
  ) => Promise.resolve([]).then(onFulfilled, onRejected);

  const tx = { execute: () => Promise.resolve([]), select: () => builder };
  const fakeDb = { transaction: (callback: (transactionDb: typeof tx) => unknown) => callback(tx) };
  return { fakeDb: fakeDb as unknown as DbInstance, whereClauses, leftJoins };
}

describe('getSetterStats: the picker follows the list angle rule', () => {
  const woodsParams: BoardRouteParams = { board_name: 'woods', layout_id: 1, size_id: 1, set_ids: [1], angle: 25 };
  const kilterParams: BoardRouteParams = {
    board_name: 'kilter',
    layout_id: 1,
    size_id: 10,
    set_ids: [1, 20],
    angle: 40,
  };

  it('restricts Woods by default: one browsed-angle stats join and the list predicate', async () => {
    const { fakeDb, whereClauses, leftJoins } = createFakeSetterStatsDb();

    await getSetterStats(fakeDb, woodsParams);

    expect(whereClauses).toHaveLength(1);
    expect(whereClauses[0]).toMatch(RESTRICTION_PATTERN);
    expect(leftJoins).toHaveLength(1);
    expect(leftJoins[0].table).toBe('board_climb_stats');
    // Keyed on the full stats primary key, so one row per climb and count(*)
    // still counts climbs.
    expect(leftJoins[0].on).toMatch(/"board_climb_stats"\."climb_uuid" = "board_climbs"\."uuid"/);
    expect(leftJoins[0].on).toMatch(/"board_climb_stats"\."board_type" = \$\d+/);
    expect(leftJoins[0].on).toMatch(/"board_climb_stats"\."angle" = \$\d+/);
  });

  it('does not read the setter-username search as a climb-name search', async () => {
    const { fakeDb, whereClauses, leftJoins } = createFakeSetterStatsDb();

    await getSetterStats(fakeDb, woodsParams, 'ali');

    expect(whereClauses[0]).toMatch(RESTRICTION_PATTERN);
    expect(leftJoins).toHaveLength(1);
  });

  it.each([
    ['Woods with the opt-in', woodsParams, { crossAngleStats: true }],
    ['Kilter', kilterParams, {}],
    ['Kilter with the opt-in', kilterParams, { crossAngleStats: true }],
  ] as const)('stays angle-blind and join-free for %s', async (_label, params, options) => {
    const { fakeDb, whereClauses, leftJoins } = createFakeSetterStatsDb();

    await getSetterStats(fakeDb, params, undefined, undefined, options);

    expect(leftJoins).toEqual([]);
    expect(whereClauses[0]).not.toMatch(/board_climb_stats/);
    expect(whereClauses[0]).not.toMatch(/angle/);
  });
});
