import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { decodeJwt, EncryptJWT, SignJWT } from 'jose';
import { hkdf } from '@panva/hkdf';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { accountConsolidationSessionProofs, mobileRefreshTokens } from '@boardsesh/db/schema/auth';
import { getWorkerDatabaseName } from '../../../__tests__/worker-db';
import {
  nativeConsolidationExchangeTransaction,
  revokeConsolidationSourceNativeSessions,
  revokeConsolidationTargetNativeBridges,
} from '../database';
import { exchangeConsolidationSession } from '../exchange';
import { authenticationConsolidationHandler } from '../finalize';
import {
  consolidationWebCredentialId,
  exchangeVerifiedConsolidationWebSession,
  revokeConsolidationWebSession,
  revokeAllConsolidationTargetBridges,
} from '../web';

const HASH = createHash('sha256').update('synthetic-refresh-secret').digest('hex');
let server: Server;
let origin: string;
const originalSecret = process.env.NEXTAUTH_SECRET;
const originalEnforcement = process.env.AUTH_CUTOFF_ENFORCEMENT;
const originalRpcSecret = process.env.CURRENT_STORE_AUTH_RPC_SECRET;
const originalBridge = process.env.ACCOUNT_CONSOLIDATION_BRIDGE_MODE;
const databaseName = getWorkerDatabaseName('bs_consolidation_bridge');
const adminUrl = (process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/postgres').replace(
  /\/[^/]+$/,
  '/postgres',
);
let admin: postgres.Sql;
let client: postgres.Sql;
let created = false;
const hint = { credentialId: 'parent', sourceUserId: 'source', targetUserId: 'target' };
const migration = readFileSync(
  new URL('../../../../../db/drizzle/0305_account_consolidation.sql', import.meta.url),
  'utf8',
).replaceAll('--> statement-breakpoint', '');

describe('real transaction consolidation bridge', () => {
  beforeAll(async () => {
    admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    client = postgres(adminUrl.replace(/\/[^/]+$/, `/${databaseName}`), { max: 3, onnotice: () => {} });
    await client.unsafe(`CREATE TABLE users(id text PRIMARY KEY,name text,email text NOT NULL DEFAULT 'synthetic@example.test',"emailVerified" timestamp,image text,created_at timestamp NOT NULL DEFAULT now(),updated_at timestamp NOT NULL DEFAULT now()); CREATE TABLE auth_subject_cutoffs(user_id text PRIMARY KEY,generation integer NOT NULL,native_generation integer NOT NULL,revoked_through timestamp NOT NULL,deleted_at timestamp,last_operation_id text NOT NULL);
    CREATE TABLE mobile_refresh_tokens(id text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id),token_hash text NOT NULL UNIQUE,expires_at timestamp NOT NULL,created_at timestamp NOT NULL DEFAULT now(),revoked_at timestamp,subject_generation integer,native_generation integer,authenticated_at timestamptz,session_id text);`);
    await client.unsafe(migration);
    await client.unsafe(`CREATE TABLE notification_devices(user_id text,active boolean,updated_at timestamp);
    CREATE TABLE accounts("userId" text REFERENCES users(id),type text,provider text,"providerAccountId" text,PRIMARY KEY(provider,"providerAccountId"));
    CREATE TABLE user_credentials(user_id text PRIMARY KEY REFERENCES users(id),password_hash text,created_at timestamp DEFAULT now(),updated_at timestamp DEFAULT now());
    CREATE TABLE sessions("sessionToken" text PRIMARY KEY,"userId" text REFERENCES users(id),expires timestamp);
    CREATE TABLE auth_email_verification_tokens(user_id text,superseded_at timestamptz);
    CREATE TABLE auth_password_recovery_tokens(user_id text,superseded_at timestamptz);
    CREATE TABLE "verificationTokens"(identifier text,token text,expires timestamp);
    CREATE TABLE auth_email_projection(projection_id text PRIMARY KEY,is_current boolean,normalizer_version text,phase text,writer_epoch integer,source_user_count integer,key_count integer,ambiguous_key_count integer,created_at timestamptz,prepared_at timestamptz);
    CREATE TABLE auth_email_reservations(normalized_email text PRIMARY KEY,basis_projection_id text,state text,owner_user_id text,created_at timestamptz DEFAULT now());
    CREATE TABLE auth_email_reservation_members(normalized_email text,user_id text,observed_at timestamptz DEFAULT now(),PRIMARY KEY(normalized_email,user_id));`);
    vi.doMock('../../../db/client', () => ({ db: drizzle(client) }));
    vi.doMock('../../admission-pool', () => ({
      readOnAdmissionConnection: async (
        markExecuting: () => void,
        operation: (database: ReturnType<typeof drizzle>) => Promise<unknown>,
      ) => {
        markExecuting();
        return operation(drizzle(client));
      },
    }));
    process.env.NEXTAUTH_SECRET = 'synthetic-consolidation-secret-long-enough-for-tests';
    process.env.ACCOUNT_CONSOLIDATION_BRIDGE_MODE = 'enabled';
    process.env.CURRENT_STORE_AUTH_RPC_SECRET = 'synthetic-private-command-secret-long-enough';
    const { handleConsolidationWeb } = await import('../../../handlers/consolidation-web');
    const { handleNativeAuthRefresh, handleNativeAuthRevoke } = await import('../../../handlers/native-auth');
    server = createServer((request, response) => {
      void (request.url === '/web'
        ? handleConsolidationWeb(request, response)
        : request.url === '/revoke'
          ? handleNativeAuthRevoke(request, response)
          : handleNativeAuthRefresh(request, response));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture server did not bind');
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.doUnmock('../../../db/client');
    vi.doUnmock('../../admission-pool');
    if (originalEnforcement === undefined) delete process.env.AUTH_CUTOFF_ENFORCEMENT;
    else process.env.AUTH_CUTOFF_ENFORCEMENT = originalEnforcement;
    if (originalRpcSecret === undefined) delete process.env.CURRENT_STORE_AUTH_RPC_SECRET;
    else process.env.CURRENT_STORE_AUTH_RPC_SECRET = originalRpcSecret;
    if (originalSecret === undefined) delete process.env.NEXTAUTH_SECRET;
    else process.env.NEXTAUTH_SECRET = originalSecret;
    if (originalBridge === undefined) delete process.env.ACCOUNT_CONSOLIDATION_BRIDGE_MODE;
    else process.env.ACCOUNT_CONSOLIDATION_BRIDGE_MODE = originalBridge;
    await client?.end({ timeout: 1 });
    if (created) await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await admin?.end({ timeout: 1 });
  });
  beforeEach(async () => {
    await client.unsafe(
      'TRUNCATE account_consolidation_session_proofs,account_consolidation_members,mobile_refresh_tokens,auth_subject_cutoffs,users CASCADE',
    );
    await client`INSERT INTO users VALUES ('source'),('target')`;
    await client`INSERT INTO auth_subject_cutoffs VALUES ('source',3,3,now(),now()-interval '5 seconds','merge'),('target',7,8,now(),NULL,'prior')`;
    await client`INSERT INTO account_consolidation_members(source_user_id,canonical_user_id,merge_id,status,source_generation_before,source_native_generation_before,source_generation_after,source_native_generation_after,target_generation,target_native_generation,applied_at) VALUES('source','target','merge','applied',2,3,3,3,7,8,now()-interval '5 seconds')`;
    await client`INSERT INTO mobile_refresh_tokens(id,user_id,token_hash,expires_at,created_at,subject_generation,native_generation,authenticated_at,session_id) VALUES('parent','source',${HASH},now()+interval '1 hour',now()-interval '10 seconds',2,3,now()-interval '30 seconds','old-session')`;
    await client`INSERT INTO account_consolidation_session_proofs(credential_id,source_user_id,merge_id,kind,canonical_session_id,expires_at) VALUES('parent','source','merge','native-refresh','mapped-session',now()+interval '1 hour')`;
  });

  async function transfer(fail = false) {
    return drizzle(client).transaction(async (tx) =>
      exchangeConsolidationSession(
        nativeConsolidationExchangeTransaction(tx, HASH, async (decision, canonicalSessionId) => {
          if (fail) throw new Error('synthetic issuance failure');
          await tx.insert(mobileRefreshTokens).values({
            id: 'child',
            userId: decision.toUserId,
            tokenHash: 'child-hash',
            expiresAt: new Date(decision.originalExpiresAtMs),
            authenticatedAt: decision.authenticatedAtMs === null ? null : new Date(decision.authenticatedAtMs),
            subjectGeneration: decision.targetGeneration,
            nativeGeneration: decision.targetNativeGeneration,
            sessionId: canonicalSessionId,
          });
          return canonicalSessionId;
        }),
        hint,
      ),
    );
  }

  it('consumes exact enrolled proof and issues one canonical lineage atomically', async () => {
    await expect(transfer()).resolves.toBe('mapped-session');
    const [child] = await drizzle(client).select().from(mobileRefreshTokens).where(eq(mobileRefreshTokens.id, 'child'));
    expect(child).toMatchObject({
      userId: 'target',
      subjectGeneration: 7,
      nativeGeneration: 8,
      sessionId: 'mapped-session',
    });
    expect(child?.authenticatedAt?.getTime()).toBeLessThan(Date.now() - 20000);
    await expect(transfer()).rejects.toMatchObject({ code: 'INELIGIBLE' });
    expect(await client`SELECT count(*)::integer AS total FROM mobile_refresh_tokens`).toEqual([{ total: 2 }]);
  });
  it('rolls back proof consumption and parent revocation when issuance fails', async () => {
    await expect(transfer(true)).rejects.toThrow('synthetic issuance failure');
    const [proof] = await drizzle(client).select().from(accountConsolidationSessionProofs);
    expect(proof?.consumedAt).toBeNull();
    expect(await client`SELECT revoked_at FROM mobile_refresh_tokens WHERE id='parent'`).toEqual([
      { revoked_at: null },
    ]);
  });
  it('refuses missing enrollment, wrong bearer hash and expired original proof', async () => {
    await drizzle(client).transaction(async (tx) => {
      await expect(
        exchangeConsolidationSession(
          nativeConsolidationExchangeTransaction(tx, 'wrong', async () => 'bad'),
          hint,
        ),
      ).rejects.toMatchObject({ code: 'DRIFT' });
    });
    await client`UPDATE mobile_refresh_tokens SET expires_at=now()-interval '1 second' WHERE id='parent'`;
    await expect(transfer()).rejects.toMatchObject({ code: 'INELIGIBLE' });
  });
  it('source signout ends transferred lineage but preserves unrelated target sessions', async () => {
    await transfer();
    await client`INSERT INTO mobile_refresh_tokens(id,user_id,token_hash,expires_at,session_id) VALUES('unrelated','target','unrelated-hash',now()+interval '1 hour','unrelated-session')`;
    await drizzle(client).transaction((tx) => revokeConsolidationSourceNativeSessions(tx, 'source'));
    expect(
      await client`SELECT id,revoked_at IS NOT NULL AS revoked FROM mobile_refresh_tokens WHERE user_id='target' ORDER BY id`,
    ).toEqual([
      { id: 'child', revoked: true },
      { id: 'unrelated', revoked: false },
    ]);
  });
  it('a consumed source refresh secret still revokes transferred lineage with new exchanges disabled', async () => {
    await transfer();
    process.env.ACCOUNT_CONSOLIDATION_BRIDGE_MODE = 'off';
    try {
      const response = await fetch(`${origin}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: 'synthetic-refresh-secret' }),
      });
      expect(response.status).toBe(200);
      expect(
        await client`SELECT revoked_at IS NOT NULL AS revoked FROM account_consolidation_session_proofs WHERE credential_id='parent'`,
      ).toEqual([{ revoked: true }]);
      expect(
        await client`SELECT revoked_at IS NOT NULL AS revoked FROM mobile_refresh_tokens WHERE id='child'`,
      ).toEqual([{ revoked: true }]);
    } finally {
      process.env.ACCOUNT_CONSOLIDATION_BRIDGE_MODE = 'enabled';
    }
  });

  it('actual native refresh returns canonical JWT and receipt without freshening authentication', async () => {
    const response = await fetch(origin, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: 'synthetic-refresh-secret' }),
    });
    expect(response.status).toBe(200);
    const reply = (await response.json()) as { jwt: string; accountConsolidation: unknown };
    expect(decodeJwt(reply.jwt)).toMatchObject({ sub: 'target', gen: 7, ngen: 8, sid: 'mapped-session' });
    expect(Number(decodeJwt(reply.jwt).auth_time)).toBeLessThan(Date.now() / 1000 - 20);
    expect(reply.accountConsolidation).toEqual({ mergeId: 'merge', fromUserId: 'source', toUserId: 'target' });
    const replay = await fetch(origin, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: 'synthetic-refresh-secret' }),
    });
    expect(replay.status).toBe(401);
  });

  it('actual private web command exchanges only enrolled original cookie lineage and honors logout', async () => {
    const credentialId = consolidationWebCredentialId('source', 'web-original');
    await client`INSERT INTO account_consolidation_session_proofs(credential_id,source_user_id,merge_id,kind,canonical_session_id,expires_at)
      VALUES(${credentialId},'source','merge','web-session','mapped-web',now()+interval '1 hour')`;
    const secret = process.env.NEXTAUTH_SECRET!;
    const key = await hkdf('sha256', new TextEncoder().encode(secret), '', 'NextAuth.js Generated Encryption Key', 32);
    const now = Math.floor(Date.now() / 1000);
    const credential = await new EncryptJWT({
      sub: 'source',
      gen: 2,
      authSessionId: 'web-original',
      auth_time: now - 100,
    })
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
      .setIssuedAt(now - 100)
      .setExpirationTime(now + 3600)
      .encrypt(key);
    const command = (operation: string, authorized = true) =>
      fetch(`${origin}/web`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authorized ? { Authorization: `Bearer ${process.env.CURRENT_STORE_AUTH_RPC_SECRET}` } : {}),
        },
        body: JSON.stringify({ operation, credential }),
      });
    expect((await command('exchange', false)).status).toBe(401);
    const response = await command('exchange');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      outcome: 'transferred',
      sub: 'target',
      generation: 7,
      sessionId: 'mapped-web',
      receipt: { mergeId: 'merge', fromUserId: 'source', toUserId: 'target' },
    });
    process.env.ACCOUNT_CONSOLIDATION_BRIDGE_MODE = 'off';
    expect((await command('revoke')).status).toBe(200);
    process.env.ACCOUNT_CONSOLIDATION_BRIDGE_MODE = 'enabled';
    expect((await command('exchange')).status).toBe(401);
  });

  it('primary admission refuses revoked canonical access lineage with bridge off and cutoff observation on', async () => {
    const response = await fetch(origin, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: 'synthetic-refresh-secret' }),
    });
    const reply = (await response.json()) as { jwt: string };
    const { validateMobileJwt } = await import('../../../middleware/auth');
    expect(await validateMobileJwt(reply.jwt)).toMatchObject({ userId: 'target' });
    const unrelated = await new SignJWT({ sub: 'target', gen: 7, ngen: 8, sid: 'survivor-existing' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer('boardsesh')
      .setAudience('boardsesh-mobile')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.NEXTAUTH_SECRET));
    await drizzle(client).transaction((transaction) => revokeConsolidationSourceNativeSessions(transaction, 'source'));
    process.env.ACCOUNT_CONSOLIDATION_BRIDGE_MODE = 'off';
    process.env.AUTH_CUTOFF_ENFORCEMENT = 'observe';
    try {
      expect(await validateMobileJwt(reply.jwt)).toBeNull();
      expect(await validateMobileJwt(unrelated)).toMatchObject({ userId: 'target' });
    } finally {
      process.env.ACCOUNT_CONSOLIDATION_BRIDGE_MODE = 'enabled';
      if (originalEnforcement === undefined) delete process.env.AUTH_CUTOFF_ENFORCEMENT;
      else process.env.AUTH_CUTOFF_ENFORCEMENT = originalEnforcement;
    }
  });

  it('target security invalidation revokes pending and transferred proofs even while exchanges are off', async () => {
    const response = await fetch(origin, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: 'synthetic-refresh-secret' }),
    });
    const reply = (await response.json()) as { jwt: string };
    const { validateMobileJwt } = await import('../../../middleware/auth');
    process.env.ACCOUNT_CONSOLIDATION_BRIDGE_MODE = 'off';
    process.env.AUTH_CUTOFF_ENFORCEMENT = 'observe';
    try {
      await drizzle(client).transaction((transaction) => revokeAllConsolidationTargetBridges(transaction, 'target'));
      expect(await validateMobileJwt(reply.jwt)).toBeNull();
      expect(
        await client`SELECT native_bridge_revoked_at IS NOT NULL AS native,web_bridge_revoked_at IS NOT NULL AS web FROM account_consolidation_members WHERE source_user_id='source'`,
      ).toEqual([{ native: true, web: true }]);
      expect(
        await client`SELECT revoked_at IS NOT NULL AS revoked FROM account_consolidation_session_proofs WHERE source_user_id='source'`,
      ).toEqual([{ revoked: true }]);
    } finally {
      process.env.ACCOUNT_CONSOLIDATION_BRIDGE_MODE = 'enabled';
      if (originalEnforcement === undefined) delete process.env.AUTH_CUTOFF_ENFORCEMENT;
      else process.env.AUTH_CUTOFF_ENFORCEMENT = originalEnforcement;
    }
  });

  it('refuses an otherwise live canonical refresh child when only its mapped proof was revoked', async () => {
    const issue = await fetch(origin, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: 'synthetic-refresh-secret' }),
    });
    const transferred = (await issue.json()) as { refreshToken: string };
    await client`UPDATE account_consolidation_session_proofs SET revoked_at=now() WHERE credential_id='parent'`;
    const unrelatedHash = createHash('sha256').update('unrelated-refresh-secret').digest('hex');
    await client`INSERT INTO mobile_refresh_tokens(id,user_id,token_hash,expires_at,subject_generation,native_generation,session_id)
      VALUES('unrelated','target',${unrelatedHash},now()+interval '1 hour',7,8,'survivor-existing')`;
    process.env.ACCOUNT_CONSOLIDATION_BRIDGE_MODE = 'off';
    process.env.AUTH_CUTOFF_ENFORCEMENT = 'observe';
    try {
      const refresh = (refreshToken: string) =>
        fetch(origin, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
      expect((await refresh(transferred.refreshToken)).status).toBe(401);
      expect((await refresh('unrelated-refresh-secret')).status).toBe(200);
    } finally {
      process.env.ACCOUNT_CONSOLIDATION_BRIDGE_MODE = 'enabled';
      if (originalEnforcement === undefined) delete process.env.AUTH_CUTOFF_ENFORCEMENT;
      else process.env.AUTH_CUTOFF_ENFORCEMENT = originalEnforcement;
    }
  });

  it('serializes source logout with canonical child rotation so no descendant refresh survives', async () => {
    const issue = await fetch(origin, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: 'synthetic-refresh-secret' }),
    });
    const transferred = (await issue.json()) as { refreshToken: string };
    const [refresh, revoke] = await Promise.all([
      fetch(origin, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: transferred.refreshToken }),
      }),
      fetch(`${origin}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: 'synthetic-refresh-secret' }),
      }),
    ]);
    expect([200, 401]).toContain(refresh.status);
    expect(revoke.status).toBe(200);
    expect(
      await client`SELECT count(*)::integer AS count FROM mobile_refresh_tokens WHERE session_id='mapped-session' AND revoked_at IS NULL`,
    ).toEqual([{ count: 0 }]);
  });

  it('web exchange requires explicit enrollment and preserves one lineage across cookie rotations', async () => {
    const now = Date.now();
    const proof = {
      kind: 'web-session' as const,
      userId: 'source',
      credentialId: consolidationWebCredentialId('source', 'old-sid'),
      sessionId: 'old-sid',
      issuedAtMs: now - 10000,
      expiresAtMs: now + 60000,
      authenticatedAtMs: null,
      sourceGeneration: 2,
      revoked: false,
      revocationLineageVerified: true,
    };
    const exchange = () =>
      drizzle(client).transaction((tx) =>
        exchangeVerifiedConsolidationWebSession(tx, proof, async (decision, sid) => ({
          sid,
          authenticatedAt: decision.authenticatedAtMs,
        })),
      );
    await expect(exchange()).rejects.toMatchObject({ code: 'INELIGIBLE' });
    await drizzle(client)
      .insert(accountConsolidationSessionProofs)
      .values({
        credentialId: proof.credentialId,
        sourceUserId: 'source',
        mergeId: 'merge',
        kind: 'web-session',
        canonicalSessionId: 'mapped-web',
        expiresAt: new Date(proof.expiresAtMs),
      });
    await expect(exchange()).resolves.toEqual({ sid: 'mapped-web', authenticatedAt: null });
    await expect(exchange()).resolves.toEqual({ sid: 'mapped-web', authenticatedAt: null });
    await drizzle(client).transaction((tx) => revokeConsolidationWebSession(tx, 'mapped-web'));
    await expect(exchange()).rejects.toMatchObject({ code: 'INELIGIBLE' });
  });

  it('authentication finalization retains canonical password, moves provider link and enrolls existing refresh proof', async () => {
    await client`DELETE FROM account_consolidation_session_proofs`;
    await client`DELETE FROM account_consolidation_members`;
    await client`UPDATE auth_subject_cutoffs SET generation=2,deleted_at=NULL WHERE user_id='source'`;
    await client`UPDATE users SET email=CASE WHEN id='source' THEN 'Case@example.test' ELSE 'case@example.test' END`;
    await client`INSERT INTO user_credentials(user_id,password_hash) VALUES('source','old-secret-hash'),('target','canonical-secret-hash')`;
    await client`INSERT INTO accounts VALUES('source','oauth','google','synthetic-subject')`;
    const result = await drizzle(client).transaction((tx) =>
      authenticationConsolidationHandler().apply(tx, {
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
          preserveProviderLinks: [{ fromUserId: 'source', providers: ['google'] }],
          memberFingerprint: 'fingerprint',
          tickMerges: [],
          blockers: [],
        },
      }),
    );
    expect(result).toMatchObject({
      retiredSubjects: 1,
      enrolledNativeProofs: 1,
      sourcePasswordsRemoved: 1,
      providerLinks: 1,
    });
    expect(await client`SELECT user_id,password_hash FROM user_credentials`).toEqual([
      { user_id: 'target', password_hash: 'canonical-secret-hash' },
    ]);
    expect(await client`SELECT "userId" FROM accounts`).toEqual([{ userId: 'target' }]);
    expect(
      await client`SELECT generation,native_generation,deleted_at IS NOT NULL AS retired FROM auth_subject_cutoffs WHERE user_id='target'`,
    ).toEqual([{ generation: 7, native_generation: 8, retired: false }]);
    expect(
      await client`SELECT email LIKE '%@retired.boardsesh.invalid' AS retired FROM users WHERE id='source'`,
    ).toEqual([{ retired: true }]);
  });

  it('canonical signout invalidates pending bridge even without changing generations', async () => {
    await drizzle(client).transaction((tx) => revokeConsolidationTargetNativeBridges(tx, 'target'));
    await expect(transfer()).rejects.toMatchObject({ code: 'INELIGIBLE' });
  });
});
