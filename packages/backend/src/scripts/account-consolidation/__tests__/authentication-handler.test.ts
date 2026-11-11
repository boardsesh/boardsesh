import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { getWorkerDatabaseName } from '../../../__tests__/worker-db';
import { authenticationConsolidationHandler } from '../authentication-handler';
import { decideCredential, isCredentialAdmitted } from '../../../auth/credential-cutoffs';
import type { ConsolidationContext } from '../executor';

const databaseName = getWorkerDatabaseName('bs_consolidation_auth');
const adminUrl = (process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/postgres').replace(
  /\/[^/]+$/,
  '/postgres',
);
let admin: postgres.Sql;
let client: postgres.Sql;
let created = false;
const migration = readFileSync(
  new URL('../../../../../db/drizzle/0306_account_consolidation.sql', import.meta.url),
  'utf8',
).replaceAll('--> statement-breakpoint', '');
const context: ConsolidationContext = {
  batchId: 'batch',
  mergeId: 'merge',
  survivorUserId: 'target',
  sourceUserIds: ['source'],
  group: {
    group: 'G01',
    normalizedEmail: 'case@example.test',
    memberUserIds: ['source', 'target'],
    survivorUserId: 'target',
    sourceUserIds: ['source'],
    survivorPolicy: 'unique-lowercase',
    password: 'retain-survivor-only',
    preserveProviderLinks: [{ fromUserId: 'source', providers: ['google', 'apple'] }],
    memberFingerprint: 'fingerprint',
    tickMerges: [],
    blockers: [],
  },
};
const apply = () =>
  drizzle(client).transaction((transaction) => authenticationConsolidationHandler().apply(transaction, context));

describe('fresh-signin consolidation authentication finalization', () => {
  beforeAll(async () => {
    admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    client = postgres(adminUrl.replace(/\/[^/]+$/, `/${databaseName}`), { max: 2, onnotice: () => {} });
    await client.unsafe(`CREATE TABLE users(id text PRIMARY KEY,name text,email text NOT NULL DEFAULT 'synthetic@example.test',"emailVerified" timestamp,image text,created_at timestamp NOT NULL DEFAULT now(),updated_at timestamp NOT NULL DEFAULT now()); CREATE TABLE auth_subject_cutoffs(user_id text PRIMARY KEY,generation integer NOT NULL,native_generation integer NOT NULL,revoked_through timestamp NOT NULL,deleted_at timestamp,last_operation_id text NOT NULL);
    CREATE TABLE mobile_refresh_tokens(id text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id),token_hash text NOT NULL UNIQUE,expires_at timestamp NOT NULL,created_at timestamp NOT NULL DEFAULT now(),revoked_at timestamp,subject_generation integer,native_generation integer,authenticated_at timestamptz,session_id text);`);
    await client.unsafe(migration);
    await client.unsafe(`CREATE TABLE notification_devices(installation_id text PRIMARY KEY,user_id text REFERENCES users(id),active boolean,updated_at timestamp);
    CREATE TABLE accounts("userId" text REFERENCES users(id),type text,provider text,"providerAccountId" text,PRIMARY KEY(provider,"providerAccountId"));
    CREATE TABLE user_credentials(user_id text PRIMARY KEY REFERENCES users(id),password_hash text,created_at timestamp DEFAULT now(),updated_at timestamp DEFAULT now());
    CREATE TABLE sessions("sessionToken" text PRIMARY KEY,"userId" text REFERENCES users(id),expires timestamp);
    CREATE TABLE auth_email_verification_tokens(user_id text,superseded_at timestamptz);
    CREATE TABLE auth_password_recovery_tokens(user_id text,superseded_at timestamptz);
    CREATE TABLE "verificationTokens"(identifier text,token text,expires timestamp);
    CREATE TABLE auth_email_projection(projection_id text PRIMARY KEY,is_current boolean,normalizer_version text,phase text,writer_epoch integer,source_user_count integer,key_count integer,ambiguous_key_count integer,created_at timestamptz,prepared_at timestamptz);
    CREATE TABLE auth_email_reservations(normalized_email text PRIMARY KEY,basis_projection_id text,state text,owner_user_id text,created_at timestamptz DEFAULT now());
    CREATE TABLE auth_email_reservation_members(normalized_email text,user_id text,observed_at timestamptz DEFAULT now(),PRIMARY KEY(normalized_email,user_id));`);
    vi.doMock('../../../auth/admission-pool', () => ({
      readOnAdmissionConnection: async (
        markExecuting: () => void,
        operation: (database: ReturnType<typeof drizzle>) => Promise<unknown>,
      ) => {
        markExecuting();
        return operation(drizzle(client));
      },
    }));
  });
  afterAll(async () => {
    vi.doUnmock('../../admission-pool');
    await client?.end({ timeout: 1 });
    if (created) await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await admin?.end({ timeout: 1 });
  });
  beforeEach(async () => {
    await client.unsafe(
      'TRUNCATE account_consolidation_members,mobile_refresh_tokens,auth_subject_cutoffs,users,auth_email_projection,auth_email_reservations,auth_email_reservation_members,auth_email_verification_tokens,auth_password_recovery_tokens,"verificationTokens" CASCADE',
    );
    await client`INSERT INTO users(id,email) VALUES('source','Case@example.test'),('target','case@example.test')`;
    await client`INSERT INTO auth_subject_cutoffs(user_id,generation,native_generation,revoked_through,last_operation_id) VALUES('source',2,3,now(),'source-old'),('target',7,8,now(),'target-old')`;
    await client`INSERT INTO mobile_refresh_tokens(id,user_id,token_hash,expires_at,subject_generation,native_generation,session_id) VALUES('source-refresh','source','source-hash',now()+interval '1 hour',2,3,'source-sid'),('target-refresh','target','target-hash',now()+interval '1 hour',7,8,'target-sid')`;
    await client`INSERT INTO user_credentials(user_id,password_hash) VALUES('source','source-secret-hash'),('target','target-secret-hash')`;
    await client`INSERT INTO sessions("sessionToken","userId",expires) VALUES('source-web','source',now()+interval '1 hour'),('target-web','target',now()+interval '1 hour')`;
    await client`INSERT INTO notification_devices(installation_id,user_id,active) VALUES('source-install','source',true),('target-install','target',true)`;
  });

  it('retires source credentials and sessions while leaving canonical authentication unchanged', async () => {
    const before = await client`SELECT * FROM mobile_refresh_tokens WHERE user_id='target'`;
    const targetCutoff = await client`SELECT * FROM auth_subject_cutoffs WHERE user_id='target'`;
    expect(await apply()).toMatchObject({
      retiredSubjects: 1,
      sourcePasswordsRemoved: 1,
      nativeSessionsRevoked: 1,
      webSessionsRemoved: 1,
    });
    expect(await client`SELECT * FROM mobile_refresh_tokens WHERE user_id='target'`).toEqual(before);
    expect(await client`SELECT * FROM auth_subject_cutoffs WHERE user_id='target'`).toEqual(targetCutoff);
    expect(await client`SELECT user_id,password_hash FROM user_credentials`).toEqual([
      { user_id: 'target', password_hash: 'target-secret-hash' },
    ]);
    expect(await client`SELECT "sessionToken","userId" FROM sessions`).toEqual([
      { sessionToken: 'target-web', userId: 'target' },
    ]);
    expect(
      await client`SELECT revoked_at IS NOT NULL AS revoked FROM mobile_refresh_tokens WHERE user_id='source'`,
    ).toEqual([{ revoked: true }]);
    expect(await client`SELECT installation_id,active FROM notification_devices ORDER BY installation_id`).toEqual([
      { installation_id: 'source-install', active: false },
      { installation_id: 'target-install', active: true },
    ]);
    expect(
      await client`SELECT source_user_id,canonical_user_id,merge_id,status FROM account_consolidation_members`,
    ).toEqual([{ source_user_id: 'source', canonical_user_id: 'target', merge_id: 'merge', status: 'applied' }]);
    expect(await client`SELECT count(*)::integer AS count FROM mobile_refresh_tokens WHERE user_id='target'`).toEqual([
      { count: 1 },
    ]);
  });

  it('requires fresh signin for source web and native credentials, including cutoff observation mode', async () => {
    await apply();
    const { readHumanSubjectStates } = await import('../../../auth/human-admission');
    const states = await readHumanSubjectStates(['source', 'target']);
    expect(states.get('source')).toBeUndefined();
    expect(states.get('target')).toMatchObject({ generation: 7, nativeGeneration: 8 });
    for (const credential of [
      { kind: 'web-session', generationClaim: 2, sessionKeyClaim: 'source-web', authTimeClaim: undefined },
      { kind: 'native-access', generationClaim: 2, nativeGenerationClaim: 3, authTimeClaim: undefined },
    ] as const) {
      const decision = decideCredential(credential, states.get('source'), Date.now());
      expect(decision.denial).toBe('subject-inactive');
      expect(isCredentialAdmitted(decision, 'observe')).toBe(false);
    }
  });

  it('preserves Google and Apple identities and supersedes only source UID recovery credentials', async () => {
    await client`INSERT INTO accounts VALUES('source','oauth','google','google-sub'),('source','oauth','apple','apple-sub')`;
    await client`INSERT INTO auth_email_verification_tokens(user_id) VALUES('source'),('target')`;
    await client`INSERT INTO auth_password_recovery_tokens(user_id) VALUES('source'),('target')`;
    await client`INSERT INTO "verificationTokens"(identifier,token) VALUES
      ('Case@example.test','source-verify'),('password-reset:Case@example.test','source-reset'),
      ('case@example.test','ambiguous-verify'),('password-reset:case@example.test','ambiguous-reset'),
      ('other@example.test','unrelated')`;
    expect(await apply()).toMatchObject({ providerLinks: 2 });
    // Email-only pre-merge links require a fresh request; canonical UID-scoped
    // recovery credentials below still belong to the same survivor.
    expect(await client`SELECT token FROM "verificationTokens"`).toEqual([{ token: 'unrelated' }]);
    expect(await client`SELECT "userId",provider FROM accounts ORDER BY provider`).toEqual([
      { userId: 'target', provider: 'apple' },
      { userId: 'target', provider: 'google' },
    ]);
    expect(
      await client`SELECT user_id,superseded_at IS NOT NULL AS retired FROM auth_password_recovery_tokens ORDER BY user_id`,
    ).toEqual([
      { user_id: 'source', retired: true },
      { user_id: 'target', retired: false },
    ]);
    expect(
      await client`SELECT email LIKE '%@retired.boardsesh.invalid' AS retired,"emailVerified" FROM users WHERE id='source'`,
    ).toEqual([{ retired: true, emailVerified: null }]);
  });

  it('assigns the normalized reservation to the survivor and retains source membership only as data history', async () => {
    await client`INSERT INTO auth_email_projection(projection_id,is_current,phase,key_count,ambiguous_key_count) VALUES('projection',true,'enforced',1,1)`;
    await client`INSERT INTO auth_email_reservations(normalized_email,basis_projection_id,state) VALUES('case@example.test','projection','blocked_ambiguous')`;
    await client`INSERT INTO auth_email_reservation_members(normalized_email,user_id) VALUES('case@example.test','source'),('case@example.test','target')`;
    await apply();
    expect(
      await client`SELECT state,owner_user_id FROM auth_email_reservations WHERE normalized_email='case@example.test'`,
    ).toEqual([{ state: 'owned', owner_user_id: 'target' }]);
    expect(
      await client`SELECT user_id FROM auth_email_reservation_members WHERE normalized_email='case@example.test'`,
    ).toEqual([{ user_id: 'target' }]);
    expect(await client`SELECT key_count,ambiguous_key_count FROM auth_email_projection`).toEqual([
      { key_count: 2, ambiguous_key_count: 0 },
    ]);
    expect(
      await client`SELECT generation,native_generation,deleted_at IS NOT NULL AS retired FROM auth_subject_cutoffs WHERE user_id='source'`,
    ).toEqual([{ generation: 3, native_generation: 3, retired: true }]);
  });

  it('rolls back every authentication change when canonical state drifts', async () => {
    await client`UPDATE users SET email='unexpected@example.test' WHERE id='target'`;
    await expect(apply()).rejects.toThrow('authentication state changed');
    expect(await client`SELECT revoked_at FROM mobile_refresh_tokens WHERE user_id='source'`).toEqual([
      { revoked_at: null },
    ]);
    expect(await client`SELECT count(*)::integer AS count FROM user_credentials WHERE user_id='source'`).toEqual([
      { count: 1 },
    ]);
    expect(await client`SELECT count(*)::integer AS count FROM account_consolidation_members`).toEqual([{ count: 0 }]);
  });
});
