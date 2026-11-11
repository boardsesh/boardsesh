import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { getWorkerDatabaseName } from '../../../__tests__/worker-db';
import { createConsolidationTickHandler } from '../tick-handler';
import { buildAccountConsolidationPlan } from '../planner';
import type { ConsolidationTick } from '../planner';
import type { ConsolidationContext } from '../executor';
import { evidenceFixture, tickFixture } from './fixtures';
const adminUrl = (process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/postgres').replace(
  /\/[^/]+$/,
  '/postgres',
);
const databaseName = getWorkerDatabaseName('bs_consolidation_ticks');
let admin: postgres.Sql;
let client: postgres.Sql;
let created = false;
const migration = readFileSync(
  new URL('../../../../../db/drizzle/0306_account_consolidation.sql', import.meta.url),
  'utf8',
).replaceAll('--> statement-breakpoint', '');
function context(
  canonicalOverrides: Partial<ConsolidationTick> = {},
  sourceOverrides: Partial<ConsolidationTick> = {},
): ConsolidationContext {
  const evidence = evidenceFixture([
    { userId: 'canonical', email: 'case@example.test', ticks: 1 },
    { userId: 'source', email: 'Case@example.test', ticks: 1 },
  ]);
  const plan = buildAccountConsolidationPlan(
    evidence,
    [
      tickFixture(canonicalOverrides),
      tickFixture({
        id: '2',
        uuid: 'tick-two',
        userId: 'source',
        sessionId: 'session-two',
        auroraId: 'json-import-two',
        ...sourceOverrides,
      }),
    ],
    { evidenceSha256: 'a'.repeat(64) },
  );
  return {
    batchId: 'batch',
    mergeId: 'merge',
    survivorUserId: 'canonical',
    sourceUserIds: ['source'],
    group: plan.groups[0],
  };
}
async function apply(plan = context()) {
  const archived: Readonly<Record<string, unknown>>[] = [];
  const handler = createConsolidationTickHandler({
    archivePreimages: async (_context, preimages) => {
      archived.push(preimages);
    },
  });
  const result = await drizzle(client).transaction((transaction) => handler.apply(transaction, plan));
  return { result, archived };
}
describe('explicit consolidation tick transaction', () => {
  beforeAll(async () => {
    admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    client = postgres(adminUrl.replace(/\/[^/]+$/, `/${databaseName}`), { max: 1, onnotice: () => {} });
    await client.unsafe(`CREATE TABLE boardsesh_ticks(id bigserial PRIMARY KEY,uuid text UNIQUE NOT NULL,user_id text NOT NULL,board_type text NOT NULL,climb_uuid text NOT NULL,climb_revision integer,angle integer NOT NULL,is_mirror boolean,origin text NOT NULL,status text NOT NULL,attempt_count integer NOT NULL,quality integer,difficulty integer,is_benchmark boolean,comment text,climbed_at timestamp NOT NULL,created_at timestamp DEFAULT now(),updated_at timestamp NOT NULL,session_id text,board_id bigint,aurora_type text,aurora_id text UNIQUE,aurora_synced_at timestamp,aurora_sync_error text,kilter_type text,kilter_id text UNIQUE,kilter_synced_at timestamp,kilter_sync_error text,kilter_detached_at timestamp);
   CREATE TABLE board_sessions(id text PRIMARY KEY,anchor_tick_id bigint,origin text NOT NULL DEFAULT 'inferred');
   ALTER TABLE boardsesh_ticks ADD FOREIGN KEY(session_id) REFERENCES board_sessions(id) ON DELETE SET NULL;
   CREATE TABLE board_beta_links(tick_uuid text);
   CREATE TABLE session_workouts(tick_map jsonb);
   CREATE TABLE content_privacy(entity_type text,entity_id text,owner_id text,audience text,public_consent_revision integer,updated_at timestamp,PRIMARY KEY(entity_type,entity_id));
   CREATE TABLE comments(entity_type text,entity_id text);CREATE TABLE votes(entity_type text,entity_id text);CREATE TABLE vote_counts(entity_type text,entity_id text);CREATE TABLE feed_items(entity_type text,entity_id text);CREATE TABLE notifications(entity_type text,entity_id text);`);
    await client.unsafe(migration);
  });
  afterAll(async () => {
    await client?.end({ timeout: 1 });
    if (created) await admin.unsafe(`DROP DATABASE "${databaseName}" WITH(FORCE)`);
    await admin?.end({ timeout: 1 });
  });
  beforeEach(async () => {
    await client.unsafe(
      'TRUNCATE boardsesh_ticks,board_sessions,board_beta_links,session_workouts,content_privacy,comments,votes,vote_counts,feed_items,notifications,account_consolidation_tick_aliases,account_consolidation_import_aliases RESTART IDENTITY',
    );
    await client`INSERT INTO board_sessions(id) VALUES('session-one'),('session-two')`;
    // The earlier sessions domain has mapped the source inferred session to session-one.
    await client`INSERT INTO boardsesh_ticks(uuid,user_id,board_type,climb_uuid,angle,is_mirror,origin,status,attempt_count,quality,difficulty,is_benchmark,comment,climbed_at,updated_at,session_id,aurora_type,aurora_id,aurora_synced_at) VALUES('tick-one','canonical','tension','synthetic-climb',40,false,'json_import','send',2,3,16,false,'','2026-01-01 12:00:00.000001','2026-01-02','session-one','ascents','json-import-one','2026-01-02'),('tick-two','source','tension','synthetic-climb',40,false,'json_import','send',2,3,16,false,'','2026-01-01 12:00:00.000001','2026-01-02','session-one','ascents','json-import-two','2026-01-02')`;
  });
  it('retains canonical UUID, records exact retired import identities, and does not turn sync replay into local edits', async () => {
    const { result, archived } = await apply();
    expect(result).toMatchObject({ retired: 1, moved: 0 });
    expect(archived.length).toBeGreaterThan(0);
    expect(
      await client`SELECT uuid,user_id,session_id,updated_at=aurora_synced_at AS synchronized FROM boardsesh_ticks`,
    ).toEqual([{ uuid: 'tick-one', user_id: 'canonical', session_id: 'session-one', synchronized: true }]);
    expect(
      await client`SELECT retired_uuid,canonical_uuid,target_user_id FROM account_consolidation_tick_aliases`,
    ).toEqual([{ retired_uuid: 'tick-two', canonical_uuid: 'tick-one', target_user_id: 'canonical' }]);
    expect(
      await client`SELECT former_user_id,external_id,canonical_resource_id FROM account_consolidation_import_aliases ORDER BY former_user_id`,
    ).toEqual([
      { former_user_id: 'canonical', external_id: 'json-import-one', canonical_resource_id: 'tick-one' },
      { former_user_id: 'source', external_id: 'json-import-two', canonical_resource_id: 'tick-one' },
    ]);
  });
  it.each(['explicit', 'inferred'] as const)(
    'preserves a source-only %s session when the canonical duplicate has none',
    async (origin) => {
      await client`UPDATE board_sessions SET origin=${origin} WHERE id='session-two'`;
      await client`UPDATE boardsesh_ticks SET session_id=CASE WHEN uuid='tick-one' THEN NULL ELSE 'session-two' END`;
      const plan = context(
        { sessionId: null, sessionOrigin: null },
        { sessionId: 'session-two', sessionOrigin: origin },
      );
      expect(plan.group.blockers).toEqual([]);
      expect(plan.group.tickMerges).toHaveLength(1);
      await apply(plan);
      expect(await client`SELECT uuid,user_id,session_id FROM boardsesh_ticks`).toEqual([
        { uuid: 'tick-one', user_id: 'canonical', session_id: 'session-two' },
      ]);
      expect(await client`SELECT id,origin FROM board_sessions WHERE id='session-two'`).toEqual([
        { id: 'session-two', origin },
      ]);
    },
  );
  it('uses the repaired inferred session assignment rather than the retired ID in the preview', async () => {
    await client`UPDATE boardsesh_ticks SET session_id=NULL WHERE uuid='tick-one'`;
    const plan = context({ sessionId: null, sessionOrigin: null });
    expect(plan.group.tickMerges[0].sourceSessionIds).toEqual(['session-two']);
    await apply(plan);
    expect(await client`SELECT uuid,session_id FROM boardsesh_ticks`).toEqual([
      { uuid: 'tick-one', session_id: 'session-one' },
    ]);
  });
  it('keeps an existing canonical-only assignment', async () => {
    await client`UPDATE boardsesh_ticks SET session_id=NULL WHERE uuid='tick-two'`;
    await apply(context({}, { sessionId: null, sessionOrigin: null }));
    expect(await client`SELECT session_id FROM boardsesh_ticks`).toEqual([{ session_id: 'session-one' }]);
  });
  it('leaves a duplicate pair with no session unassigned', async () => {
    await client`UPDATE boardsesh_ticks SET session_id=NULL`;
    await apply(context({ sessionId: null, sessionOrigin: null }, { sessionId: null, sessionOrigin: null }));
    expect(await client`SELECT session_id FROM boardsesh_ticks`).toEqual([{ session_id: null }]);
  });
  it.each(['explicit', 'inferred'] as const)('rolls back distinct remaining %s session assignments', async (origin) => {
    await client`UPDATE board_sessions SET origin=${origin}`;
    await client`UPDATE boardsesh_ticks SET session_id='session-two' WHERE uuid='tick-two'`;
    await expect(apply()).rejects.toMatchObject({ code: 'UNSAFE_PLAN' });
    expect(await client`SELECT uuid,session_id FROM boardsesh_ticks ORDER BY uuid`).toEqual([
      { uuid: 'tick-one', session_id: 'session-one' },
      { uuid: 'tick-two', session_id: 'session-two' },
    ]);
    expect(await client`SELECT count(*)::integer AS count FROM account_consolidation_tick_aliases`).toEqual([
      { count: 0 },
    ]);
    if (origin === 'explicit')
      expect(context({ sessionOrigin: 'explicit' }, { sessionOrigin: 'explicit' }).group.blockers).toContain(
        'EXPLICIT_SESSION_CONFLICT',
      );
  });
  it('preserves a genuine local-edit inequality rather than marking it in sync', async () => {
    await client`UPDATE boardsesh_ticks SET updated_at='2026-01-03' WHERE uuid='tick-one'`;
    await apply();
    expect(await client`SELECT updated_at>aurora_synced_at AS locally_edited FROM boardsesh_ticks`).toEqual([
      { locally_edited: true },
    ]);
  });
  it('preserves stricter privacy added by the earlier profile handler', async () => {
    await client`INSERT INTO content_privacy VALUES('tick','tick-one','canonical','public',3,now()),('tick','tick-two','source','only_me',NULL,now())`;
    await apply();
    expect(await client`SELECT entity_id,owner_id,audience,public_consent_revision FROM content_privacy`).toEqual([
      { entity_id: 'tick-one', owner_id: 'canonical', audience: 'only_me', public_consent_revision: null },
    ]);
  });
  it('rolls back the entire tick change when a new social reference is present', async () => {
    await client`INSERT INTO comments VALUES('tick','tick-two')`;
    await expect(apply()).rejects.toMatchObject({ code: 'UNSAFE_PLAN' });
    expect(await client`SELECT count(*)::integer AS total FROM boardsesh_ticks`).toEqual([{ total: 2 }]);
    expect(await client`SELECT count(*)::integer AS total FROM account_consolidation_tick_aliases`).toEqual([
      { total: 0 },
    ]);
  });
  it('refuses an unrepaired inferred-session anchor', async () => {
    await client`INSERT INTO board_sessions(id,anchor_tick_id) VALUES('source-session',2)`;
    await expect(apply()).rejects.toMatchObject({ code: 'UNSAFE_PLAN' });
    expect(await client`SELECT count(*)::integer AS total FROM boardsesh_ticks`).toEqual([{ total: 2 }]);
  });
});
