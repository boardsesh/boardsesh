import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { getWorkerDatabaseName } from '../../../__tests__/worker-db';
import { captureConsolidationGroupState } from '../state';

const adminUrl = (
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/boardsesh_backend_test'
).replace(/\/[^/]+$/, '/postgres');
const databaseName = getWorkerDatabaseName('bs_consolidation_state');
const url = adminUrl.replace(/\/[^/]+$/, `/${databaseName}`);
let admin: postgres.Sql;
let client: postgres.Sql;
let created = false;
async function capture(ids = ['a', 'b']) {
  return drizzle(client).transaction((transaction) => captureConsolidationGroupState(transaction, ids), {
    isolationLevel: 'repeatable read',
    accessMode: 'read only',
  });
}
describe('consolidation full-row server fingerprints', () => {
  beforeAll(async () => {
    admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    client = postgres(url, { max: 1, onnotice: () => {} });
    await client.unsafe(
      `CREATE TABLE users(id text PRIMARY KEY,email text NOT NULL); CREATE TABLE credentials(user_id text PRIMARY KEY REFERENCES users(id),password_hash text NOT NULL); CREATE TABLE future_edges(id integer PRIMARY KEY,actor_id text REFERENCES users(id),recipient_id text REFERENCES users(id)); CREATE TABLE background_job_runs(id integer PRIMARY KEY,payload jsonb NOT NULL); CREATE TABLE "verificationTokens"(identifier text,token text);`,
    );
    await client`INSERT INTO users VALUES('a','case@example.test'),('b','Case@example.test'),('c','other@example.test'),('d','Other@example.test')`;
    await client`INSERT INTO credentials VALUES('a','secret-canary'),('b','secret-canary')`;
    await client`INSERT INTO future_edges VALUES(1,'a','c')`;
    await client`INSERT INTO background_job_runs VALUES(1,'{"nested":{"userId":"a"}}')`;
    await client`INSERT INTO "verificationTokens" VALUES('password-reset:Case@example.test','never-transport-token')`;
  });
  afterAll(async () => {
    await client?.end({ timeout: 1 });
    if (created) await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await admin?.end({ timeout: 1 });
  });
  it('covers unknown FK tables, nested job JSON and mixed-case legacy-token tables without credential values', async () => {
    const state = await capture();
    expect(state.tables.find((table) => table.table === 'future_edges')?.rows).toBe(1);
    expect(state.tables.find((table) => table.table === 'background_job_runs')?.rows).toBe(1);
    expect(state.tables.find((table) => table.table === 'verificationTokens')?.rows).toBe(1);
    expect(JSON.stringify(state)).not.toContain('secret-canary');
    expect(JSON.stringify(state)).not.toContain('never-transport-token');
  });
  it('detects credential changes although no credential field is selected', async () => {
    const before = await capture();
    await client`UPDATE credentials SET password_hash='new-secret-canary' WHERE user_id='b'`;
    expect((await capture()).fingerprint).not.toBe(before.fingerprint);
  });
  it('detects index drift independently from row contents', async () => {
    const before = await capture();
    await client`CREATE INDEX new_owner_idx ON future_edges(actor_id)`;
    expect((await capture()).fingerprint).not.toBe(before.fingerprint);
  });
  it('detects shared-row drift after another group changed the relationship endpoint', async () => {
    const before = await capture(['c', 'd']);
    await client`UPDATE future_edges SET actor_id='b' WHERE id=1`;
    expect((await capture(['c', 'd'])).fingerprint).not.toBe(before.fingerprint);
  });
  it('refuses oversized records rather than emitting a partial fingerprint', async () => {
    await client`UPDATE credentials SET password_hash=${'x'.repeat(65537)} WHERE user_id='b'`;
    await expect(capture()).rejects.toMatchObject({ code: 'INPUT_LIMIT' });
  });
});
