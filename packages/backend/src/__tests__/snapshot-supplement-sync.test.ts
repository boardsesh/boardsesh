import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { rowsFromResult } from '@boardsesh/db/client';
import type { ConnectionContext, SyncCursorInput, SyncResult } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { syncQueries } from '../graphql/resolvers/sync/queries';

const VIEWER_ID = 'snapshot-supplement-viewer';
const SETTER_ID = 'snapshot-supplement-setter';
const BEFORE_SNAPSHOT = '2026-05-01T00:00:00.000Z';
const AFTER_SNAPSHOT = '2026-05-03T00:00:00.000Z';
const CHILD_TIMESTAMP = '2026-04-01T00:00:00.000Z';
const SNAPSHOT_WATERMARK = { updatedAt: '2026-05-02T00:00:00.000Z', syncSeq: '0' };
const scope = { boardType: 'kilter', layoutId: 1, sizeId: 5, limit: 500 };
const supplemental = { audience: 'SNAPSHOT_SUPPLEMENTAL' as const, snapshotClimbWatermark: SNAPSHOT_WATERMARK };

const context = {
  connectionId: 'snapshot-supplement',
  isAuthenticated: true,
  userId: VIEWER_ID,
  sessionId: null,
  controllerId: null,
  controllerApiKey: null,
} as unknown as ConnectionContext;

const pulls = [
  { name: 'climbs', resolver: syncQueries.syncClimbs, key: 'uuid' },
  { name: 'stats', resolver: syncQueries.syncClimbStats, key: 'climb_uuid' },
  { name: 'grades', resolver: syncQueries.syncClimbGrades, key: 'climb_uuid' },
] as const;

function climbKeys(page: SyncResult, key: string): string[] {
  return (page.documents as Record<string, unknown>[]).map((document) => String(document[key])).sort();
}

async function seedClimb(climb: {
  uuid: string;
  owner?: string | null;
  authored?: boolean;
  draft?: boolean | null;
  listed?: boolean;
  updatedAt?: string;
  boardType?: string;
  layoutId?: number;
  sizeId?: number;
}): Promise<void> {
  const boardType = climb.boardType ?? 'kilter';
  await db.execute(sql`
    INSERT INTO board_climbs
      (uuid, board_type, layout_id, name, user_id, is_boardsesh_authored, is_draft,
       is_listed, compatible_size_ids, updated_at)
    VALUES (${climb.uuid}, ${boardType}, ${climb.layoutId ?? 1}, ${climb.uuid}, ${climb.owner ?? null},
      ${climb.authored ?? false}, ${climb.draft === undefined ? false : climb.draft}, ${climb.listed ?? true},
      ${`{${climb.sizeId ?? 5}}`}::int[], ${climb.updatedAt ?? BEFORE_SNAPSHOT}::timestamp)
  `);
  await db.execute(sql`
    INSERT INTO board_climb_stats (board_type, climb_uuid, angle, ascensionist_count, updated_at)
    VALUES (${boardType}, ${climb.uuid}, 40, 3, ${CHILD_TIMESTAMP}::timestamp)
  `);
  await db.execute(sql`
    INSERT INTO board_climb_grades
      (board_type, climb_uuid, angle, local_grade, universal_grade, confidence, ascensionist_count,
       model_version, coeff_version, computed_at)
    VALUES (${boardType}, ${climb.uuid}, 40, 20, 20, 'low', 3, 'test', 'test', ${CHILD_TIMESTAMP}::timestamp)
  `);
}

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE board_climbs, board_climb_stats, board_climb_grades RESTART IDENTITY CASCADE`);
  await db.execute(sql`DELETE FROM content_privacy WHERE entity_type = 'climb'`);
  for (const userId of [VIEWER_ID, SETTER_ID]) {
    await db.execute(sql`INSERT INTO users (id, name, email)
      VALUES (${userId}, ${userId}, ${`${userId}@example.test`}) ON CONFLICT DO NOTHING`);
  }
  await seedClimb({ uuid: 'artifact-reference' });
  await seedClimb({ uuid: 'artifact-unlisted-reference', listed: false });
  await seedClimb({ uuid: 'artifact-null-draft-reference', draft: null });
  await seedClimb({ uuid: 'published-authored', owner: SETTER_ID, authored: true });
  await seedClimb({ uuid: 'unlisted-authored', owner: SETTER_ID, authored: true, listed: false });
  await seedClimb({ uuid: 'deleted-author', authored: true });
  await seedClimb({ uuid: 'own-draft', owner: VIEWER_ID, authored: true, draft: true });
  await seedClimb({ uuid: 'foreign-draft', owner: SETTER_ID, authored: true, draft: true });
  await seedClimb({ uuid: 'ownerless-draft', draft: true });
  await seedClimb({ uuid: 'policy-reference' });
  await db.execute(sql`INSERT INTO content_privacy (entity_type, entity_id, owner_id, audience)
    VALUES ('climb', 'policy-reference', NULL, 'only_me')`);
  // Now reference-shaped, but missing when the artifact was built. Its child
  // timestamps remain older than the imported watermarks and must still arrive.
  await seedClimb({ uuid: 'changed-reference', updatedAt: AFTER_SNAPSHOT });
  await seedClimb({ uuid: 'wrong-layout', owner: SETTER_ID, layoutId: 2 });
  await seedClimb({ uuid: 'wrong-size', owner: SETTER_ID, sizeId: 7 });
  await seedClimb({ uuid: 'wrong-board', owner: SETTER_ID, boardType: 'tension' });
});

describe.each(pulls)('snapshot supplemental $name', ({ resolver, key }) => {
  it('returns authorized artifact omissions and changed climbs without replaying reference rows', async () => {
    const page = await resolver(undefined, { ...scope, ...supplemental }, context);

    expect(climbKeys(page, key)).toEqual([
      'changed-reference',
      'deleted-author',
      'own-draft',
      'policy-reference',
      'published-authored',
      'unlisted-authored',
    ]);
    expect(page.hasMore).toBe(false);
    expect(page.documents.every((document) => !Object.hasOwn(document as object, '__seq'))).toBe(true);
  });

  it('keeps the existing ALL result when the audience is absent or explicitly ALL', async () => {
    const legacy = await resolver(undefined, scope, context);
    const explicit = await resolver(undefined, { ...scope, audience: 'ALL' }, context);

    expect(explicit).toEqual(legacy);
    expect(climbKeys(legacy, key)).toContain('artifact-reference');
    expect(climbKeys(legacy, key)).toContain('artifact-unlisted-reference');
    expect(climbKeys(legacy, key)).toContain('artifact-null-draft-reference');
    expect(climbKeys(legacy, key)).not.toContain('foreign-draft');
    expect(climbKeys(legacy, key)).not.toContain('ownerless-draft');
  });

  it('uses the climb sequence to include old child rows after an equal-timestamp watermark', async () => {
    await seedClimb({ uuid: 'reference-at-boundary', updatedAt: SNAPSHOT_WATERMARK.updatedAt });
    await seedClimb({ uuid: 'reference-after-boundary', updatedAt: SNAPSHOT_WATERMARK.updatedAt });
    const [boundary] = rowsFromResult<{ sync_seq: string }>(
      await db.execute(sql`SELECT sync_seq::text FROM board_climbs WHERE uuid = 'reference-at-boundary'`),
    );
    const page = await resolver(
      undefined,
      {
        ...scope,
        ...supplemental,
        snapshotClimbWatermark: { updatedAt: SNAPSHOT_WATERMARK.updatedAt, syncSeq: boundary.sync_seq },
      },
      context,
    );

    expect(climbKeys(page, key)).toContain('reference-after-boundary');
    expect(climbKeys(page, key)).not.toContain('reference-at-boundary');
  });

  it('paginates omissions with timestamp collisions and echoes the empty tail cursor', async () => {
    const seen: string[] = [];
    let cursor: SyncCursorInput | undefined;
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const page = await resolver(undefined, { ...scope, ...supplemental, cursor, limit: 2 }, context);
      seen.push(...climbKeys(page, key));
      if (!page.hasMore) {
        expect(page.documents).toEqual([]);
        expect(page.cursor).toEqual(cursor);
        break;
      }
      cursor = page.cursor;
    }
    expect(seen.sort()).toEqual([
      'changed-reference',
      'deleted-author',
      'own-draft',
      'policy-reference',
      'published-authored',
      'unlisted-authored',
    ]);
  });

  it('requires a complete valid snapshot watermark', async () => {
    await expect(resolver(undefined, { ...scope, audience: 'SNAPSHOT_SUPPLEMENTAL' }, context)).rejects.toThrow(
      'Invalid snapshotClimbWatermark',
    );
    for (const snapshotClimbWatermark of [
      {},
      { updatedAt: SNAPSHOT_WATERMARK.updatedAt },
      { updatedAt: 'invalid', syncSeq: '0' },
      { updatedAt: SNAPSHOT_WATERMARK.updatedAt, syncSeq: '9223372036854775808' },
    ]) {
      await expect(resolver(undefined, { ...scope, ...supplemental, snapshotClimbWatermark }, context)).rejects.toThrow(
        'Invalid snapshotClimbWatermark',
      );
    }
  });

  it('ignores the size filter for MoonBoard while keeping the layout boundary', async () => {
    await seedClimb({ uuid: 'moon-supplement', boardType: 'moonboard', owner: SETTER_ID, sizeId: 7 });
    await seedClimb({ uuid: 'moon-other-layout', boardType: 'moonboard', owner: SETTER_ID, layoutId: 2 });
    const page = await resolver(undefined, { ...scope, ...supplemental, boardType: 'moonboard' }, context);
    expect(climbKeys(page, key)).toEqual(['moon-supplement']);
  });

  it('still requires authentication', async () => {
    await expect(
      resolver(undefined, { ...scope, ...supplemental }, { ...context, isAuthenticated: false, userId: undefined }),
    ).rejects.toThrow();
  });
});

type ExplainNode = {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  Plans?: ExplainNode[];
};

function explainNodes(node: ExplainNode): ExplainNode[] {
  return [node, ...(node.Plans ?? []).flatMap(explainNodes)];
}

describe.each([
  { name: 'stats', resolver: syncQueries.syncClimbStats, table: 'board_climb_stats' },
  { name: 'grades', resolver: syncQueries.syncClimbGrades, table: 'board_climb_grades' },
])('sparse supplemental $name performance', ({ resolver, table }) => {
  it('uses child-key index lookups beside a 20,000-climb reference catalogue', async () => {
    await db.execute(sql`
      INSERT INTO board_climbs
        (uuid, board_type, layout_id, name, is_boardsesh_authored, is_draft, is_listed,
         compatible_size_ids, updated_at)
      SELECT 'plan-reference-' || reference_id, 'kilter', 1, 'Reference', false, false, true,
        '{5}'::int[], ${BEFORE_SNAPSHOT}::timestamp
      FROM generate_series(1, 20000) reference_id
    `);
    await db.execute(sql`
      INSERT INTO board_climb_stats (board_type, climb_uuid, angle, ascensionist_count, updated_at)
      SELECT board_type, uuid, 40, 3, ${CHILD_TIMESTAMP}::timestamp
      FROM board_climbs WHERE uuid LIKE 'plan-reference-%'
    `);
    await db.execute(sql`
      INSERT INTO board_climb_grades
        (board_type, climb_uuid, angle, local_grade, universal_grade, confidence, ascensionist_count,
         model_version, coeff_version, computed_at)
      SELECT board_type, uuid, 40, 20, 20, 'low', 3, 'test', 'test', ${CHILD_TIMESTAMP}::timestamp
      FROM board_climbs WHERE uuid LIKE 'plan-reference-%'
    `);
    await db.execute(sql`ANALYZE board_climbs`);
    await db.execute(sql`ANALYZE board_climb_stats`);
    await db.execute(sql`ANALYZE board_climb_grades`);
    await db.execute(sql`ANALYZE content_privacy`);

    // Capture the actual resolver SELECT, including the FA projection and all
    // bound parameters, so EXPLAIN cannot drift into a simpler copied query.
    let snapshotStatement: SQL | undefined;
    const dialect = new PgDialect();
    const originalTransaction = db.transaction.bind(db);
    const transactionSpy = vi.spyOn(db, 'transaction').mockImplementation((callback, configuration) =>
      originalTransaction(async (transactionDb) => {
        const originalExecute = transactionDb.execute.bind(transactionDb);
        vi.spyOn(transactionDb, 'execute').mockImplementation((statement) => {
          const query = typeof statement === 'string' ? sql.raw(statement) : statement.getSQL();
          if (dialect.sqlToQuery(query).sql.includes('WITH snapshot_candidates AS MATERIALIZED')) {
            snapshotStatement = query;
          }
          return originalExecute(statement);
        });
        return callback(transactionDb);
      }, configuration),
    );
    try {
      const page = await resolver(undefined, { ...scope, ...supplemental }, context);
      expect(page.documents).toHaveLength(6);
    } finally {
      transactionSpy.mockRestore();
    }
    if (!snapshotStatement) throw new Error('The resolver did not execute a supplemental query');

    const explained = rowsFromResult<{
      'QUERY PLAN': { Plan: ExplainNode; 'Execution Time': number }[];
    }>(
      await originalTransaction(async (transactionDb) => {
        await transactionDb.execute(sql`SET LOCAL max_parallel_workers_per_gather = 0`);
        return transactionDb.execute(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${snapshotStatement}`);
      }),
    );
    const explanation = explained[0]['QUERY PLAN'][0];
    const childNodes = explainNodes(explanation.Plan).filter((node) => node['Relation Name'] === table);
    expect(childNodes.some((node) => node['Node Type'] === 'Seq Scan')).toBe(false);
    expect(childNodes.some((node) => node['Index Cond']?.includes('climb_uuid = snapshot_candidates.uuid'))).toBe(true);
    expect(
      childNodes.reduce((rowCount, node) => rowCount + (node['Actual Rows'] ?? 0) * (node['Actual Loops'] ?? 0), 0),
    ).toBeLessThan(100);
    console.info('[snapshot-supplement-plan]', {
      table,
      referenceClimbs: 20_000,
      executionMs: explanation['Execution Time'],
      childAccess: childNodes.map((node) => ({
        type: node['Node Type'],
        index: node['Index Name'],
        condition: node['Index Cond'],
        rows: node['Actual Rows'],
        loops: node['Actual Loops'],
      })),
    });
  });
});
