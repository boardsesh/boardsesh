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
 *   cd packages/db && EXPLAIN_DB_URL=postgres://postgres:password@<host>:5432/main bun run test:explain
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

  async function explainNodes(query: string, params: unknown[], standard: boolean): Promise<PlanNode[]> {
    let rows: postgres.RowList<Record<string, unknown>[]>;
    if (standard) {
      // Mirror the runtime planner settings of standardSearch's transaction.
      rows = await client.begin(async (tx) => {
        await tx.unsafe('SET LOCAL max_parallel_workers_per_gather = 0');
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
  function buildCountSql(searchParams: ClimbSearchParams): { text: string; params: unknown[] } {
    const filters = createClimbFilters(PARAMS, searchParams, undefined);
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
      const nodes = await explainNodes(selects[0].query, selects[0].params, false);
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
      const nodes = await explainNodes(selects[0].query, selects[0].params, false);
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
      const nodes = await explainNodes(selects[0].query, selects[0].params, false);
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
      const nodes = await explainNodes(selects[0].query, selects[0].params, true);
      assert.equal(
        nodes.some((n) => /Gather/.test(n.type)),
        false,
        'standard path must not produce a parallel Gather under the SET LOCAL guard',
      );
    });

    void it('count without stats filters drops the board_climb_stats LEFT JOIN (PG join elimination)', async () => {
      const { text, params } = buildCountSql({ page: 0, pageSize: 20 });
      const nodes = await explainNodes(text, params, false);
      assert.equal(
        nodes.some((n) => /board_climb_stats/.test(n.rel ?? '')),
        false,
        'PG should eliminate the unused stats join when no condition references stats columns',
      );
    });

    void it('count with a stats filter keeps the board_climb_stats join', async () => {
      const { text, params } = buildCountSql({ page: 0, pageSize: 20, minAscents: 50 });
      const nodes = await explainNodes(text, params, false);
      assert.ok(
        nodes.some((n) => /board_climb_stats/.test(n.rel ?? '')),
        'a minAscents count must still join board_climb_stats',
      );
    });

    void it('count with projectsOnly keeps the board_climb_stats join (stats column referenced in WHERE)', async () => {
      const { text, params } = buildCountSql({ page: 0, pageSize: 20, projectsOnly: true });
      const nodes = await explainNodes(text, params, false);
      assert.ok(
        nodes.some((n) => /board_climb_stats/.test(n.rel ?? '')),
        'projectsOnly references stats.ascensionist_count via COALESCE — join must be retained',
      );
    });

    void it('closes the pool', async () => {
      await client.end();
    });
  });
}
