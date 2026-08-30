import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, sql } from 'drizzle-orm';
import { searchClimbs } from '../search-climbs';
import { createClimbFilters } from '../create-climb-filters';
import { boardClimbs, boardClimbStats } from '../../../schema/index';
import type { DbInstance } from '../../../client/postgres';
import type { BoardRouteParams, ClimbSearchParams } from '../types';

/**
 * EXPLAIN-based plan-shape regression harness for the hottest query in the app.
 *
 * Opt-in: only runs when EXPLAIN_DB_URL points at a realistic dev DB (postgres:17
 * with full Kilter/Tension/MoonBoard data — `vp run db:up`, then read the URL from
 * .boardsesh/dev-db.env). Without it the suite self-skips so CI and dataless
 * machines stay green. NEVER point this at the backend test DB (empty postgres:15,
 * no covering indexes) — empty-table plans are seq scans regardless of indexes.
 *
 *   vp run db:up
 *   EXPLAIN_DB_URL=postgres://postgres:password@<host>:5432/main pnpm --filter @boardsesh/db run test:explain
 *
 * It captures the EXACT parameterised SQL the app generates (via a drizzle query
 * logger — no hand-reconstruction for searchClimbs, so the harness can't drift
 * from runtime), runs EXPLAIN (FORMAT JSON), and asserts COARSE plan invariants
 * only (index used, no seq scan, SET LOCAL present). It never compares plan text.
 *
 * Set EXPLAIN_ANALYZE=1 for human-read timings (logged, never asserted).
 */
const EXPLAIN_DB_URL = process.env.EXPLAIN_DB_URL;
const RUN_ANALYZE = process.env.EXPLAIN_ANALYZE === '1';

const PARAMS: BoardRouteParams = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 10,
  set_ids: [1, 20],
  angle: 40,
};

// PARAMS with no set-id restriction. Dropping the `required_set_ids <@ …`
// selectivity removes the GIN bitmap that keeps the count's board_climbs scan
// cheap, which is what tips countClimbs' plan from a serial bitmap scan to the
// Parallel Hash Join + Parallel Seq Scan that exhausted /dev/shm in #2378.
const BROAD_PARAMS: BoardRouteParams = { ...PARAMS, set_ids: [] };

type PlanNode = { type: string; index?: string; rel?: string };

function collectNodes(plan: Record<string, unknown>, acc: PlanNode[] = []): PlanNode[] {
  if (!plan || typeof plan !== 'object') return acc;
  if (typeof plan['Node Type'] === 'string') {
    acc.push({
      type: plan['Node Type'] as string,
      index: plan['Index Name'] as string | undefined,
      rel: plan['Relation Name'] as string | undefined,
    });
  }
  for (const child of (plan['Plans'] as Record<string, unknown>[] | undefined) ?? []) collectNodes(child, acc);
  return acc;
}

type Captured = { query: string; params: unknown[] };

if (!EXPLAIN_DB_URL) {
  void describe('search-climbs EXPLAIN harness', () => {
    void it('skipped — set EXPLAIN_DB_URL to a full-data dev DB to run', { skip: true }, () => {});
  });
} else {
  const client = postgres(EXPLAIN_DB_URL, { prepare: false, max: 2, idle_timeout: 5 });
  const captured: Captured[] = [];
  const db = drizzle(client, {
    logger: { logQuery: (query, params) => captured.push({ query, params }) },
  }) as unknown as DbInstance;

  const tableSelects = (statements: Captured[]) =>
    statements.filter((c) => /select/i.test(c.query) && /board_climb/i.test(c.query) && !/^\s*explain/i.test(c.query));

  // Planner GUCs applied as SET LOCAL (inside a transaction) before EXPLAIN.
  // GUARD mirrors the runtime guard standardSearch / countClimbs wrap their query
  // in. FORCE_PARALLEL makes the planner strongly prefer a parallel plan so the
  // "unguarded" control in the count regression is non-vacuous regardless of the
  // dev DB's default parallelism tuning.
  const GUARD = ['SET LOCAL max_parallel_workers_per_gather = 0'];
  const FORCE_PARALLEL = [
    'SET LOCAL max_parallel_workers_per_gather = 4',
    'SET LOCAL parallel_setup_cost = 0',
    'SET LOCAL parallel_tuple_cost = 0',
    'SET LOCAL min_parallel_table_scan_size = 0',
    'SET LOCAL min_parallel_index_scan_size = 0',
  ];

  async function explainNodes(query: string, params: unknown[], sessionSetup: string[] = []): Promise<PlanNode[]> {
    let rows: postgres.RowList<Record<string, unknown>[]>;
    if (sessionSetup.length > 0) {
      rows = await client.begin(async (tx) => {
        for (const statement of sessionSetup) await tx.unsafe(statement);
        return tx.unsafe(`EXPLAIN (FORMAT JSON) ${query}`, params as never[]);
      });
    } else {
      rows = await client.unsafe(`EXPLAIN (FORMAT JSON) ${query}`, params as never[]);
    }
    const planWrapper = rows[0]['QUERY PLAN'] as Array<{ Plan: Record<string, unknown> }>;
    return collectNodes(planWrapper[0].Plan);
  }

  async function runSearch(searchParams: ClimbSearchParams): Promise<Captured[]> {
    captured.length = 0;
    await searchClimbs(db, PARAMS, searchParams);
    return [...captured];
  }

  // Reconstruct countClimbs' query shape (it lives in packages/backend and can't be
  // imported here). Keep in sync with packages/backend/.../count-climbs.ts.
  function buildCountSql(
    searchParams: ClimbSearchParams,
    params: BoardRouteParams = PARAMS,
  ): { text: string; params: unknown[] } {
    const filters = createClimbFilters(params, searchParams, undefined);
    const isDraftsQuery = filters.isOnlyDrafts;
    const whereConditions = [
      ...filters.getClimbWhereConditions(),
      ...(isDraftsQuery ? [] : filters.getSizeConditions()),
      ...(isDraftsQuery ? [] : filters.getClimbStatsConditions()),
    ];
    const built = db
      .select({ count: sql<number>`count(*)` })
      .from(boardClimbs)
      .leftJoin(boardClimbStats, and(...filters.getClimbStatsJoinConditions()))
      .where(and(...whereConditions))
      .toSQL();
    return { text: built.sql, params: built.params };
  }

  const indexNames = (nodes: PlanNode[]) => nodes.filter((n) => n.index).map((n) => n.index as string);
  const hasSeqScanOnBoardTable = (nodes: PlanNode[]) =>
    nodes.some((n) => n.type === 'Seq Scan' && /board_climb/.test(n.rel ?? ''));
  const hasSortNode = (nodes: PlanNode[]) => nodes.some((n) => /Sort/.test(n.type));
  const hasGatherNode = (nodes: PlanNode[]) => nodes.some((n) => /Gather/.test(n.type));

  async function logTiming(label: string, capture: Captured): Promise<void> {
    try {
      const rows = await client.unsafe(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${capture.query}`,
        capture.params as never[],
      );
      const plan = (rows[0]['QUERY PLAN'] as Array<Record<string, unknown>>)[0];
      // eslint-disable-next-line no-console
      console.log(`[explain] ${label}: ${JSON.stringify(plan['Execution Time'])} ms`);
    } catch {
      /* timing is best-effort */
    }
  }

  void describe('search-climbs EXPLAIN harness (dev DB)', () => {
    // Fresh stats so the planner's choices are trustworthy. The dev-db image ships
    // without a post-import ANALYZE; a cold pull otherwise plans on stale stats.
    void it('prepares stats (ANALYZE)', async () => {
      await client.unsafe('ANALYZE board_climb_stats');
      await client.unsafe('ANALYZE board_climbs');
      await client.unsafe('ANALYZE board_climb_holds');
    });

    void it('hot path (ascents DESC, page 0) is a pure index-ordered scan: no sort, no Gather', async () => {
      const selects = tableSelects(await runSearch({ page: 0, pageSize: 20, sortBy: 'ascents', sortOrder: 'desc' }));
      assert.ok(selects.length >= 1, 'expected a stats-driven SELECT');
      const nodes = await explainNodes(selects[0].query, selects[0].params);
      assert.ok(
        indexNames(nodes).some((n) => /ascents_covering_v2/.test(n)),
        `hot path should use the v2 ascents covering index; saw: ${indexNames(nodes).join(', ')}`,
      );
      assert.equal(hasSeqScanOnBoardTable(nodes), false, 'hot path must not seq-scan a board table');
      // With climb_uuid as a trailing key column, the covering index already returns
      // rows in ORDER BY order — no Incremental Sort, no parallel Gather/DSM.
      assert.equal(hasSortNode(nodes), false, 'hot path must not need a sort (v2 index orders climb_uuid)');
      assert.equal(hasGatherNode(nodes), false, 'hot path must not go parallel (no Incremental Sort to parallelize)');
      if (RUN_ANALYZE) await logTiming('hot path', selects[0]);
    });

    void it('quality DESC page 0 is a pure index-ordered scan: no sort, no Gather', async () => {
      const selects = tableSelects(await runSearch({ page: 0, pageSize: 20, sortBy: 'quality', sortOrder: 'desc' }));
      assert.ok(selects.length >= 1);
      const nodes = await explainNodes(selects[0].query, selects[0].params);
      assert.ok(
        indexNames(nodes).some((n) => /quality_covering_v2/.test(n)),
        `quality path should use the v2 quality covering index; saw: ${indexNames(nodes).join(', ')}`,
      );
      assert.equal(hasSeqScanOnBoardTable(nodes), false);
      assert.equal(hasSortNode(nodes), false, 'quality path must not need a sort (v2 index orders climb_uuid)');
      assert.equal(hasGatherNode(nodes), false, 'quality path must not go parallel');
      if (RUN_ANALYZE) await logTiming('quality path', selects[0]);
    });

    void it('stats-driven deep page (page 3) still uses the ascents covering index', async () => {
      const selects = tableSelects(await runSearch({ page: 3, pageSize: 20, sortBy: 'ascents', sortOrder: 'desc' }));
      assert.ok(selects.length >= 1);
      const nodes = await explainNodes(selects[0].query, selects[0].params);
      assert.ok(indexNames(nodes).some((n) => /ascents_covering/.test(n)));
    });

    void it('standard path (name sort) runs SET LOCAL before the SELECT and avoids a parallel Gather', async () => {
      const statements = await runSearch({ page: 0, pageSize: 20, sortBy: 'name', sortOrder: 'asc' });
      const setLocalIdx = statements.findIndex((s) =>
        /SET LOCAL max_parallel_workers_per_gather\s*=\s*0/i.test(s.query),
      );
      const selectIdx = statements.findIndex((s) => /select/i.test(s.query) && /board_climb/i.test(s.query));
      assert.ok(setLocalIdx >= 0, 'standard path must issue SET LOCAL max_parallel_workers_per_gather = 0');
      assert.ok(setLocalIdx < selectIdx, 'SET LOCAL must run before the SELECT');
      const selects = tableSelects(statements);
      const nodes = await explainNodes(selects[0].query, selects[0].params, GUARD);
      assert.equal(
        nodes.some((n) => /Gather/.test(n.type)),
        false,
        'standard path must not produce a parallel Gather under the SET LOCAL guard',
      );
    });

    void it(
      'stats-driven narrow-filter page>0 search (#3856 repro) runs SET LOCAL before the SELECT and ' +
        'avoids a parallel Gather',
      async () => {
        // Mirrors the exact production repro from Sentry BOARDSESH-AK: narrow
        // grade band (minGrade=maxGrade), onlyTallClimbs + boulders, pageSize 100,
        // page 1 (OFFSET 100). This is the shape that tipped the planner into a
        // parallel plan and exhausted /dev/shm before #3856's fix — statsDrivenSearch
        // was the one hot search path with no SET LOCAL guard.
        const repro: ClimbSearchParams = {
          page: 1,
          pageSize: 100,
          sortBy: 'ascents',
          sortOrder: 'desc',
          minGrade: 15,
          maxGrade: 15,
          onlyTallClimbs: true,
          boulders: true,
        };

        const statements = await runSearch(repro);
        const setLocalIdx = statements.findIndex((s) =>
          /SET LOCAL max_parallel_workers_per_gather\s*=\s*0/i.test(s.query),
        );
        const selectIdx = statements.findIndex((s) => /select/i.test(s.query) && /board_climb/i.test(s.query));
        assert.ok(setLocalIdx >= 0, 'stats-driven path must issue SET LOCAL max_parallel_workers_per_gather = 0');
        assert.ok(setLocalIdx < selectIdx, 'SET LOCAL must run before the SELECT');

        const selects = tableSelects(statements);
        assert.ok(selects.length >= 1, 'expected a stats-driven SELECT');

        // Control: when parallelism is available the planner CAN pick a Gather for
        // this exact query shape, so the guarded assertion below is a real gate,
        // not a vacuous pass (same control pattern as the broad-count regression
        // test below).
        const unguarded = await explainNodes(selects[0].query, selects[0].params, FORCE_PARALLEL);
        assert.equal(
          hasGatherNode(unguarded),
          true,
          `control: the #3856 repro shape must go parallel when unguarded; saw: ${unguarded.map((n) => n.type).join(', ')}`,
        );

        // statsDrivenSearch now runs this exact shape inside a transaction with
        // SET LOCAL max_parallel_workers_per_gather = 0 (mirroring standardSearch) —
        // no Gather, no per-worker DSM allocation.
        const guarded = await explainNodes(selects[0].query, selects[0].params, GUARD);
        assert.equal(
          hasGatherNode(guarded),
          false,
          'the statsDrivenSearch SET LOCAL guard must eliminate the parallel Gather that exhausted /dev/shm in #3856',
        );

        if (RUN_ANALYZE) await logTiming('stats-driven #3856 repro (guarded)', selects[0]);
      },
    );

    void it('page>0 fallback (#1971) runs SET LOCAL before its SELECT and stays serial', async () => {
      // A setter nobody has: statsDrivenSearch exhausts its stats-having set
      // immediately, so page 1 takes the fallback and we get a SECOND select —
      // the LEFT JOIN query the page-0 gate used to prevent past page 0. The only
      // invariant that matters here is that it can't allocate parallel-sort DSM
      // segments (the #1969 / #3856 failure mode). Plan shape beyond that is
      // statistics-dependent and deliberately not asserted.
      const statements = await runSearch({
        page: 1,
        pageSize: 20,
        sortBy: 'ascents',
        sortOrder: 'desc',
        settername: ['boardsesh-explain-harness-no-such-setter'],
      });
      const selects = tableSelects(statements);
      assert.equal(selects.length, 2, 'an exhausted stats-driven page past page 0 must fall back');
      assert.ok(/board_climbs/.test(selects[1].query), 'the fallback query is the unified LEFT JOIN');

      // Every SELECT must be immediately preceded by its own SET LOCAL guard.
      const kinds = statements.map((statement) =>
        /SET LOCAL max_parallel_workers_per_gather\s*=\s*0/i.test(statement.query) ? 'guard' : 'select',
      );
      assert.deepEqual(kinds, ['guard', 'select', 'guard', 'select']);

      // Smoke test only, and deliberately weak: the harness setter matches zero rows,
      // so the planner picks a trivial serial plan whatever the GUC says. The
      // statement-ordering assertion above is what actually guards #1969 / #3856.
      const nodes = await explainNodes(selects[1].query, selects[1].params, GUARD);
      assert.equal(
        hasGatherNode(nodes),
        false,
        'the fallback must not produce a parallel Gather under the SET LOCAL guard',
      );
      if (RUN_ANALYZE) await logTiming('#1971 page-1 fallback', selects[1]);
    });

    void it('random sort is deterministic per seed, reshuffles across seeds, and paginates without overlap', async () => {
      const uuidsFor = async (sortSeed: string, page = 0) =>
        (await searchClimbs(db, PARAMS, { page, pageSize: 15, sortBy: 'random', sortSeed })).climbs.map((c) => c.uuid);

      const seededA = await uuidsFor('12345');
      const seededAgain = await uuidsFor('12345');
      const ascents = (await searchClimbs(db, PARAMS, { page: 0, pageSize: 15, sortBy: 'ascents' })).climbs.map(
        (c) => c.uuid,
      );

      assert.deepEqual(seededAgain, seededA, 'same seed must produce the same order');
      assert.notDeepEqual(seededA, ascents, 'random must not match the popularity order');

      // Reshuffle across several seeds and expect a spread of distinct orders. A pair
      // of seeds could collide by chance; a whole set collapsing to <3 orders would not.
      const seeds = ['1', '7', '99', '2026', '31337'];
      const orders = new Set<string>();
      for (const seed of seeds) orders.add((await uuidsFor(seed)).join(','));
      assert.ok(orders.size >= 3, `expected ≥3 distinct orders across ${seeds.length} seeds, got ${orders.size}`);

      // md5(uuid || seed) ASC, uuid DESC keeps pages disjoint under OFFSET pagination.
      const page0 = await uuidsFor('777', 0);
      const page1 = await uuidsFor('777', 1);
      const overlap = page0.filter((uuid) => page1.includes(uuid));
      assert.equal(overlap.length, 0, 'pages 0 and 1 must not overlap for a fixed seed');
    });

    void it('count without stats filters drops the board_climb_stats LEFT JOIN (PG join elimination)', async () => {
      const { text, params } = buildCountSql({ page: 0, pageSize: 20 });
      const nodes = await explainNodes(text, params);
      assert.equal(
        nodes.some((n) => /board_climb_stats/.test(n.rel ?? '')),
        false,
        'PG should eliminate the unused stats join when no condition references stats columns',
      );
    });

    void it('count with a stats filter keeps the board_climb_stats join', async () => {
      const { text, params } = buildCountSql({ page: 0, pageSize: 20, minAscents: 50 });
      const nodes = await explainNodes(text, params);
      assert.ok(
        nodes.some((n) => /board_climb_stats/.test(n.rel ?? '')),
        'a minAscents count must still join board_climb_stats',
      );
    });

    void it('count with projectsOnly keeps the board_climb_stats join (stats column referenced in WHERE)', async () => {
      const { text, params } = buildCountSql({ page: 0, pageSize: 20, projectsOnly: true });
      const nodes = await explainNodes(text, params);
      assert.ok(
        nodes.some((n) => /board_climb_stats/.test(n.rel ?? '')),
        'projectsOnly references stats.ascensionist_count via COALESCE — join must be retained',
      );
    });

    void it('broad count goes parallel unguarded but the countClimbs SET LOCAL guard eliminates the Gather (#2378 DSM regression)', async () => {
      // set_ids: [] removes the required_set_ids GIN bitmap; minAscents keeps the
      // board_climb_stats join (PG can't eliminate it), so the planner's cheapest
      // plan is a Parallel Hash Join + Parallel Seq Scan on board_climbs — the plan
      // that allocated one /dev/shm DSM segment per worker and raised "could not
      // resize shared memory segment" in #2378.
      const { text, params } = buildCountSql({ page: 0, pageSize: 20, minAscents: 1 }, BROAD_PARAMS);

      // Control: when parallelism is available the planner DOES pick a Gather here,
      // so the guarded assertion below is a real gate, not a vacuous pass.
      const unguarded = await explainNodes(text, params, FORCE_PARALLEL);
      assert.equal(
        hasGatherNode(unguarded),
        true,
        `control: the broad count must go parallel when unguarded; saw: ${unguarded.map((n) => n.type).join(', ')}`,
      );

      // countClimbs runs this exact shape inside a transaction with
      // SET LOCAL max_parallel_workers_per_gather = 0 — no Gather, no per-worker DSM.
      const guarded = await explainNodes(text, params, GUARD);
      assert.equal(
        hasGatherNode(guarded),
        false,
        'the countClimbs SET LOCAL guard must eliminate the parallel Gather that exhausted /dev/shm in #2378',
      );
    });

    void it('closes the pool', async () => {
      await client.end();
    });
  });
}
