// Plan tests for the per-board sync streams (#6306).
//
// `PROTECTED` is a caller's own drafts and unlisted climbs: a handful of rows
// beside the hundreds of thousands of public climbs on a large board. Its
// cursor does not follow the table (an empty page echoes the cursor it was
// given), so every pull asks from wherever the caller's last own row was. That
// is only cheap if Postgres starts from the caller's rows, through the owner
// index, and for stats and grades probes the reference table once per climb
// rather than walking its cursor index.
//
// The pull with no audience and `REFERENCE` are the opposite: nearly every row
// matches, so they walk the board's cursor index and stop at the page size.
// What they must not do any more is look anything up per row: the rule reads
// two flags and the owner, all on the row itself.
//
// So these tests read the plans of the statements the resolvers really send.
// The statements are recorded off the live database handle, then explained
// with the parameters they ran with, under the same serial-plan guard.
//
// What this does not prove: the test database is small (about 7,000 climbs) and
// is not production's Postgres version. The join ORDER of the PROTECTED pages
// is forced by the query text and holds anywhere. Which index each side picks
// is a cost decision that production's statistics could make differently, so
// it needs one EXPLAIN there too.

import { beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { sql, type SQL } from 'drizzle-orm';
import { rowsFromResult } from '@boardsesh/db/client';
import { withSerialPlan } from '@boardsesh/db/queries';
import { db } from '../db/client';
import { syncQueries } from '../graphql/resolvers/sync/queries';
import { audienceContext } from './helpers/sync-audience-fixture';

const VIEWER_ID = 'sync-plan-viewer';
const OTHER_ID = 'sync-plan-other';
const BOARD_TYPE = 'kilter';
const LAYOUT_ID = 1;
const SIZE_ID = 5;
/** `(user_id, board_type) WHERE user_id IS NOT NULL`, migration 0247. */
const OWNER_INDEX = 'board_climbs_user_export_idx';
const CLIMBS_CURSOR_INDEX = 'board_climbs_sync_cursor_idx';

// 7,000 public climbs, a seventh of them on another layout. The viewer owns 40
// climbs that are not public (drafts and unlisted, half each) and 30 that are;
// another account owns 200 that are not public.
const PUBLIC_CLIMBS = 7_000;
const OWN_NON_PUBLIC_CLIMBS = 40;
const OWN_PUBLIC_CLIMBS = 30;
const OTHER_NON_PUBLIC_CLIMBS = 200;
// Every fourth of the viewer's non-public climbs has a second angle.
const OWN_REFERENCE_ROWS = OWN_NON_PUBLIC_CLIMBS + OWN_NON_PUBLIC_CLIMBS / 4;

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

const scopeArgs = { boardType: BOARD_TYPE, layoutId: LAYOUT_ID, sizeId: SIZE_ID, cursor: null, limit: 500 } as const;
const protectedArgs = { ...scopeArgs, audience: 'PROTECTED' } as const;

beforeAll(async () => {
  await db.execute(sql`TRUNCATE TABLE board_climbs, board_climb_stats, board_climb_grades RESTART IDENTITY CASCADE`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${VIEWER_ID}, ${OTHER_ID})`);
  await db.execute(sql`
    INSERT INTO users (id, name, email) VALUES
      (${VIEWER_ID}, 'Plan viewer', 'sync-plan-viewer@example.test'),
      (${OTHER_ID}, 'Plan other', 'sync-plan-other@example.test')
  `);

  // The public climbs, spread over two layouts and in cursor order.
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, name, is_listed, is_draft, compatible_size_ids, updated_at)
    SELECT 'plan-pub-' || climb_number, ${BOARD_TYPE}, CASE WHEN climb_number % 7 = 0 THEN 2 ELSE ${LAYOUT_ID} END,
           'Public climb', true, false, ARRAY[${SIZE_ID}]::int[],
           timestamp '2026-01-01' + climb_number * interval '1 minute'
    FROM generate_series(1, ${PUBLIC_CLIMBS}) AS climb_number
  `);
  // The viewer's own climbs, scattered through the same time range so no cursor
  // position finds them bunched together: drafts, unlisted climbs, and published
  // ones, which are public and so not part of the protected stream.
  await db.execute(sql`
    INSERT INTO board_climbs
      (uuid, board_type, layout_id, name, is_listed, is_draft, compatible_size_ids, user_id, updated_at)
    SELECT 'plan-own-' || climb_number, ${BOARD_TYPE}, ${LAYOUT_ID}, 'Own climb',
           false, climb_number % 2 = 0, ARRAY[${SIZE_ID}]::int[], ${VIEWER_ID},
           timestamp '2026-01-01' + climb_number * interval '150 minutes'
    FROM generate_series(1, ${OWN_NON_PUBLIC_CLIMBS}) AS climb_number
  `);
  await db.execute(sql`
    INSERT INTO board_climbs
      (uuid, board_type, layout_id, name, is_listed, is_draft, compatible_size_ids, user_id, updated_at)
    SELECT 'plan-own-pub-' || climb_number, ${BOARD_TYPE}, ${LAYOUT_ID}, 'Own published climb',
           true, false, ARRAY[${SIZE_ID}]::int[], ${VIEWER_ID},
           timestamp '2026-01-01' + climb_number * interval '170 minutes'
    FROM generate_series(1, ${OWN_PUBLIC_CLIMBS}) AS climb_number
  `);
  // Somebody else's drafts and unlisted climbs: on the board, and nobody's but theirs.
  await db.execute(sql`
    INSERT INTO board_climbs
      (uuid, board_type, layout_id, name, is_listed, is_draft, compatible_size_ids, user_id, updated_at)
    SELECT 'plan-other-' || climb_number, ${BOARD_TYPE}, ${LAYOUT_ID}, 'Other climb',
           false, climb_number % 2 = 0, ARRAY[${SIZE_ID}]::int[], ${OTHER_ID},
           timestamp '2026-01-01' + climb_number * interval '30 minutes'
    FROM generate_series(1, ${OTHER_NON_PUBLIC_CLIMBS}) AS climb_number
  `);
  await db.execute(sql`
    INSERT INTO board_climb_stats (board_type, climb_uuid, angle, ascensionist_count, updated_at)
    SELECT board_type, uuid, 40, 1, updated_at + interval '1 hour' FROM board_climbs
  `);
  await db.execute(sql`
    INSERT INTO board_climb_stats (board_type, climb_uuid, angle, ascensionist_count, updated_at)
    SELECT board_type, uuid, 45, 1, updated_at + interval '2 hours' FROM board_climbs
    WHERE right(uuid, 1) IN ('0', '3', '6', '9') AND uuid LIKE 'plan-pub-%'
       OR uuid ~ '^plan-own-[0-9]+$' AND substring(uuid FROM 10)::int % 4 = 0
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

/** Tables a per-row privacy lookup would touch. No sync page may read any of them. */
const PRIVACY_TABLES = ['content_privacy', 'users', 'user_profiles', 'user_follows', 'boardsesh_ticks'];
const relationsOf = (plan: PlanNode): string[] => [
  ...new Set(flatten(plan).flatMap((node) => (node['Relation Name'] ? [node['Relation Name']] : []))),
];

describe('PROTECTED syncClimbs', () => {
  // 500 is the page size clients send. 1 and 5 are where `ORDER BY … LIMIT`
  // gives the planner the most reason to walk the board's cursor index instead.
  it.each([500, 5, 1])(
    'finds the caller’s own climbs through the owner index, and never walks the board, at a limit of %i',
    async (limit) => {
      const statements = await recordStatements(() =>
        syncQueries.syncClimbs(undefined, { ...protectedArgs, limit }, audienceContext(VIEWER_ID)),
      );
      expect(statements).toHaveLength(1);

      const plan = await explain(statements[0]);
      // No sequential scan and no walk of the board-wide cursor index: the
      // public climbs are never visited to find the caller's own among them.
      expect(accessPathsOf(plan, 'board_climbs')).toEqual([OWNER_INDEX]);
      expect(relationsOf(plan)).toEqual(['board_climbs']);
      // The index hands over the caller's climbs on the board, public ones
      // included, and the filter keeps the ones that are not public.
      const [ownClimbsScan] = scansOf(plan, 'board_climbs');
      expect(ownClimbsScan['Actual Rows']).toBe(OWN_NON_PUBLIC_CLIMBS);
      expect(plan['Actual Rows']).toBe(Math.min(limit, OWN_NON_PUBLIC_CLIMBS));
    },
  );

  it('returns nothing, as cheaply, for a caller who owns nothing', async () => {
    const statements = await recordStatements(() =>
      syncQueries.syncClimbs(undefined, protectedArgs, audienceContext('sync-plan-nobody')),
    );
    const plan = await explain(statements[0]);
    expect(accessPathsOf(plan, 'board_climbs')).toEqual([OWNER_INDEX]);
    expect(plan['Actual Rows']).toBe(0);
  });
});

describe.each([
  { resolver: 'syncClimbStats', table: 'board_climb_stats', cursorIndex: 'board_climb_stats_sync_cursor_idx' },
  { resolver: 'syncClimbGrades', table: 'board_climb_grades', cursorIndex: 'board_climb_grades_sync_cursor_idx' },
] as const)('PROTECTED $resolver', ({ resolver, table, cursorIndex }) => {
  it.each([500, 5, 1])(
    'starts from the caller’s own climbs and probes the reference table by primary key at a limit of %i',
    async (limit) => {
      const primaryKeyIndex = await primaryKeyIndexOf(table);
      const statements = await recordStatements(() =>
        syncQueries[resolver](undefined, { ...protectedArgs, limit }, audienceContext(VIEWER_ID)),
      );
      // The serial-plan guard, then the page. Nothing is counted first.
      expect(statements).toHaveLength(2);
      const plan = await explain(statements[1]);

      // Climbs outside, reference rows inside: the nested loop's outer child
      // holds the board_climbs scan and its inner child the reference-table probe.
      const nestedLoop = flatten(plan).find((node) => node['Node Type'] === 'Nested Loop');
      if (!nestedLoop?.Plans) throw new Error('expected a nested loop with two children');
      const [outer, inner] = nestedLoop.Plans;
      expect(accessPathsOf(outer, 'board_climbs')).toEqual([OWNER_INDEX]);
      expect(scansOf(outer, table)).toEqual([]);
      expect(accessPathsOf(inner, table)).toEqual([primaryKeyIndex]);

      // Nothing anywhere in the plan walks the reference table or the board:
      // no cursor index, no sequential scan.
      expect(accessPathsOf(plan, table)).toEqual([primaryKeyIndex]);
      expect(accessPathsOf(plan, table)).not.toContain(cursorIndex);
      expect(accessPathsOf(plan, 'board_climbs')).toEqual([OWNER_INDEX]);

      // The work is sized by the caller's own climbs, not by the board: one
      // probe per climb, and only their rows reach the sort.
      expect(scansOf(outer, 'board_climbs')[0]['Actual Rows']).toBe(OWN_NON_PUBLIC_CLIMBS);
      expect(scansOf(inner, table)[0]['Actual Loops']).toBe(OWN_NON_PUBLIC_CLIMBS);
      expect(nestedLoop['Actual Rows']).toBe(OWN_REFERENCE_ROWS);
      expect(plan['Actual Rows']).toBe(Math.min(limit, OWN_REFERENCE_ROWS));
    },
  );

  it('returns exactly the rows of the caller’s own non-public climbs', async () => {
    const page = await syncQueries[resolver](undefined, protectedArgs, audienceContext(VIEWER_ID));
    const climbs = (page.documents as Array<{ climb_uuid: string }>).map((document) => document.climb_uuid);
    expect(climbs).toHaveLength(OWN_REFERENCE_ROWS);
    expect(climbs.every((uuid) => /^plan-own-\d+$/.test(uuid))).toBe(true);
  });
});

describe.each([
  ['with no audience', undefined],
  ['REFERENCE', 'REFERENCE'],
] as const)('syncClimbs %s', (_label, audience) => {
  it('walks the board’s cursor index, stops at the page, and looks nothing up per row', async () => {
    const statements = await recordStatements(() =>
      syncQueries.syncClimbs(
        undefined,
        audience === undefined ? scopeArgs : { ...scopeArgs, audience },
        audienceContext(VIEWER_ID),
      ),
    );
    expect(statements).toHaveLength(1);

    const plan = await explain(statements[0]);
    expect(accessPathsOf(plan, 'board_climbs')).toEqual([CLIMBS_CURSOR_INDEX]);
    // The rule is two flags and the owner, all on the row: no privacy table, no
    // account, no follow and no tick is read to decide a climb.
    expect(relationsOf(plan)).toEqual(['board_climbs']);
    for (const privacyTable of PRIVACY_TABLES) expect(relationsOf(plan)).not.toContain(privacyTable);
    expect(plan['Actual Rows']).toBe(500);
    // An ordered walk that ends at the limit: no sort of the whole board.
    expect(flatten(plan).map((node) => node['Node Type'])).not.toContain('Sort');
  });
});

describe.each([
  { resolver: 'syncClimbStats', table: 'board_climb_stats' },
  { resolver: 'syncClimbGrades', table: 'board_climb_grades' },
] as const)('$resolver with no audience and REFERENCE', ({ resolver, table }) => {
  it.each([undefined, 'REFERENCE'] as const)(
    'reads only its own table and board_climbs (audience: %s)',
    async (audience) => {
      const statements = await recordStatements(() =>
        syncQueries[resolver](
          undefined,
          audience === undefined ? scopeArgs : { ...scopeArgs, audience },
          audienceContext(VIEWER_ID),
        ),
      );
      const plan = await explain(statements[1]);
      expect(relationsOf(plan).sort()).toEqual(['board_climbs', table].sort());
      expect(plan['Actual Rows']).toBe(500);
      // Every look at board_climbs is a primary-key probe for one row of the
      // page: the scope check, and on a stats page the first-ascent rule. A
      // sequential scan here would be the whole climbs table read to serve one
      // page, which is what a hashed subplan does.
      expect(new Set(accessPathsOf(plan, 'board_climbs'))).toEqual(new Set(['board_climbs_pkey']));
      expect(flatten(plan).map((node) => node['Node Type'])).not.toContain('Seq Scan');
    },
  );
});
