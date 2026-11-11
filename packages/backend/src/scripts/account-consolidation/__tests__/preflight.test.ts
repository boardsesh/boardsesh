import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { getWorkerDatabaseName } from '../../../__tests__/worker-db';
import { buildAccountConsolidationPlan, consolidationDigest } from '../planner';
import { captureConsolidationGroupState, preflightConsolidationGroups, type ConsolidationGroupState } from '../state';
import { evidenceFixture } from './fixtures';

const adminUrl = (process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/postgres').replace(
  /\/[^/]+$/,
  '/postgres',
);
const databaseName = getWorkerDatabaseName('bs_consolidation_preflight');
let admin: postgres.Sql;
let client: postgres.Sql;
let created = false;
async function groups(count = 2) {
  const pairs = [
    [
      { userId: 'a', email: 'first@example.test' },
      { userId: 'b', email: 'First@example.test' },
    ],
    [
      { userId: 'c', email: 'second@example.test' },
      { userId: 'd', email: 'Second@example.test' },
    ],
    [
      { userId: 'e', email: 'third@example.test' },
      { userId: 'f', email: 'Third@example.test' },
    ],
  ].slice(0, count);
  const states = new Map<string, ConsolidationGroupState>();
  for (const pair of pairs)
    states.set(
      pair[0].email,
      await drizzle(client).transaction((transaction) =>
        captureConsolidationGroupState(
          transaction,
          pair.map((member) => member.userId),
        ),
      ),
    );
  return buildAccountConsolidationPlan(evidenceFixture(pairs.flat()), [], {
    evidenceSha256: 'a'.repeat(64),
    referenceStates: states,
  }).groups;
}
describe('consolidation all-pending-group preflight', () => {
  beforeAll(async () => {
    admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    client = postgres(adminUrl.replace(/\/[^/]+$/, `/${databaseName}`), { max: 1, onnotice: () => {} });
    await client.unsafe(`CREATE TABLE users(id text PRIMARY KEY,email text NOT NULL);
      CREATE TABLE credentials(user_id text PRIMARY KEY REFERENCES users(id),password_hash text NOT NULL);
      CREATE TABLE future_edges(id integer PRIMARY KEY,actor_id text REFERENCES users(id),recipient_id text REFERENCES users(id),observer_id text REFERENCES users(id),payload text DEFAULT 'same');
      CREATE TABLE background_job_runs(id integer PRIMARY KEY,payload jsonb NOT NULL);
      CREATE TABLE board_sessions(id text PRIMARY KEY,created_by_user_id text REFERENCES users(id));
      CREATE TABLE boardsesh_ticks(uuid text PRIMARY KEY,user_id text REFERENCES users(id));
      CREATE TABLE comments(id integer PRIMARY KEY,user_id text REFERENCES users(id),entity_type text,entity_id text);`);
  });
  afterAll(async () => {
    await client?.end({ timeout: 1 });
    if (created) await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await admin?.end({ timeout: 1 });
  });
  beforeEach(async () => {
    await client.unsafe('TRUNCATE users,background_job_runs CASCADE');
    await client`INSERT INTO users VALUES('a','first@example.test'),('b','First@example.test'),('c','second@example.test'),('d','Second@example.test'),('e','third@example.test'),('f','Third@example.test')`;
    await client`INSERT INTO credentials VALUES('b','never-transport-secret')`;
  });
  it('rejects a shared nullable physical row with actionable references and no row payload', async () => {
    await client`INSERT INTO future_edges(id,actor_id,observer_id) VALUES(1,'a','c')`;
    const planned = await groups(3);
    const before = JSON.stringify(planned);
    await expect(
      drizzle(client).transaction((transaction) => preflightConsolidationGroups(transaction, planned)),
    ).rejects.toMatchObject({
      code: 'COUPLED_GROUPS',
      table: 'public.future_edges',
      groupReferences: [
        consolidationDigest(JSON.stringify(['first@example.test', ['a', 'b']])),
        consolidationDigest(JSON.stringify(['second@example.test', ['c', 'd']])),
      ],
    });
    expect(JSON.stringify(planned)).toBe(before);
    expect((await client`SELECT actor_id,recipient_id,observer_id FROM future_edges`)[0]).toEqual({
      actor_id: 'a',
      recipient_id: null,
      observer_id: 'c',
    });
  });
  it('accepts separate physical rows even when their payloads are equal', async () => {
    await client`INSERT INTO future_edges(id,actor_id,payload) VALUES(1,'a','equal payload'),(2,'c','equal payload')`;
    const planned = await groups();
    await expect(
      drizzle(client).transaction((transaction) => preflightConsolidationGroups(transaction, planned)),
    ).resolves.toBeUndefined();
  });
  it('checks exact external drift across all pending groups without replacing approved state', async () => {
    const planned = await groups();
    await client`UPDATE credentials SET password_hash='changed-secret' WHERE user_id='b'`;
    await expect(
      drizzle(client).transaction((transaction) => preflightConsolidationGroups(transaction, planned)),
    ).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' });
  });
  it('detects nested non-FK job references shared across groups', async () => {
    await client`INSERT INTO background_job_runs VALUES(1,'{"nested":{"owners":["a","c"]}}')`;
    const planned = await groups();
    await expect(
      drizzle(client).transaction((transaction) => preflightConsolidationGroups(transaction, planned)),
    ).rejects.toMatchObject({ code: 'COUPLED_GROUPS', table: 'public.background_job_runs' });
  });
  it('detects a comment authored by one group on another group session', async () => {
    await client`INSERT INTO board_sessions VALUES('session-c','c')`;
    await client`INSERT INTO comments VALUES(1,'a','session','session-c')`;
    const planned = await groups();
    await expect(
      drizzle(client).transaction((transaction) => preflightConsolidationGroups(transaction, planned)),
    ).rejects.toMatchObject({ code: 'COUPLED_GROUPS', table: 'public.comments' });
  });
  it('enforces the whole-run deadline before inspecting a group', async () => {
    const planned = await groups();
    await expect(
      drizzle(client).transaction((transaction) =>
        preflightConsolidationGroups(transaction, planned, () => {
          throw new Error('deadline');
        }),
      ),
    ).rejects.toThrow('deadline');
  });
});
