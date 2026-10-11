// Plan tests for the PROTECTED sync stream (#6306).
//
// The stream exists so a phone can replay its protected rows after every
// privacy event without walking a board's catalogue: a few thousand climbs
// beside ~387,000 on the largest layout. That only holds if Postgres reaches
// them through `board_climbs_protected_sync_idx` and, for stats and grades,
// starts from those climbs rather than from the reference table's cursor index.
// Given the plain join, the production standby walked the cursor index instead:
// 425,172 stats rows visited to return 252.
//
// So these tests read the plans of the statements the resolvers really send.
// The statements are recorded off the live database handle, then explained
// with the parameters they ran with, under the same serial-plan guard.
//
// What this does not prove: the test database is small (about 7,000 climbs) and
// is not production's Postgres version. The join ORDER for stats and grades is
// forced by the query text and holds anywhere. Which index each side picks is a
// cost decision that production's statistics could make differently, so it
// needs one EXPLAIN there too.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { sql, type SQL } from 'drizzle-orm';
import { rowsFromResult } from '@boardsesh/db/client';
import { withSerialPlan } from '@boardsesh/db/queries';
import { db } from '../db/client';
import { syncQueries } from '../graphql/resolvers/sync/queries';
import { audienceContext } from './helpers/sync-audience-fixture';

const AUTHOR_ID = 'sync-plan-author';
const VIEWER_ID = 'sync-plan-viewer';
const BOARD_TYPE = 'kilter';
const LAYOUT_ID = 1;
const SIZE_ID = 5;
const PROTECTED_INDEX = 'board_climbs_protected_sync_idx';

// 60 protected climbs beside 6,000 catalogue climbs on the layout: one in a
// hundred, close to production's 3,366 in 387,101.
const CATALOGUE_CLIMBS = 7_000;
const PROTECTED_CLIMBS = 60;
// Every third protected climb has a second angle.
const PROTECTED_REFERENCE_ROWS = PROTECTED_CLIMBS + PROTECTED_CLIMBS / 3;

type PlanNode = {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  Plans?: PlanNode[];
};

const flatten = (plan: PlanNode): PlanNode[] => [plan, ...(plan.Plans ?? []).flatMap(flatten)];
const scansOf = (plan: PlanNode, relation: string): PlanNode[] =>
  flatten(plan).filter((node) => node['Relation Name'] === relation);

/**
 * How each scan of `relation` reaches its rows: the index it reads, or the node
 * type when it reads none. A bitmap heap scan names its index on a child node,
 * so that is followed too — which form the planner picks is not what is pinned.
 */
const accessPathsOf = (plan: PlanNode, relation: string): string[] =>
  scansOf(plan, relation).flatMap((scan) => {
    if (scan['Index Name']) return [scan['Index Name']];
    const bitmapIndexes = flatten(scan).flatMap((node) => (node['Index Name'] ? [node['Index Name']] : []));
    return bitmapIndexes.length > 0 ? bitmapIndexes : [scan['Node Type']];
  });

type TransactionCallback = Parameters<typeof db.transaction>[0];
type TransactionHandle = Parameters<TransactionCallback>[0];

/**
 * Run a resolver against the real database and return every statement it sent,
 * in order: the top-level ones and the ones inside its transaction.
 */
async function recordStatements(run: () => Promise<unknown>): Promise<SQL[]> {
  const statements: SQL[] = [];
  const realExecute = db.execute.bind(db);
  const realTransaction = db.transaction.bind(db);

  vi.spyOn(db, 'execute').mockImplementation(((statement: SQL) => {
    statements.push(statement);
    return realExecute(statement);
  }) as unknown as typeof db.execute);
  vi.spyOn(db, 'transaction').mockImplementation(((callback: TransactionCallback) =>
    realTransaction((transaction: TransactionHandle) => {
      const transactionExecute = transaction.execute.bind(transaction);
      vi.spyOn(transaction, 'execute').mockImplementation(((statement: SQL) => {
        statements.push(statement);
        return transactionExecute(statement);
      }) as unknown as typeof transaction.execute);
      return callback(transaction);
    })) as unknown as typeof db.transaction);

  try {
    await run();
  } finally {
    vi.restoreAllMocks();
  }
  return statements;
}

async function explain(statement: SQL): Promise<PlanNode> {
  const explained = await withSerialPlan(db, (transaction) =>
    transaction.execute(sql`EXPLAIN (ANALYZE, FORMAT JSON) ${statement}`),
  );
  return rowsFromResult<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(explained)[0]['QUERY PLAN'][0].Plan;
}

async function primaryKeyIndexOf(table: string): Promise<string> {
  const rows = rowsFromResult<{ index_name: string }>(
    await db.execute(sql`
      SELECT indexrelid::regclass::text AS index_name
      FROM pg_index WHERE indrelid = ${table}::regclass AND indisprimary
    `),
  );
  return rows[0].index_name;
}

const protectedArgs = {
  boardType: BOARD_TYPE,
  layoutId: LAYOUT_ID,
  sizeId: SIZE_ID,
  audience: 'PROTECTED',
  cursor: null,
  limit: 500,
} as const;

beforeAll(async () => {
  await db.execute(sql`TRUNCATE TABLE board_climbs, board_climb_stats, board_climb_grades RESTART IDENTITY CASCADE`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${AUTHOR_ID}, ${VIEWER_ID})`);
  await db.execute(sql`
    INSERT INTO users (id, name, email) VALUES
      (${AUTHOR_ID}, 'Plan author', 'sync-plan-author@example.test'),
      (${VIEWER_ID}, 'Plan viewer', 'sync-plan-viewer@example.test')
  `);

  // The catalogue, spread over two layouts and in cursor order.
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, name, is_listed, is_draft, compatible_size_ids, updated_at)
    SELECT 'plan-ref-' || climb_number, ${BOARD_TYPE}, CASE WHEN climb_number % 7 = 0 THEN 2 ELSE ${LAYOUT_ID} END,
           'Catalogue climb', true, false, ARRAY[${SIZE_ID}]::int[],
           timestamp '2026-01-01' + climb_number * interval '1 minute'
    FROM generate_series(1, ${CATALOGUE_CLIMBS}) AS climb_number
  `);
  // The protected climbs, scattered through the same time range so no cursor
  // position finds them bunched together.
  await db.execute(sql`
    INSERT INTO board_climbs
      (uuid, board_type, layout_id, name, is_listed, is_draft, compatible_size_ids, user_id, updated_at)
    SELECT 'plan-own-' || climb_number, ${BOARD_TYPE}, ${LAYOUT_ID}, 'Authored climb', true, false,
           ARRAY[${SIZE_ID}]::int[], ${AUTHOR_ID},
           timestamp '2026-01-01' + climb_number * interval '100 minutes'
    FROM generate_series(1, ${PROTECTED_CLIMBS}) AS climb_number
  `);
  await db.execute(sql`
    INSERT INTO board_climb_stats (board_type, climb_uuid, angle, ascensionist_count, updated_at)
    SELECT board_type, uuid, 40, 1, updated_at + interval '1 hour' FROM board_climbs
  `);
  await db.execute(sql`
    INSERT INTO board_climb_stats (board_type, climb_uuid, angle, ascensionist_count, updated_at)
    SELECT board_type, uuid, 45, 1, updated_at + interval '2 hours' FROM board_climbs
    WHERE right(uuid, 1) IN ('0', '3', '6', '9') AND uuid NOT LIKE 'plan-own-%'
       OR uuid LIKE 'plan-own-%' AND substring(uuid FROM 10)::int % 3 = 0
  `);
  await db.execute(sql`
    INSERT INTO board_climb_grades
      (board_type, climb_uuid, angle, local_grade, confidence, model_version, coeff_version, computed_at)
    SELECT board_type, climb_uuid, angle, 20, 'confirmed', 'plan-model', 'plan-coeff', updated_at
    FROM board_climb_stats
  `);
  // The planner picks an index on statistics, and a freshly loaded table has none.
  await db.execute(sql`ANALYZE board_climbs`);
  await db.execute(sql`ANALYZE board_climb_stats`);
  await db.execute(sql`ANALYZE board_climb_grades`);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('PROTECTED syncClimbs', () => {
  it('reads board_climbs through the partial index and nothing else', async () => {
    const statements = await recordStatements(() =>
      syncQueries.syncClimbs(undefined, protectedArgs, audienceContext(VIEWER_ID)),
    );
    expect(statements).toHaveLength(1);

    const plan = await explain(statements[0]);
    // No sequential scan and no walk of the board-wide cursor index: the
    // catalogue is never visited to find the protected rows in it.
    expect(accessPathsOf(plan, 'board_climbs')).toEqual([PROTECTED_INDEX]);
    expect(plan['Actual Rows']).toBe(PROTECTED_CLIMBS);
  });
});

describe.each([
  { resolver: 'syncClimbStats', table: 'board_climb_stats', cursorIndex: 'board_climb_stats_sync_cursor_idx' },
  { resolver: 'syncClimbGrades', table: 'board_climb_grades', cursorIndex: 'board_climb_grades_sync_cursor_idx' },
] as const)('PROTECTED $resolver', ({ resolver, table, cursorIndex }) => {
  it('counts candidates through the partial index', async () => {
    const statements = await recordStatements(() =>
      syncQueries[resolver](undefined, protectedArgs, audienceContext(VIEWER_ID)),
    );
    // The guard, the capped count, the page.
    expect(statements).toHaveLength(3);

    const countPlan = await explain(statements[1]);
    expect(accessPathsOf(countPlan, 'board_climbs')).toEqual([PROTECTED_INDEX]);
  });

  // 500 is the page size clients send. 1 and 5 are where `ORDER BY … LIMIT`
  // gives the planner the most reason to walk the cursor index instead: with
  // this fixture, on Postgres 15 (2026-10-11), the unfenced EXISTS form did
  // exactly that at both, which is the production misplan in miniature. That
  // is not asserted, because another Postgres version may plan it differently.
  // What is asserted is that the fenced form has no such choice to make.
  it.each([500, 5, 1])(
    'starts from the protected climbs and probes the reference table by primary key at a limit of %i',
    async (limit) => {
      const primaryKeyIndex = await primaryKeyIndexOf(table);
      const statements = await recordStatements(() =>
        syncQueries[resolver](undefined, { ...protectedArgs, limit }, audienceContext(VIEWER_ID)),
      );
      const plan = await explain(statements[2]);

      // Climbs outside, reference rows inside: the nested loop's outer child
      // holds the board_climbs scan and its inner child the reference-table probe.
      const nestedLoop = flatten(plan).find((node) => node['Node Type'] === 'Nested Loop');
      if (!nestedLoop?.Plans) throw new Error('expected a nested loop with two children');
      const [outer, inner] = nestedLoop.Plans;
      expect(accessPathsOf(outer, 'board_climbs')).toEqual([PROTECTED_INDEX]);
      expect(scansOf(outer, table)).toEqual([]);
      expect(accessPathsOf(inner, table)).toEqual([primaryKeyIndex]);

      // Nothing anywhere in the plan walks the reference table or the
      // catalogue: no cursor index, no sequential scan.
      expect(accessPathsOf(plan, table)).toEqual([primaryKeyIndex]);
      expect(accessPathsOf(plan, table)).not.toContain(cursorIndex);
      expect(accessPathsOf(plan, 'board_climbs')).toEqual([PROTECTED_INDEX]);

      // The work is sized by the protected climbs, not by the catalogue: one
      // probe per climb, and only their rows reach the sort.
      expect(scansOf(outer, 'board_climbs')[0]['Actual Rows']).toBe(PROTECTED_CLIMBS);
      expect(scansOf(inner, table)[0]['Actual Loops']).toBe(PROTECTED_CLIMBS);
      expect(nestedLoop['Actual Rows']).toBe(PROTECTED_REFERENCE_ROWS);
      expect(plan['Actual Rows']).toBe(Math.min(limit, PROTECTED_REFERENCE_ROWS));
    },
  );

  it('returns the same rows as the cursor-order walk it replaces', async () => {
    const drivenPage = await syncQueries[resolver](undefined, protectedArgs, audienceContext(VIEWER_ID));
    vi.stubEnv('SYNC_PROTECTED_JOIN_MAX_CLIMBS', '0');
    const walkedPage = await syncQueries[resolver](undefined, protectedArgs, audienceContext(VIEWER_ID));

    expect(drivenPage.documents).toHaveLength(PROTECTED_REFERENCE_ROWS);
    expect(walkedPage).toEqual(drivenPage);
  });
});
