/** Explicit disposable-cluster rehearsal; not part of the shared test database suite. */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { PgBoss } from 'pg-boss';
import { drizzle } from 'drizzle-orm/postgres-js';
import {
  jobQueueTransactionAdapter,
  BACKGROUND_JOB_QUEUE_OPTIONS,
  BACKGROUND_JOB_QUEUES,
} from '@boardsesh/db/background-jobs';
import { schemaSQL } from '../../../__tests__/schema-sql';
import { evidenceFixture, tickFixture } from './fixtures';
import { captureConsolidationGroupState } from '../state';
import { buildAccountConsolidationPlan, fingerprintConsolidationPlan } from '../planner';
import { verifyPostgresMaintenanceFence } from '../maintenance';
import { runAccountConsolidationApply } from '../../../scripts/consolidate-account-emails';

const url = process.env.CONSOLIDATION_REHEARSAL_URL;
if (url !== 'postgresql://postgres:synthetic-rehearsal@127.0.0.1:55437/consolidation_rehearsal')
  throw new Error('Dedicated disposable fixture URL required.');
const bootstrap = postgres(url, { max: 1, onnotice: () => {} });
await bootstrap.unsafe(
  'DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS pgboss CASCADE; DROP ROLE IF EXISTS boardsesh_consolidation_operator',
);
await bootstrap.unsafe(schemaSQL);
for (const tag of ['0241_background_job_runs', '0243_background_job_families', '0305_account_consolidation']) {
  if (
    tag === '0305_account_consolidation' &&
    (await bootstrap`SELECT to_regclass('public.account_consolidation_batches') AS name`)[0].name
  )
    continue;
  await bootstrap.unsafe(
    readFileSync(new URL(`../../../../../db/drizzle/${tag}.sql`, import.meta.url), 'utf8').replaceAll(
      '--> statement-breakpoint',
      '',
    ),
  );
}
const boss = new PgBoss({
  db: jobQueueTransactionAdapter(drizzle(bootstrap)),
  supervise: false,
  schedule: false,
  reindex: false,
});
boss.on('error', () => {});
await boss.start();
for (const queue of Object.values(BACKGROUND_JOB_QUEUES)) await boss.createQueue(queue, BACKGROUND_JOB_QUEUE_OPTIONS);
await boss.stop({ graceful: false, close: false });
await bootstrap`INSERT INTO users(id,email,name) VALUES('canonical','fixture@example.test','Canonical'),('source','Fixture@example.test','Source')`;
await bootstrap`INSERT INTO user_credentials(user_id,password_hash) VALUES('canonical','keep-password'),('source','discard-password')`;
await bootstrap`INSERT INTO user_profiles(user_id,display_name,is_private) VALUES('canonical','Canonical display',false),('source','Source display',true)`;
await bootstrap`INSERT INTO board_sessions(id,origin,created_by_user_id,status,anchor_tick_id,name,notes) VALUES('canonical-session','inferred','canonical','ended',1,'Canonical session','Keep canonical notes'),('source-session','inferred','source','ended',2,'Source session','Keep source notes')`;
await bootstrap`INSERT INTO boardsesh_ticks(id,uuid,user_id,board_type,climb_uuid,angle,status,climbed_at,session_id,origin,attempt_count,quality,difficulty,aurora_id,aurora_type) VALUES(1,'tick-one','canonical','tension','synthetic-climb',40,'send','2026-01-01 12:00:00.000001','canonical-session','json_import',2,3,16,'json-import-one','ascents'),(2,'tick-two','source','tension','synthetic-climb',40,'send','2026-01-01 12:00:00.000001','source-session','json_import',2,3,16,'json-import-two','ascents')`;
await bootstrap`INSERT INTO user_favorites(user_id,board_name,climb_uuid,angle) VALUES('canonical','tension','synthetic-climb',40),('source','tension','synthetic-climb',40)`;
await bootstrap`INSERT INTO user_board_mappings(user_id,board_type,board_user_id,board_username) VALUES('canonical','tension',7430,'synthetic-provider'),('source','tension',7430,'synthetic-provider')`;
await bootstrap`INSERT INTO aurora_credentials(user_id,board_type,aurora_user_id,encrypted_username,encrypted_password) VALUES('canonical','tension',7430,'synthetic-encrypted-username-canary','synthetic-encrypted-password-canary'),('source','tension',7430,'synthetic-encrypted-username-canary','synthetic-encrypted-password-canary')`;
await bootstrap`INSERT INTO user_climb_percentiles(user_id,total_distinct_climbs,percentile,total_active_users) VALUES('canonical',1,20,2),('source',1,20,2)`;
await bootstrap.unsafe(
  "CREATE ROLE boardsesh_consolidation_operator LOGIN SUPERUSER PASSWORD 'synthetic-operator'; ALTER ROLE postgres NOLOGIN;",
);
await assert.rejects(drizzle(bootstrap).transaction(verifyPostgresMaintenanceFence), { code: 'UNSAFE_PLAN' });
await bootstrap.end({ timeout: 1 });
const operatorUrl = url.replace('postgres:synthetic-rehearsal', 'boardsesh_consolidation_operator:synthetic-operator');
const operator = postgres(operatorUrl, { max: 1, onnotice: () => {} });
await drizzle(operator).transaction(verifyPostgresMaintenanceFence);
const state = await drizzle(operator).transaction((transaction) =>
  captureConsolidationGroupState(transaction, ['canonical', 'source']),
);
const plan = buildAccountConsolidationPlan(
  evidenceFixture([
    { userId: 'canonical', email: 'fixture@example.test', ticks: 1 },
    { userId: 'source', email: 'Fixture@example.test', ticks: 1 },
  ]),
  [
    tickFixture({ sessionId: 'canonical-session' }),
    tickFixture({
      id: '2',
      uuid: 'tick-two',
      userId: 'source',
      sessionId: 'source-session',
      auroraId: 'json-import-two',
    }),
  ],
  { evidenceSha256: 'a'.repeat(64), referenceStates: new Map([['fixture@example.test', state]]) },
);
assert.equal(plan.groups[0].blockers.length, 0);
const directory = mkdtempSync('/private/tmp/consolidation-rehearsal-');
chmodSync(directory, 0o700);
const planFile = join(directory, 'plan.json');
writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
await operator.end({ timeout: 1 });
const environment = { ACCOUNT_CONSOLIDATION_DATABASE_URL: operatorUrl, ACCOUNT_CONSOLIDATION_BRIDGE_MODE: 'enabled' };
const options = {
  planFile,
  expectedPlanSha256: fingerprintConsolidationPlan(plan),
  batchId: 'synthetic-rehearsal',
  out: join(directory, 'receipt.jsonl'),
};
await runAccountConsolidationApply(options, environment);
await runAccountConsolidationApply({ ...options, out: join(directory, 'resumed-receipt.jsonl') }, environment);
const verification = postgres(operatorUrl, { max: 1, onnotice: () => {} });
assert.equal((await verification`SELECT count(*)::int AS count FROM boardsesh_ticks`)[0].count, 1);
assert.equal((await verification`SELECT count(*)::int AS count FROM user_favorites`)[0].count, 1);
assert.equal(
  (await verification`SELECT password_hash FROM user_credentials WHERE user_id='canonical'`)[0].password_hash,
  'keep-password',
);
assert.equal(
  (await verification`SELECT count(*)::int AS count FROM user_credentials WHERE user_id='source'`)[0].count,
  0,
);
assert.equal((await verification`SELECT count(*)::int AS count FROM account_consolidation_group_audits`)[0].count, 1);
assert.equal(
  (
    await verification`SELECT count(*)::int AS count FROM background_job_runs WHERE family='refresh-user-percentiles'`
  )[0].count,
  1,
);
const [providerJob] =
  await verification`SELECT id::text,payload FROM background_job_runs WHERE family='aurora-user-sync'`;
assert.ok(providerJob);
const providerControls =
  await verification`SELECT user_id,linked,pending_run_id::text,link_generation::text FROM provider_sync_controls WHERE board_type='tension' ORDER BY user_id`;
assert.equal(providerControls[0].user_id, 'canonical');
assert.equal(providerControls[0].linked, true);
assert.equal(providerControls[0].pending_run_id, providerJob.id);
assert.equal(providerJob.payload.linkGeneration, providerControls[0].link_generation);
assert.equal(providerControls[1].linked, false);
assert.equal(providerControls[1].pending_run_id, null);
const receiptLines = readFileSync(options.out, 'utf8').trim().split('\n');
const receipt = JSON.parse(receiptLines.slice(1).join('\n')) as { archives: { filename: string }[] };
for (const archive of receipt.archives) {
  const bytes = readFileSync(archive.filename, 'utf8');
  assert.ok(!bytes.includes('synthetic-encrypted-username-canary'));
  assert.ok(!bytes.includes('synthetic-encrypted-password-canary'));
}
assert.equal((await verification`SELECT count(*)::int AS count FROM aurora_credentials`)[0].count, 1);
assert.equal((await verification`SELECT count(*)::int AS count FROM user_board_mappings`)[0].count, 1);
assert.equal((await verification`SELECT count(*)::int AS count FROM board_sessions`)[0].count, 1);
assert.match((await verification`SELECT notes FROM board_sessions`)[0].notes, /Keep source notes/);
await verification.end({ timeout: 1 });
process.stdout.write(
  JSON.stringify({
    status: 'passed',
    groups: 1,
    domains: 6,
    idempotentResume: true,
    actualMaintenanceFence: true,
    actualCli: true,
    providerPendingRunMatchesQueuedJob: true,
    providerSecretsExcludedFromArchive: true,
  }) + '\n',
);
