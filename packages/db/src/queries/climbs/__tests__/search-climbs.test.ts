import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PgDialect } from 'drizzle-orm/pg-core';
import { getTableName, is, sql, Table, type SQL } from 'drizzle-orm';
import {
  chooseSearchPath,
  getStatsDrivenSort,
  clampSearchPage,
  MAX_SEARCH_PAGE,
  searchClimbs,
  statsDrivenClimbFields,
} from '../search-climbs';
import { mapSearchInputToParams, normalizeSearchSortBy, type BoardRouteParams } from '../types';
import { resetClimbPopularityReadinessForTests } from '../climb-popularity';
import type { DbInstance } from '../../../client/postgres';

const baseInput = {
  statsDrivenSort: 'ascents' as const,
  crossAngle: false,
  isDraftsQuery: false,
  projectsOnly: false,
  routesOnly: false,
  hasStatsFilters: false,
};

void describe('getStatsDrivenSort', () => {
  void it('returns ascents and quality only for descending stats-driven sorts', () => {
    assert.equal(getStatsDrivenSort('ascents', 'desc'), 'ascents');
    assert.equal(getStatsDrivenSort('quality', 'desc'), 'quality');
    assert.equal(getStatsDrivenSort('ascents', 'asc'), null);
    assert.equal(getStatsDrivenSort('quality', 'asc'), null);
    assert.equal(getStatsDrivenSort('creation', 'desc'), null);
    // Random never uses the indexed path — it routes to the standard search.
    assert.equal(getStatsDrivenSort('random', 'desc'), null);
  });
});

void describe('clampSearchPage', () => {
  void it('defaults undefined and non-finite input to 0', () => {
    assert.equal(clampSearchPage(undefined), 0);
    assert.equal(clampSearchPage(NaN), 0);
    assert.equal(clampSearchPage(Infinity), 0);
  });

  void it('floors negative pages to 0', () => {
    assert.equal(clampSearchPage(-1), 0);
    assert.equal(clampSearchPage(-9999), 0);
  });

  void it('passes through valid pages and truncates fractions', () => {
    assert.equal(clampSearchPage(0), 0);
    assert.equal(clampSearchPage(7), 7);
    assert.equal(clampSearchPage(3.9), 3);
  });

  void it('caps pages above MAX_SEARCH_PAGE to prevent deep-OFFSET abuse', () => {
    assert.equal(clampSearchPage(MAX_SEARCH_PAGE + 1), MAX_SEARCH_PAGE);
    assert.equal(clampSearchPage(10_000_000), MAX_SEARCH_PAGE);
  });
});

void describe('chooseSearchPath', () => {
  void describe('the hot path: ascents DESC, no stats filters', () => {
    void it('uses stats-driven-with-fallback so projects appear at the bottom of narrow-filter pages', () => {
      assert.equal(chooseSearchPath(baseInput), 'stats-driven-with-fallback');
    });
  });

  void describe('routes-only filter', () => {
    void it('uses standard-only so unclimbed routes (no stats row) still appear in the list', () => {
      assert.equal(chooseSearchPath({ ...baseInput, routesOnly: true }), 'standard-only');
    });
  });

  void describe('stats filters active (e.g. minAscents >= 1)', () => {
    void it('uses stats-driven-only — stats-less climbs would be filtered out anyway', () => {
      assert.equal(chooseSearchPath({ ...baseInput, hasStatsFilters: true }), 'stats-driven-only');
    });
  });

  void describe('cases that bypass the stats-driven path entirely', () => {
    void it('uses standard-only when projectsOnly is set (user wants stats-less climbs)', () => {
      assert.equal(chooseSearchPath({ ...baseInput, projectsOnly: true }), 'standard-only');
    });

    void it('uses standard-only for drafts queries (drafts have no stats rows)', () => {
      assert.equal(chooseSearchPath({ ...baseInput, isDraftsQuery: true }), 'standard-only');
    });

    void it('uses standard-only for sorts without a stats-driven index path', () => {
      assert.equal(chooseSearchPath({ ...baseInput, statsDrivenSort: null }), 'standard-only');
    });

    void it('uses stats-driven-with-fallback for quality DESC', () => {
      assert.equal(chooseSearchPath({ ...baseInput, statsDrivenSort: 'quality' }), 'stats-driven-with-fallback');
    });
  });

  void describe('cross-angle stats (issue #5405)', () => {
    void it('uses standard-only for ascents — the stats-driven INNER JOIN is what hides the climbs', () => {
      assert.equal(chooseSearchPath({ ...baseInput, crossAngle: true }), 'standard-only');
    });

    void it('uses standard-only for quality too', () => {
      assert.equal(chooseSearchPath({ ...baseInput, crossAngle: true, statsDrivenSort: 'quality' }), 'standard-only');
    });

    // The one input that returns stats-driven-only without cross-angle. A grade or
    // ascent filter is exactly what a climber reaches for when the list looks short,
    // so routing it back to the INNER JOIN would keep the bug alive behind a filter.
    void it('uses standard-only even with stats filters active', () => {
      assert.equal(chooseSearchPath({ ...baseInput, crossAngle: true, hasStatsFilters: true }), 'standard-only');
    });

    void it('leaves the path alone when cross-angle is off', () => {
      assert.equal(chooseSearchPath({ ...baseInput, crossAngle: false }), 'stats-driven-with-fallback');
    });
  });

  void describe('precedence', () => {
    void it('projectsOnly trumps the hot path', () => {
      assert.equal(chooseSearchPath({ ...baseInput, projectsOnly: true, hasStatsFilters: false }), 'standard-only');
    });

    void it('drafts trumps the hot path', () => {
      assert.equal(chooseSearchPath({ ...baseInput, isDraftsQuery: true }), 'standard-only');
    });

    void it('non-ascents sort trumps the filter conditions', () => {
      assert.equal(
        chooseSearchPath({
          ...baseInput,
          statsDrivenSort: null,
          hasStatsFilters: false,
        }),
        'standard-only',
      );
    });
  });
});

void describe('normalizeSearchSortBy', () => {
  void it('keeps known search sort keys', () => {
    assert.equal(normalizeSearchSortBy('ascents'), 'ascents');
    assert.equal(normalizeSearchSortBy('quality'), 'quality');
    assert.equal(normalizeSearchSortBy('popular'), 'popular');
  });

  void it('maps legacy timestamp keys to creation sort', () => {
    assert.equal(normalizeSearchSortBy('created_at'), 'creation');
    assert.equal(normalizeSearchSortBy('published_at'), 'creation');
  });

  void it('uses ascents by default and explicit creation for unknown sort keys', () => {
    assert.equal(normalizeSearchSortBy(undefined), 'ascents');
    assert.equal(normalizeSearchSortBy(null), 'ascents');
    assert.equal(normalizeSearchSortBy('newest'), 'creation');
  });

  void it('keeps the random sort key', () => {
    assert.equal(normalizeSearchSortBy('random'), 'random');
  });

  void it('normalizes sortBy while mapping raw search input', () => {
    assert.equal(mapSearchInputToParams({ sortBy: 'published_at' }).sortBy, 'creation');
    assert.equal(mapSearchInputToParams({ sortBy: 'unknown' }).sortBy, 'creation');
  });

  void it('threads the random sort seed through mapSearchInputToParams', () => {
    assert.equal(mapSearchInputToParams({ sortBy: 'random', sortSeed: '12345' }).sortSeed, '12345');
    // Empty / absent seed collapses to undefined so the query falls back to the constant salt.
    assert.equal(mapSearchInputToParams({ sortBy: 'random', sortSeed: '' }).sortSeed, undefined);
    assert.equal(mapSearchInputToParams({ sortBy: 'random' }).sortSeed, undefined);
  });
});

const dialect = new PgDialect();
const GUARD_PATTERN = /SET LOCAL max_parallel_workers_per_gather\s*=\s*0/i;
// The stats-presence ORDER BY key the stats-driven fallback prepends (issue #1971).
const STATS_PRESENCE_KEY_PATTERN = /case when\s+"?board_climb_stats"?\."?climb_uuid"?\s+is null/i;
// The browsed-angle restriction an angle-bound board gets without the opt-in
// (issue #5642), as the dialect renders it: set here, no set angle, or a stats row
// here — the last arm on the UNALIASED browsed-angle stats table.
const BROWSED_ANGLE_RESTRICTION_PATTERN =
  /\("board_climbs"\."angle" = \$\d+ or "board_climbs"\."angle" is null or "board_climb_stats"\."climb_uuid" is not null\)/i;

/** Minimal row shape searchClimbs' row mapper reads; enough to identify a row by uuid. */
function fakeRow(uuid: string): Record<string, unknown> {
  return {
    uuid,
    setter_username: null,
    userId: null,
    name: uuid,
    frames: null,
    is_draft: false,
    is_hidden: false,
    angle: 40,
    stats_angle: 40,
    ascensionist_count: null,
    difficulty_id: null,
    quality_average: null,
    difficulty_error: null,
    benchmark_difficulty: null,
    description: null,
    characteristics: null,
    created_at: null,
    published_at: null,
    frames_count: 1,
    frames_pace: null,
    boardsesh_difficulty: null,
    boardsesh_confidence: null,
  };
}

/** What one SELECT the code under test issued looked like. */
type RecordedQuery = {
  table: string | null;
  orderBy: string[];
  joins: string[];
  /** The keys of the object passed to `.select(...)`. */
  selectKeys: string[];
  /** Set when `from()` read a subquery: what that subquery itself recorded. */
  subquery?: RecordedQuery;
};

/** Marks the stand-in `.as()` returns, so `from()` can tell a subquery from a table. */
const FAKE_SUBQUERY = Symbol('fakeSubquery');

// Fake SearchDb: a minimal stand-in for a top-level Drizzle instance. Every
// select chain method returns the same builder object, and awaiting it (via a
// real `.then`) records that the query ran — so a test can assert the query
// executed AFTER the SET LOCAL guard, not before or instead of it. No module
// mocking is needed: searchClimbs takes `db` as a plain parameter.
//
// Each builder also records the table `from()` was called with and the RENDERED
// ORDER BY fragments, so a test can assert on the SQL the code actually emitted
// instead of re-deriving an expectation from the same helpers. `scriptedRows`
// supplies the rows the Nth select resolves with (default: none).
function createFakeSearchDb(scriptedRows: Record<string, unknown>[][] = []) {
  const callOrder: string[] = [];
  const executedStatements: SQL[] = [];
  const queries: RecordedQuery[] = [];
  const whereClauses: string[] = [];

  const makeSelectBuilder = (fields?: Record<string, unknown>) => {
    const recorded: RecordedQuery = { table: null, orderBy: [], joins: [], selectKeys: Object.keys(fields ?? {}) };
    const builder: Record<string, unknown> = {};
    for (const method of ['limit', 'offset', 'groupBy']) {
      builder[method] = () => builder;
    }
    // Joined tables by their SQL name, so an ALIASED table (the set-angle stats
    // row, #5405) is distinguishable from the unaliased one it aliases.
    for (const method of ['innerJoin', 'leftJoin']) {
      builder[method] = (source: unknown) => {
        if (is(source, Table)) recorded.joins.push(getTableName(source));
        return builder;
      };
    }
    // A subquery source (the stats-driven ranked page) records the table the
    // subquery itself read, and keeps the subquery's own record for assertions.
    builder.from = (source: unknown) => {
      const inner =
        typeof source === 'object' && source !== null
          ? (source as { [FAKE_SUBQUERY]?: RecordedQuery })[FAKE_SUBQUERY]
          : undefined;
      if (inner) {
        recorded.table = inner.table;
        recorded.subquery = inner;
      } else {
        recorded.table = is(source, Table) ? getTableName(source) : null;
      }
      return builder;
    };
    // Rendered in call order across every builder, so a test can read the WHERE
    // the popular-sort SUBQUERY emitted (built first, never awaited) as well as
    // the main query's.
    builder.where = (condition: SQL | undefined) => {
      whereClauses.push(condition ? dialect.sqlToQuery(condition).sql : '');
      return builder;
    };
    // `.as()` ends a subquery. The real return is a drizzle subquery whose
    // columns the caller references; this stand-in renders any column as
    // `"alias"."key"` (the popular-count join key and sort column, the ranked
    // page's fields) and carries this builder's record for `from()`.
    builder.as = (alias: string) =>
      new Proxy(
        {},
        {
          get: (_target, key) => {
            if (key === FAKE_SUBQUERY) return recorded;
            if (typeof key !== 'string' || key === 'then' || key === 'constructor') return undefined;
            return sql.raw(`"${alias}"."${key}"`);
          },
        },
      );
    builder.orderBy = (...fragments: SQL[]) => {
      recorded.orderBy = fragments.map((fragment) => dialect.sqlToQuery(fragment).sql);
      return builder;
    };
    // A real, spec-compliant thenable so drizzle's internal `await` can't
    // swallow a rejection and so this reliably resolves like a genuine query.
    builder.then = (
      onFulfilled?: ((value: unknown) => unknown) | null,
      onRejected?: ((reason: unknown) => unknown) | null,
    ) => {
      callOrder.push('select');
      queries.push(recorded);
      const rows = scriptedRows[queries.length - 1] ?? [];
      return Promise.resolve(rows).then(onFulfilled, onRejected);
    };
    return builder;
  };

  const tx = {
    execute: (statement: SQL) => {
      callOrder.push('execute');
      executedStatements.push(statement);
      return Promise.resolve([]);
    },
    select: (fields?: Record<string, unknown>) => makeSelectBuilder(fields),
  };

  const fakeDb = {
    transaction: (callback: (transactionDb: typeof tx) => unknown) => callback(tx),
  };

  return { fakeDb, callOrder, executedStatements, queries, whereClauses };
}

/**
 * The #3856 regression net, expressed as an invariant rather than a fixed call
 * list: every SELECT must be immediately preceded by its own SET LOCAL guard, and
 * every executed statement must BE that guard. Deleting the guard from either
 * statsDrivenSearch or standardSearch turns this red.
 */
function assertEverySelectIsGuarded(callOrder: string[], executedStatements: SQL[]): void {
  assert.ok(callOrder.length > 0, 'expected at least one statement');
  assert.equal(callOrder.length % 2, 0, `expected alternating execute/select pairs; saw: ${callOrder.join(', ')}`);
  for (let index = 0; index < callOrder.length; index += 2) {
    assert.equal(
      callOrder[index],
      'execute',
      `statement ${index} must be the SET LOCAL guard: ${callOrder.join(', ')}`,
    );
    assert.equal(callOrder[index + 1], 'select', `statement ${index + 1} must be the SELECT: ${callOrder.join(', ')}`);
  }
  const rendered = executedStatements.map((statement) => dialect.sqlToQuery(statement).sql);
  assert.equal(rendered.length, callOrder.length / 2, 'every SELECT must have its own executed guard statement');
  for (const statement of rendered) {
    assert.ok(
      GUARD_PATTERN.test(statement),
      `expected a SET LOCAL max_parallel_workers_per_gather = 0 guard; saw: ${statement}`,
    );
  }
}

const SEARCH_PARAMS: BoardRouteParams = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 10,
  set_ids: [1, 20],
  angle: 40,
};

void describe('search queries — DSM parallelism guard (#3856)', () => {
  void it('runs the stats-driven query inside a transaction that disables per-gather parallelism first', async () => {
    const { fakeDb, callOrder, executedStatements, queries } = createFakeSearchDb();

    // minAscents makes this 'stats-driven-only' (a stats predicate can't be met
    // through the LEFT JOIN), isolating the assertion to statsDrivenSearch's own
    // guard — the same shape as the production repro (Sentry BOARDSESH-AK: page 1,
    // narrow grade band, pageSize 100).
    await searchClimbs(fakeDb as unknown as DbInstance, SEARCH_PARAMS, {
      page: 1,
      pageSize: 100,
      sortBy: 'ascents',
      sortOrder: 'desc',
      minAscents: 1,
    });

    assert.deepEqual(callOrder, ['execute', 'select'], 'stats filters must keep this on the stats-driven path only');
    assert.equal(queries[0].table, 'board_climb_stats');
    assertEverySelectIsGuarded(callOrder, executedStatements);
  });

  void it('guards both queries when the stats-driven path falls back to the standard search', async () => {
    // No stats filters + an empty stats-driven page ⇒ the fallback runs too, so
    // this covers standardSearch's guard (07dfe54b2) in the same walk.
    const { fakeDb, callOrder, executedStatements } = createFakeSearchDb();

    await searchClimbs(fakeDb as unknown as DbInstance, SEARCH_PARAMS, {
      page: 1,
      pageSize: 100,
      sortBy: 'ascents',
      sortOrder: 'desc',
    });

    assert.deepEqual(callOrder, ['execute', 'select', 'execute', 'select']);
    assertEverySelectIsGuarded(callOrder, executedStatements);
  });

  void it('also guards the quality-sort stats-driven path', async () => {
    const { fakeDb, callOrder, executedStatements } = createFakeSearchDb();

    await searchClimbs(fakeDb as unknown as DbInstance, SEARCH_PARAMS, {
      page: 1,
      pageSize: 20,
      sortBy: 'quality',
      sortOrder: 'desc',
      minRating: 3,
    });

    assert.deepEqual(callOrder, ['execute', 'select']);
    assertEverySelectIsGuarded(callOrder, executedStatements);
  });
});

void describe('stats-driven fallback past the first page (#1971)', () => {
  void it('falls back to the LEFT JOIN search on page 2 and returns the fallback query results', async () => {
    // First select (stats-driven) returns fewer than pageSize+1 rows ⇒ partial page.
    // Second select (fallback) returns pageSize+1 rows ⇒ trimmed page with hasMore.
    const { fakeDb, queries } = createFakeSearchDb([
      [fakeRow('stats-only-1')],
      [fakeRow('unified-1'), fakeRow('unified-2'), fakeRow('unified-3')],
    ]);

    const result = await searchClimbs(fakeDb as unknown as DbInstance, SEARCH_PARAMS, {
      page: 2,
      pageSize: 2,
      sortBy: 'ascents',
      sortOrder: 'desc',
    });

    assert.equal(queries.length, 2, 'a partial stats-driven page past page 0 must still fall back');
    assert.equal(queries[0].table, 'board_climb_stats', 'the first query is the stats-driven INNER JOIN');
    assert.equal(queries[1].table, 'board_climbs', 'the fallback query is the unified LEFT JOIN');
    assert.deepEqual(
      result.climbs.map((climb) => climb.uuid),
      ['unified-1', 'unified-2'],
      'searchClimbs must return the fallback rows, not the truncated stats-driven ones',
    );
    assert.equal(result.hasMore, true, 'hasMore must come from the fallback query');
  });

  void it('keeps a full stats-driven page as-is (no fallback when the page is not exhausted)', async () => {
    const { fakeDb, queries } = createFakeSearchDb([[fakeRow('stats-1'), fakeRow('stats-2'), fakeRow('stats-3')]]);

    const result = await searchClimbs(fakeDb as unknown as DbInstance, SEARCH_PARAMS, {
      page: 2,
      pageSize: 2,
      sortBy: 'ascents',
      sortOrder: 'desc',
    });

    assert.equal(queries.length, 1, 'a full stats-driven page must not pay for a second query');
    assert.deepEqual(
      result.climbs.map((climb) => climb.uuid),
      ['stats-1', 'stats-2'],
    );
    assert.equal(result.hasMore, true);
  });

  void it('orders stats-having climbs ahead of stats-less ones in the fallback query only', async () => {
    const { fakeDb, queries } = createFakeSearchDb();

    await searchClimbs(fakeDb as unknown as DbInstance, SEARCH_PARAMS, {
      page: 2,
      pageSize: 2,
      sortBy: 'ascents',
      sortOrder: 'desc',
    });

    assert.equal(queries.length, 2);
    // The stats-driven query INNER JOINs, so every row has a stats row — no key.
    assert.ok(
      !queries[0].orderBy.some((fragment) => STATS_PRESENCE_KEY_PATTERN.test(fragment)),
      `stats-driven query must not carry the stats-presence key; saw: ${queries[0].orderBy.join(' | ')}`,
    );
    assert.ok(
      STATS_PRESENCE_KEY_PATTERN.test(queries[1].orderBy[0] ?? ''),
      `fallback ORDER BY must LEAD with the stats-presence key; saw: ${queries[1].orderBy.join(' | ')}`,
    );
  });

  void it('does not add the stats-presence key to a standard-only search', async () => {
    const { fakeDb, queries } = createFakeSearchDb();

    // 'creation' has no stats-driven index path ⇒ standard-only. Adding the key
    // here would reorder creation/name/popular and break the random shuffle.
    await searchClimbs(fakeDb as unknown as DbInstance, SEARCH_PARAMS, {
      page: 2,
      pageSize: 2,
      sortBy: 'creation',
      sortOrder: 'desc',
    });

    assert.equal(queries.length, 1);
    assert.equal(queries[0].table, 'board_climbs');
    assert.ok(
      !queries[0].orderBy.some((fragment) => STATS_PRESENCE_KEY_PATTERN.test(fragment)),
      `standard-only query must not carry the stats-presence key; saw: ${queries[0].orderBy.join(' | ')}`,
    );
  });
});

void describe('community-hidden climbs (#5049)', () => {
  // The rendered WHERE, not a re-derived predicate: deleting the filter from
  // create-climb-filters or from the popular subquery turns these red.
  void it('keeps hidden climbs out of an ordinary browse page', async () => {
    const { fakeDb, whereClauses } = createFakeSearchDb();

    await searchClimbs(fakeDb as unknown as DbInstance, SEARCH_PARAMS, {
      page: 0,
      pageSize: 20,
      sortBy: 'creation',
      sortOrder: 'desc',
    });

    assert.equal(whereClauses.length, 1, 'the creation sort runs one standard query');
    assert.match(whereClauses[0], /"board_climbs"\."is_hidden" = \$\d+/);
  });

  void it('lets an explicit name search reach one', async () => {
    const { fakeDb, whereClauses } = createFakeSearchDb();

    await searchClimbs(fakeDb as unknown as DbInstance, SEARCH_PARAMS, {
      page: 0,
      pageSize: 20,
      sortBy: 'creation',
      sortOrder: 'desc',
      name: 'Spiders Man',
    });

    assert.doesNotMatch(whereClauses[0], /is_hidden/);
    assert.match(whereClauses[0], /ilike/i, 'the name predicate is what replaced it');
  });

  void it('never counts a hidden climb toward the popular sort, even under a name search', async () => {
    const { fakeDb, whereClauses } = createFakeSearchDb();

    await searchClimbs(fakeDb as unknown as DbInstance, SEARCH_PARAMS, {
      page: 0,
      pageSize: 20,
      sortBy: 'popular',
      sortOrder: 'desc',
      name: 'Spiders Man',
    });

    assert.equal(whereClauses.length, 2, 'the popular sort builds its counts subquery, then the page query');
    const [popularCountsWhere, pageWhere] = whereClauses;
    // The cross-angle ascent totals are a ranking input, not a result row, so the
    // subquery filters unconditionally...
    assert.match(popularCountsWhere, /"board_climbs"\."is_hidden" = false/);
    // ...while the page itself still answers the name search.
    assert.doesNotMatch(pageWhere, /is_hidden/);
  });
});

/**
 * Personal grades (#4828). The sort has to key on the SAME expression the WHERE
 * admitted the row on, and both have to name the joined subquery by its alias.
 *
 * Drizzle silently drops a subquery alias when an `.as()` field is interpolated
 * into a `sql` template, so the ordering expression renders as a bare
 * `COALESCE("difficulty", …)` unless it is written with `sql.identifier`. That
 * resolves today only because nothing else in the join tree exposes a column
 * called `difficulty` — one rename away from ordering the list by the wrong
 * number while the filter keys the right one.
 */
void describe('personal grades: the difficulty sort keys on the joined alias (#4828)', () => {
  const personalSearch = {
    page: 0,
    pageSize: 20,
    sortBy: 'difficulty' as const,
    sortOrder: 'asc' as const,
    useMyGrades: true,
    minGrade: 26,
    maxGrade: 28,
  };

  void it('orders by COALESCE("my_grade"."difficulty", the crowd grade), table-qualified', async () => {
    const { fakeDb, queries } = createFakeSearchDb();

    await searchClimbs(fakeDb as unknown as DbInstance, SEARCH_PARAMS, personalSearch, 'grade-rule-user');

    assert.equal(queries.length, 1, 'a difficulty sort routes to the standard search only');
    const orderBy = queries[0].orderBy.join(' | ');
    assert.match(
      orderBy,
      /coalesce\("my_grade"\."difficulty", round\("board_climb_stats"\."display_difficulty"::numeric, 0\)\)/i,
      `the difficulty sort must name the personal-grade alias; saw: ${orderBy}`,
    );
    assert.doesNotMatch(
      orderBy,
      /coalesce\(\s*"difficulty"/i,
      `an unqualified "difficulty" resolves only by luck; saw: ${orderBy}`,
    );
  });

  void it('keys on the crowd grade alone when the climber did not ask for their own', async () => {
    const { fakeDb, queries } = createFakeSearchDb();

    await searchClimbs(
      fakeDb as unknown as DbInstance,
      SEARCH_PARAMS,
      { ...personalSearch, useMyGrades: false },
      'grade-rule-user',
    );

    const orderBy = queries[0].orderBy.join(' | ');
    assert.doesNotMatch(orderBy, /my_grade/i, `saw a personal-grade join in a crowd-grade search: ${orderBy}`);
    assert.match(orderBy, /round\("board_climb_stats"\."display_difficulty"::numeric, 0\)/i);
  });

  void it('keys on the crowd grade alone for an anonymous search', async () => {
    const { fakeDb, queries } = createFakeSearchDb();

    // No userId: there are no ticks to read, so the alias must not appear in
    // either the ORDER BY or (by construction) the WHERE that references it.
    await searchClimbs(fakeDb as unknown as DbInstance, SEARCH_PARAMS, personalSearch);

    assert.doesNotMatch(queries[0].orderBy.join(' | '), /my_grade/i);
  });
});

// Issue #5405. A Woods climb has exactly one stats row, at its set angle, so the
// stats-driven INNER JOIN at the browsed angle returned only the climbs set there
// — 653 of 5,392 at 30° — and the fallback's stats-presence key would have kept
// them ahead anyway. Cross-angle drops both mechanisms. Since #5642 it is an
// opt-in on Woods too (or a by-name search), and the default is the browsed-angle
// restriction instead.
void describe('cross-angle stats (issue #5405)', () => {
  const WOODS_PARAMS: BoardRouteParams = { ...SEARCH_PARAMS, board_name: 'woods', size_id: 1, set_ids: [1] };

  void it('issues one LEFT-JOIN query with no stats-driven pass, on an opted-in angle-bound board', async () => {
    const { fakeDb, queries, whereClauses } = createFakeSearchDb();

    await searchClimbs(fakeDb as unknown as DbInstance, WOODS_PARAMS, {
      page: 2,
      pageSize: 2,
      sortBy: 'ascents',
      sortOrder: 'desc',
      crossAngleStats: true,
    });

    assert.equal(queries.length, 1, 'cross-angle must not run the stats-driven pass at all');
    assert.equal(queries[0].table, 'board_climbs');
    assert.ok(
      queries[0].joins.includes('stats_set_angle'),
      `expected the set-angle stats join; saw: ${queries[0].joins.join(', ')}`,
    );
    // The key exists to pin stats-having climbs ahead of stats-less ones. Under
    // cross-angle that is exactly the ordering the bug was made of.
    assert.ok(
      !queries[0].orderBy.some((fragment) => STATS_PRESENCE_KEY_PATTERN.test(fragment)),
      `cross-angle must not carry the stats-presence key; saw: ${queries[0].orderBy.join(' | ')}`,
    );
    // An opted-in search wants every angle's climbs.
    assert.doesNotMatch(whereClauses[0], BROWSED_ANGLE_RESTRICTION_PATTERN);
  });

  void it('keeps the stats-driven path and the second join off an Aurora board', async () => {
    const { fakeDb, queries, whereClauses } = createFakeSearchDb();

    await searchClimbs(fakeDb as unknown as DbInstance, SEARCH_PARAMS, {
      page: 2,
      pageSize: 2,
      sortBy: 'ascents',
      sortOrder: 'desc',
    });

    assert.equal(queries.length, 2, 'Aurora keeps the stats-driven pass plus its fallback');
    assert.ok(
      !queries.some((query) => query.joins.includes('stats_set_angle')),
      'an Aurora search without the opt-in must emit no set-angle join',
    );
    // Aurora climbs are not angle-bound, so there is no angle for one to belong to.
    for (const where of whereClauses) assert.doesNotMatch(where, BROWSED_ANGLE_RESTRICTION_PATTERN);
  });

  void it('takes the opt-in on an Aurora board', async () => {
    const { fakeDb, queries, whereClauses } = createFakeSearchDb();

    await searchClimbs(fakeDb as unknown as DbInstance, SEARCH_PARAMS, {
      page: 0,
      pageSize: 2,
      sortBy: 'ascents',
      sortOrder: 'desc',
      crossAngleStats: true,
    });

    assert.equal(queries.length, 1);
    assert.ok(queries[0].joins.includes('stats_set_angle'));
    assert.doesNotMatch(whereClauses[0], BROWSED_ANGLE_RESTRICTION_PATTERN);
  });

  // A grade or ascent filter is what a climber reaches for when the list looks
  // short, and it is the one input that routed to stats-driven-only. It must not
  // send a cross-angle search back through the INNER JOIN.
  void it('stays on the LEFT-JOIN path with a grade filter active', async () => {
    const { fakeDb, queries } = createFakeSearchDb();

    await searchClimbs(fakeDb as unknown as DbInstance, WOODS_PARAMS, {
      page: 0,
      pageSize: 2,
      sortBy: 'ascents',
      sortOrder: 'desc',
      minGrade: 10,
      maxGrade: 20,
      crossAngleStats: true,
    });

    assert.equal(queries.length, 1);
    assert.equal(queries[0].table, 'board_climbs');
    assert.ok(queries[0].joins.includes('stats_set_angle'));
  });
});

// Issue #5642. Without the opt-in a Woods search keeps only the climbs that belong
// to the browsed angle. It is an ordinary WHERE predicate, so the search takes the
// normal stats-driven path plus fallback, and both queries have to carry it — or
// the fallback page would list climbs the count badge never counted.
void describe('browsed-angle restriction on an angle-bound board (issue #5642)', () => {
  const WOODS_PARAMS: BoardRouteParams = { ...SEARCH_PARAMS, board_name: 'woods', size_id: 1, set_ids: [1] };
  const ascentsPage = { page: 2, pageSize: 2, sortBy: 'ascents', sortOrder: 'desc' } as const;

  void it('takes the stats-driven path plus fallback, with the restriction in both WHEREs', async () => {
    const { fakeDb, queries, whereClauses } = createFakeSearchDb();

    await searchClimbs(fakeDb as unknown as DbInstance, WOODS_PARAMS, ascentsPage);

    assert.equal(queries.length, 2, 'a partial stats-driven page falls back, exactly as on Aurora');
    assert.equal(queries[0].table, 'board_climb_stats');
    assert.equal(queries[1].table, 'board_climbs');
    assert.ok(
      !queries.some((query) => query.joins.includes('stats_set_angle')),
      'the restriction reads the browsed angle only; there is no set-angle row to join',
    );
    assert.equal(whereClauses.length, 2);
    for (const where of whereClauses) assert.match(where, BROWSED_ANGLE_RESTRICTION_PATTERN);
    // The fallback is still the prefix-compatible continuation of the stats-driven
    // pages: every stats-having climb passes the restriction's stats arm, so the
    // stats-having prefix is the same set in the same order.
    assert.ok(STATS_PRESENCE_KEY_PATTERN.test(queries[1].orderBy[0] ?? ''));
  });

  void it('treats an explicit false exactly like an omitted field', async () => {
    const omitted = createFakeSearchDb();
    await searchClimbs(omitted.fakeDb as unknown as DbInstance, WOODS_PARAMS, ascentsPage);
    const explicitFalse = createFakeSearchDb();
    await searchClimbs(explicitFalse.fakeDb as unknown as DbInstance, WOODS_PARAMS, {
      ...ascentsPage,
      crossAngleStats: false,
    });

    // The mobile count preview and the web SSR page omit the field while the list
    // sends `false`; the two must describe one list.
    assert.deepEqual(explicitFalse.whereClauses, omitted.whereClauses);
    assert.deepEqual(explicitFalse.queries, omitted.queries);
  });

  void it('stays restricted on the standard-only path too', async () => {
    const { fakeDb, queries, whereClauses } = createFakeSearchDb();

    await searchClimbs(fakeDb as unknown as DbInstance, WOODS_PARAMS, {
      ...ascentsPage,
      sortBy: 'difficulty',
    });

    assert.equal(queries.length, 1);
    assert.equal(queries[0].table, 'board_climbs');
    assert.match(whereClauses[0], BROWSED_ANGLE_RESTRICTION_PATTERN);
  });

  // Somebody typing a climb's name wants that climb whatever angle it was set at,
  // graded by the row at that angle — the same exception the community-hidden
  // filter makes for a name search.
  void it('lets a by-name search reach every angle, resolved cross-angle', async () => {
    const { fakeDb, queries, whereClauses } = createFakeSearchDb();

    await searchClimbs(fakeDb as unknown as DbInstance, WOODS_PARAMS, { ...ascentsPage, name: 'Crimp' });

    assert.equal(queries.length, 1, 'a name search on Woods is cross-angle, so it skips the stats-driven pass');
    assert.ok(queries[0].joins.includes('stats_set_angle'));
    assert.doesNotMatch(whereClauses[0], BROWSED_ANGLE_RESTRICTION_PATTERN);
  });

  void it("shows a user's own drafts list whatever angle each draft was saved at", async () => {
    const { fakeDb, whereClauses } = createFakeSearchDb();

    await searchClimbs(fakeDb as unknown as DbInstance, WOODS_PARAMS, { ...ascentsPage, onlyDrafts: true }, 'user-1');

    assert.equal(whereClauses.length, 1, 'a drafts query is standard-only');
    assert.doesNotMatch(whereClauses[0], BROWSED_ANGLE_RESTRICTION_PATTERN);
  });

  void it('does not exempt onlyDrafts without a user — that is not a drafts query', async () => {
    const { fakeDb, whereClauses } = createFakeSearchDb();

    await searchClimbs(fakeDb as unknown as DbInstance, WOODS_PARAMS, { ...ascentsPage, onlyDrafts: true });

    for (const where of whereClauses) assert.match(where, BROWSED_ANGLE_RESTRICTION_PATTERN);
  });
});

// The stats-driven page is ranked and cut with no board_climb_grades join, and
// only the page's rows look the Boardsesh grade up. Joined inside the ranked
// query, the grades row was fetched for every row the plan visited — most of the
// disk reads this query did in production. These pin WHEN the join happens for
// each kind of search; create-climb-filters.test.ts pins the split grade filter.
void describe('stats-driven path: Boardsesh grades joined after the page is cut', () => {
  const gradeBand = {
    page: 0,
    pageSize: 20,
    sortBy: 'ascents',
    sortOrder: 'desc',
    minGrade: 26,
    maxGrade: 28,
  } as const;

  void it('ranks the page from board_climb_stats + board_climbs, then joins the grades onto it', async () => {
    const { fakeDb, queries, whereClauses } = createFakeSearchDb();

    await searchClimbs(fakeDb as unknown as DbInstance, SEARCH_PARAMS, { ...gradeBand, minAscents: 1 });

    assert.equal(queries.length, 1);
    const [pageQuery] = queries;
    assert.ok(pageQuery.subquery, 'the stats-driven page must be read through the ranked subquery');
    assert.equal(pageQuery.subquery.table, 'board_climb_stats');
    assert.deepEqual(pageQuery.subquery.joins, ['board_climbs'], 'nothing but board_climbs may join before LIMIT');
    assert.deepEqual(pageQuery.joins, ['board_climb_grades'], 'the grades join belongs on the cut page');
    // The ranked query orders on the covering index's keys; the outer query puts
    // the joined page back in that order.
    assert.deepEqual(pageQuery.subquery.orderBy, [
      '"board_climb_stats"."ascensionist_count" DESC NULLS LAST',
      '"board_climb_stats"."climb_uuid" desc',
    ]);
    assert.deepEqual(pageQuery.orderBy, ['"ranked_page"."sort_key" DESC NULLS LAST', '"ranked_page"."sort_uuid" desc']);
    // The grade filter reads board_climb_grades only through the aliased probe.
    assert.equal(whereClauses.length, 1);
    assert.match(whereClauses[0], /"grade_fallback"/);
    assert.doesNotMatch(whereClauses[0], /"board_climb_grades"\."/);
    // Pins the outer SELECT's hand-listed columns to statsDrivenClimbFields(), so a forgotten field can't silently vanish.
    const climbFieldKeys = Object.keys(statsDrivenClimbFields());
    for (const key of climbFieldKeys) {
      assert.ok(pageQuery.selectKeys.includes(key), `outer SELECT is missing ${key}`);
    }
    assert.deepEqual(
      pageQuery.selectKeys.filter((key) => !climbFieldKeys.includes(key)).sort(),
      ['boardsesh_confidence', 'boardsesh_difficulty'],
      'only the Boardsesh grade columns may be added on top of statsDrivenClimbFields()',
    );
  });

  void it('takes the same shape with no grade filter, and for the quality sort', async () => {
    for (const search of [
      { page: 0, pageSize: 20, sortBy: 'ascents', sortOrder: 'desc', minAscents: 1 },
      { ...gradeBand, sortBy: 'quality', minRating: 3 },
    ] as const) {
      const { fakeDb, queries } = createFakeSearchDb();
      await searchClimbs(fakeDb as unknown as DbInstance, SEARCH_PARAMS, search);
      assert.deepEqual(queries[0].subquery?.joins, ['board_climbs']);
      assert.deepEqual(queries[0].joins, ['board_climb_grades']);
    }
  });

  void it('keeps the grades join inside the ranked query under the Boardsesh grade source', async () => {
    // The Boardsesh source filters on the Boardsesh grade FIRST, so every
    // candidate row needs its grades row before it can be kept or dropped.
    const { fakeDb, queries, whereClauses } = createFakeSearchDb();

    await searchClimbs(fakeDb as unknown as DbInstance, SEARCH_PARAMS, {
      ...gradeBand,
      minAscents: 1,
      gradeSource: 'boardsesh',
    });

    assert.equal(queries[0].subquery, undefined);
    assert.equal(queries[0].table, 'board_climb_stats');
    assert.deepEqual(queries[0].joins, ['board_climbs', 'board_climb_grades']);
    assert.match(whereClauses[0], /"board_climb_grades"\."confidence" = 'setter_only'/);
    assert.doesNotMatch(whereClauses[0], /grade_fallback/);
  });

  void it('keeps the grades join inside the ranked query under personal grades', async () => {
    const { fakeDb, queries, whereClauses } = createFakeSearchDb();

    await searchClimbs(
      fakeDb as unknown as DbInstance,
      SEARCH_PARAMS,
      { ...gradeBand, minAscents: 1, useMyGrades: true },
      'grade-rule-user',
    );

    assert.equal(queries[0].subquery, undefined);
    assert.deepEqual(queries[0].joins, ['board_climbs', 'board_climb_grades']);
    assert.match(whereClauses.at(-1) ?? '', /coalesce\("my_grade"\."difficulty"/i);
  });

  void it('hands the page rows back in the order the query returned them', async () => {
    const { fakeDb } = createFakeSearchDb([[fakeRow('first'), fakeRow('second'), fakeRow('third')]]);

    const result = await searchClimbs(fakeDb as unknown as DbInstance, SEARCH_PARAMS, {
      ...gradeBand,
      pageSize: 2,
      minAscents: 1,
    });

    assert.deepEqual(
      result.climbs.map((climb) => climb.uuid),
      ['first', 'second'],
    );
    assert.equal(result.hasMore, true);
  });
});

/**
 * C9: once a board's `board_climb_popularity` build has finished, the popular
 * sort walks that table in index order instead of aggregating every stats row
 * of the board (docs/climb-popularity.md).
 */
void describe('popular sort: board_climb_popularity walk', () => {
  // The readiness answer is cached per process for 60 s; every case resets it
  // before and after, so no other test inherits a "ready" board.
  const withReadyBoard = (ready: boolean, scriptedRows: Record<string, unknown>[][]) => {
    resetClimbPopularityReadinessForTests();
    const fake = createFakeSearchDb(scriptedRows);
    // The readiness probe is a plain select on the top-level db, outside any
    // transaction: answer it with one row when the board is built.
    const readinessBuilder: Record<string, unknown> = {};
    for (const method of ['from', 'where', 'limit']) readinessBuilder[method] = () => readinessBuilder;
    readinessBuilder.then = (onFulfilled?: (value: unknown) => unknown) =>
      Promise.resolve(ready ? [{ boardType: 'kilter' }] : []).then(onFulfilled);
    return { ...fake, db: { ...fake.fakeDb, select: () => readinessBuilder } as unknown as DbInstance };
  };
  const popular = { page: 0, pageSize: 20, sortBy: 'popular', sortOrder: 'desc' } as const;

  void it('walks the rank index when the board is built', async () => {
    const walkPage = Array.from({ length: 21 }, (_, index) => fakeRow(`climb-${index}`));
    const { db, queries, callOrder, executedStatements } = withReadyBoard(true, [walkPage]);
    try {
      const result = await searchClimbs(db, SEARCH_PARAMS, popular);
      assert.equal(result.climbs.length, 20);
      assert.equal(result.hasMore, true);
      assert.equal(queries.length, 1, 'a full walk page needs no fallback');
      assert.equal(queries[0].table, 'board_climb_popularity');
      // Bare DESC on both keys: the index's own order, so no Sort node.
      assert.deepEqual(queries[0].subquery?.orderBy, [
        '"board_climb_popularity"."total_ascensionist_count" desc',
        '"board_climb_popularity"."climb_uuid" desc',
      ]);
      assert.ok(queries[0].subquery?.joins.includes('board_climb_stats'), 'the live stats row is re-checked');
      assertEverySelectIsGuarded(callOrder, executedStatements);
    } finally {
      resetClimbPopularityReadinessForTests();
    }
  });

  void it('falls back to the ordered standard search when the walk runs out', async () => {
    const { db, queries } = withReadyBoard(true, [[fakeRow('only-walk-row')], [fakeRow('only-walk-row')]]);
    try {
      await searchClimbs(db, SEARCH_PARAMS, popular);
      assert.equal(queries.length, 2);
      assert.equal(queries[1].table, 'board_climbs');
      assert.ok(queries[1].joins.includes('popularity_at_angle'), 'the fallback marks the walk rows');
    } finally {
      resetClimbPopularityReadinessForTests();
    }
  });

  void it('keeps the old aggregation until the board is built', async () => {
    const { db, queries, whereClauses } = withReadyBoard(false, []);
    try {
      await searchClimbs(db, SEARCH_PARAMS, popular);
      assert.equal(queries.length, 1);
      assert.equal(queries[0].table, 'board_climbs');
      assert.equal(whereClauses.length, 2, 'the popular_counts subquery, then the page query');
    } finally {
      resetClimbPopularityReadinessForTests();
    }
  });

  void it('keeps the old aggregation under cross-angle stats', async () => {
    const { db, queries } = withReadyBoard(true, []);
    try {
      await searchClimbs(db, SEARCH_PARAMS, { ...popular, crossAngleStats: true });
      assert.ok(queries.length > 0);
      assert.ok(queries.every((query) => query.table !== 'board_climb_popularity'));
    } finally {
      resetClimbPopularityReadinessForTests();
    }
  });
});
