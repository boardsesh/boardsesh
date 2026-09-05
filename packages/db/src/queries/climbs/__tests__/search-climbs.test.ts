import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PgDialect } from 'drizzle-orm/pg-core';
import { getTableName, is, Table, type SQL } from 'drizzle-orm';
import { chooseSearchPath, getStatsDrivenSort, clampSearchPage, MAX_SEARCH_PAGE, searchClimbs } from '../search-climbs';
import { mapSearchInputToParams, normalizeSearchSortBy, type BoardRouteParams } from '../types';
import type { DbInstance } from '../../../client/postgres';

const baseInput = {
  statsDrivenSort: 'ascents' as const,
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

/** Minimal row shape searchClimbs' row mapper reads; enough to identify a row by uuid. */
function fakeRow(uuid: string): Record<string, unknown> {
  return {
    uuid,
    setter_username: null,
    userId: null,
    name: uuid,
    frames: null,
    is_draft: false,
    angle: 40,
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
type RecordedQuery = { table: string | null; orderBy: string[] };

// Fake SearchDb: a minimal stand-in for a top-level Drizzle instance. Every
// select chain method returns the same builder object, and awaiting it (via a
// real `.then`) records that the query ran — so a test can assert the query
// executed AFTER the SET LOCAL guard, not before or instead of it. Mirrors the
// mock in packages/web/app/lib/db/queries/climbs/__tests__/holds-heatmap.test.ts,
// adapted to node:test (no module mocking needed — searchClimbs takes `db` as
// a plain parameter).
//
// Each builder also records the table `from()` was called with and the RENDERED
// ORDER BY fragments, so a test can assert on the SQL the code actually emitted
// instead of re-deriving an expectation from the same helpers. `scriptedRows`
// supplies the rows the Nth select resolves with (default: none).
function createFakeSearchDb(scriptedRows: Record<string, unknown>[][] = []) {
  const callOrder: string[] = [];
  const executedStatements: SQL[] = [];
  const queries: RecordedQuery[] = [];

  const makeSelectBuilder = () => {
    const recorded: RecordedQuery = { table: null, orderBy: [] };
    const builder: Record<string, unknown> = {};
    for (const method of ['innerJoin', 'leftJoin', 'where', 'limit', 'offset']) {
      builder[method] = () => builder;
    }
    builder.from = (source: unknown) => {
      recorded.table = is(source, Table) ? getTableName(source) : null;
      return builder;
    };
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
    select: () => makeSelectBuilder(),
  };

  const fakeDb = {
    transaction: (callback: (transactionDb: typeof tx) => unknown) => callback(tx),
  };

  return { fakeDb, callOrder, executedStatements, queries };
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
