import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import postgres from 'postgres';
import { compare, hash } from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { DbInstance } from '@boardsesh/db/client';
import {
  AUTH_PROTOCOL_VERSION,
  SET_PASSWORD_COMPATIBILITY_PATH,
  setPasswordCompatibilityReplySchema,
  type SetPasswordCompatibilityCommand,
} from '@boardsesh/auth-protocol';
import {
  users,
  userCredentials,
  authSubjectCutoffs,
  authSessionDenials,
  authPasswordChangeEvidence,
  authEmailProjection,
  authPreEnforcementPasswordResetEvents,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import {
  createCredentialWriterEnvironment,
  ownedCredentialProofUrl,
  grantOwnedCredentialWriterCapabilities,
} from './fixtures/credential-writer-environment';
import { EncryptJWT, hkdf, type JWTPayload } from './fixtures/legacy-jwe-crypto';
import { getCredentialDatabase, closeCredentialDatabase } from '../../credential-database';
import { startPostgresCommitAckFault, startPostgresTransactionAckFault } from './fixtures/postgres-commit-ack-fault';
import { handleCurrentStoreSetPasswordCompatibility } from '../../../handlers/current-store-set-password-compatibility';
import {
  createSetPasswordCompatibilityGuards,
  type SetPasswordCompatibilityGuards,
} from '../../current-store/set-password-compatibility-limits';
import { handleCurrentStoreRecovery } from '../../../handlers/current-store-recovery';
import { lockAuthorityGateExclusively } from '../../current-store/foundation-context';
import { prepareProjectionUnderUsersTableLock } from '../../current-store/email-reservations';
import {
  createApp,
  attachPartnerState,
  readPartnerState,
  countsOf,
  INTACT_COUNTS,
  REVOKED_COUNTS,
} from '../../partner/__tests__/revocation-fixtures';

const hooks = vi.hoisted(() => ({
  afterHash: undefined as (() => Promise<void>) | undefined,
  afterDecryptFailure: undefined as (() => Promise<void>) | undefined,
  hashCalls: 0,
  fixtureDatabase: undefined as DbInstance | undefined,
  allowFixtureIo: false,
}));
vi.mock('bcryptjs', async (original) => {
  const actual = await original<typeof import('bcryptjs')>();
  return {
    ...actual,
    hash: async (password: string, cost: number | string) => {
      const result = await actual.hash(password, cost);
      hooks.hashCalls += 1;
      await hooks.afterHash?.();
      return result;
    },
  };
});
vi.mock('../../legacy-web-jwe', async (original) => {
  const actual = await original<typeof import('../../legacy-web-jwe')>();
  return {
    ...actual,
    decryptLegacyWebJwe: async (...arguments_: Parameters<typeof actual.decryptLegacyWebJwe>) => {
      try {
        return await actual.decryptLegacyWebJwe(...arguments_);
      } catch (error) {
        await hooks.afterDecryptFailure?.();
        throw error;
      }
    },
  };
});
vi.mock('../../../db/client', () => ({
  db: new Proxy(
    {},
    {
      get(_target, property) {
        if (!hooks.allowFixtureIo || !hooks.fixtureDatabase) throw new Error('UNEXPECTED_CONTENT_CREDENTIAL_DATABASE');
        const member: unknown = Reflect.get(hooks.fixtureDatabase, property);
        return typeof member === 'function' ? member.bind(hooks.fixtureDatabase) : member;
      },
    },
  ),
}));

const rpcSecret = 'owned-set-password-private-command-secret-6975';
const jwtSecret = 'owned-set-password-legacy-jwe-secret-6975';
const chosenPassword = ' raw set password e\u0301 ';
const copyName = `epic6975_identity_import_${randomUUID().replaceAll('-', '')}`;
let fixture: Awaited<ReturnType<typeof createCredentialWriterEnvironment>>;
let admin: postgres.Sql;
let server: Server;
let origin: string;
let key: Uint8Array;
let guards: SetPasswordCompatibilityGuards;
let restoreGrants = false;
const active = new Set<Promise<void>>();
async function fixtureIo<Result>(work: () => Promise<Result>): Promise<Result> {
  hooks.allowFixtureIo = true;
  try {
    return await work();
  } finally {
    hooks.allowFixtureIo = false;
  }
}
async function seed() {
  const userId = randomUUID();
  const email = `${userId}@example.test`;
  await fixture.ownerDatabase
    .insert(users)
    .values({ id: userId, email, name: 'Synthetic climber', createdAt: new Date('2020-01-01'), emailVerified: null });
  return { userId, email };
}
async function source(userId: string, overrides: Record<string, unknown> = {}, omitted: readonly string[] = []) {
  const now = Math.floor(Date.now() / 1000);
  const claims: JWTPayload = {
    sub: userId,
    iat: now - 3600,
    exp: now + 3600,
    jti: randomUUID(),
    authSessionId: randomUUID(),
    gen: 0,
    auth_time: now - 86400,
    ...overrides,
  };
  for (const name of omitted) delete claims[name];
  const credential = await new EncryptJWT(claims).setProtectedHeader({ alg: 'dir', enc: 'A256GCM' }).encrypt(key);
  const authSessionId = claims.authSessionId
    ? typeof claims.authSessionId === 'string'
      ? claims.authSessionId
      : null
    : typeof claims.jti === 'string' && claims.jti
      ? claims.jti
      : randomUUID();
  return { credential, viewer: { userId, authSessionId }, claims };
}
function command(
  presented: Awaited<ReturnType<typeof source>>,
  password = chosenPassword,
): SetPasswordCompatibilityCommand {
  return {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation: 'set-password',
    requestId: randomUUID(),
    issuedAt: Date.now(),
    clientAddress: '198.51.100.70',
    payload: { credential: presented.credential, password, confirmPassword: password, viewer: presented.viewer },
  };
}
async function post(input: unknown, headers: Record<string, string> = {}, path = SET_PASSWORD_COMPATIBILITY_PATH) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${rpcSecret}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(input),
  });
  const body: unknown = await response.json();
  if (typeof body === 'object' && body !== null && 'protocolVersion' in body) {
    const reply = setPasswordCompatibilityReplySchema.parse(body);
    const requestId = typeof input === 'object' && input !== null && 'requestId' in input ? input.requestId : undefined;
    expect(reply).toMatchObject({ protocolVersion: 2, operation: 'set-password', requestId });
    // Literal independent matrix: production mapper is deliberately not the oracle.
    const status =
      reply.outcome === 'set'
        ? 200
        : reply.outcome === 'unauthenticated'
          ? 401
          : reply.outcome !== 'error'
            ? 409
            : reply.code === 'rate_limited'
              ? 429
              : reply.code === 'rolled_back'
                ? 500
                : 503;
    expect(response.status).toBe(status);
  }
  return { status: response.status, body, setCookies: response.headers.getSetCookie() };
}
async function counts() {
  const [row] = await fixture.owner<
    {
      credentials: number;
      claims: number;
      evidence: number;
      cutoffs: number;
      events: number;
      sessions: number;
      refresh: number;
    }[]
  >`SELECT (SELECT count(*)::integer FROM user_credentials) AS credentials,(SELECT count(*)::integer FROM "verificationTokens") AS claims,(SELECT count(*)::integer FROM auth_password_change_evidence) AS evidence,(SELECT count(*)::integer FROM auth_subject_cutoffs) AS cutoffs,(SELECT count(*)::integer FROM auth_security_mutation_events) AS events,(SELECT count(*)::integer FROM auth_session) AS sessions,(SELECT count(*)::integer FROM mobile_refresh_tokens) AS refresh`;
  return row;
}
async function evidenceOn() {
  await closeCredentialDatabase();
  await grantOwnedCredentialWriterCapabilities(fixture.owner, 'private-registration-evidence-v1');
  restoreGrants = true;
  vi.stubEnv('AUTH_IDENTITY_DATABASE_CONTRACT', 'private-registration-evidence-v1');
  vi.stubEnv('AUTH_PASSWORD_CHANGE_EVIDENCE_MODE', 'on');
}

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function holdTable(table: 'auth_session_denials' | 'auth_password_change_evidence' | 'oauth_access_token') {
  const entered = latch();
  const released = latch();
  const pending = fixture.owner.begin(async (transaction) => {
    await transaction.unsafe(`LOCK TABLE public."${table}" IN ACCESS EXCLUSIVE MODE`);
    entered.release();
    await released.promise;
  });
  await entered.promise;
  return {
    release: async () => {
      released.release();
      await pending;
    },
  };
}
async function waitForBlockedQuery(fragment: string) {
  const expires = performance.now() + 6000;
  while (performance.now() < expires) {
    const [row] = await fixture.owner<
      { waiting: boolean }[]
    >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=${fixture.databaseName} AND usename='boardsesh_identity_writer' AND wait_event_type='Lock' AND query ILIKE ${'%' + fragment + '%'}) AS waiting`;
    if (row?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('OWNED_WRITER_DID_NOT_REACH_LOCK');
}
async function waitForDatabaseTime(milliseconds: number) {
  while (true) {
    const [row] = await fixture.owner<
      { reached: boolean }[]
    >`SELECT clock_timestamp() >= to_timestamp(${milliseconds}/1000.0) AS reached`;
    if (row?.reached) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function holdRow(userId: string) {
  const entered = latch();
  const released = latch();
  const pending = fixture.owner.begin(async (transaction) => {
    await transaction`SELECT id FROM public.users WHERE id=${userId} FOR UPDATE`;
    entered.release();
    await released.promise;
  });
  await entered.promise;
  return {
    release: async () => {
      released.release();
      await pending;
    },
  };
}
async function installInsertBarrier() {
  await getCredentialDatabase('private-registration-v1');
  await fixture.owner.unsafe(
    `CREATE FUNCTION public.owned_set_password_insert_barrier() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN PERFORM pg_catalog.pg_advisory_xact_lock(6975,7783); RETURN NEW; END $$`,
  );
  await fixture.owner.unsafe(
    `CREATE TRIGGER z_owned_set_password_insert_barrier BEFORE INSERT ON public.user_credentials FOR EACH ROW EXECUTE FUNCTION public.owned_set_password_insert_barrier()`,
  );
  const entered = latch();
  const released = latch();
  const pending = fixture.owner.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(6975,7783)`;
    entered.release();
    await released.promise;
  });
  await entered.promise;
  return {
    release: async () => {
      released.release();
      await pending;
    },
    cleanup: async () => {
      released.release();
      await pending;
      await fixture.owner.unsafe('DROP TRIGGER z_owned_set_password_insert_barrier ON public.user_credentials');
      await fixture.owner.unsafe('DROP FUNCTION public.owned_set_password_insert_barrier()');
    },
  };
}
async function privateRecovery(operation: 'forgot-password' | 'reset-password', payload: unknown) {
  const response = await fetch(`${origin}/api/internal/auth/current-store/recovery/v1/${operation}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${rpcSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      protocolVersion: 2,
      operation,
      requestId: randomUUID(),
      issuedAt: Date.now(),
      clientAddress: '8.8.8.91',
      payload,
    }),
  });
  const body: unknown = await response.json();
  return { status: response.status, body };
}

describe('default set-password private family through actual qualified LOGIN and owned PostgreSQL18', () => {
  beforeAll(async () => {
    const target = ownedCredentialProofUrl();
    const template = target.pathname.slice(1);
    target.pathname = '/postgres';
    admin = postgres(target.toString(), { max: 2, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE "${copyName}" TEMPLATE "${template}"`);
    fixture = await createCredentialWriterEnvironment('private-registration-v1', { copyDatabase: copyName });
    hooks.fixtureDatabase = fixture.ownerDatabase;
    key = await hkdf('sha256', jwtSecret, '', 'NextAuth.js Generated Encryption Key', 32);
    server = createServer((request, response) => {
      const pending = (
        request.url?.startsWith('/api/internal/auth/current-store/recovery/v1/')
          ? handleCurrentStoreRecovery(request, response)
          : handleCurrentStoreSetPasswordCompatibility(request, response, undefined, guards)
      ).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
      active.add(pending);
      void pending.finally(() => active.delete(pending));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('OWNED_SET_PASSWORD_HTTP_REQUIRED');
    origin = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(async () => {
    await closeCredentialDatabase();
    hooks.afterHash = undefined;
    hooks.afterDecryptFailure = undefined;
    hooks.hashCalls = 0;
    await fixture.owner`DELETE FROM public.users`;
    await fixture.owner.unsafe(
      'TRUNCATE auth_email_projection,auth_subject_cutoffs,auth_session_denials,auth_security_mutation_events,auth_pre_enforcement_password_reset_events,"verificationTokens" CASCADE',
    );
    for (const [name, content] of Object.entries({
      DATABASE_URL: fixture.legacyUrl,
      AUTH_IDENTITY_DATABASE_URL: fixture.writerUrl,
      AUTH_IDENTITY_DATABASE_CONTRACT: 'private-registration-v1',
      CURRENT_STORE_AUTH_RPC_SECRET: rpcSecret,
      NEXTAUTH_SECRET: jwtSecret,
      AUTH_BROWSER_SESSION_MODE: 'legacy',
      CURRENT_STORE_SET_PASSWORD_MODE: 'legacy',
      AUTH_IDENTITY_MIRROR: 'off',
      AUTH_CUTOFF_ENFORCEMENT: 'enforce',
      AUTH_PASSWORD_CHANGE_EVIDENCE_MODE: 'off',
      DEBUG_SQL: 'false',
      AUTH_ACCOUNT_GUESS_LIMIT_MODE: 'off',
    }))
      vi.stubEnv(name, content);
    guards = createSetPasswordCompatibilityGuards({ redis: () => null });
  });
  afterEach(async () => {
    hooks.afterHash = undefined;
    hooks.afterDecryptFailure = undefined;
    await Promise.allSettled(active);
    await closeCredentialDatabase();
    if (restoreGrants) {
      await fixture.resetGrants();
      restoreGrants = false;
    }
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await fixture.close();
    await admin.unsafe(`DROP DATABASE "${copyName}" WITH (FORCE)`);
    await admin.end();
  });

  it('commits real cost12 raw password, NULL-only compatibility stamp and actual partner revocation; no first-party mutation', async () => {
    const climber = await seed();
    const sibling = await seed();
    const developer = await seed();
    const { selected, unrelated } = await fixtureIo(async () => {
      const app = await createApp(developer.userId);
      return {
        selected: await attachPartnerState(climber.userId, app),
        unrelated: await attachPartnerState(sibling.userId, app),
      };
    });
    const input = command(await source(climber.userId));
    const reply = await post(input);
    expect(reply).toMatchObject({ status: 200, body: { outcome: 'set' }, setCookies: [] });
    const [credential] = await fixture.ownerDatabase
      .select()
      .from(userCredentials)
      .where(eq(userCredentials.userId, climber.userId));
    expect(credential.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(await compare(chosenPassword, credential.passwordHash)).toBe(true);
    const [user] = await fixture.ownerDatabase.select().from(users).where(eq(users.id, climber.userId));
    expect(user.emailVerified).toBeInstanceOf(Date);
    expect(await fixtureIo(async () => countsOf(await readPartnerState(selected)))).toEqual(REVOKED_COUNTS);
    expect(await fixtureIo(async () => countsOf(await readPartnerState(unrelated)))).toEqual(INTACT_COUNTS);
    expect(await counts()).toEqual({
      credentials: 1,
      claims: 1,
      evidence: 0,
      cutoffs: 0,
      events: 0,
      sessions: 0,
      refresh: 0,
    });
  });
  it('nonce-aware already-set precheck skips bcrypt without bypassing committed replay503', async () => {
    const climber = await seed();
    const input = command(await source(climber.userId));
    expect((await post(input)).status).toBe(200);
    expect(await post(input)).toMatchObject({ status: 503, body: { outcome: 'error', code: 'replayed' } });
    expect(await post({ ...input, requestId: randomUUID() })).toMatchObject({
      status: 409,
      body: { outcome: 'already_set' },
    });
    expect(hooks.hashCalls).toBe(1);
    expect((await counts())?.claims).toBe(2);
  });
  it('prepared snapshot is a truthful context, not an enforced reservation', async () => {
    const climber = await seed();
    await fixture.ownerDatabase.transaction((transaction) =>
      prepareProjectionUnderUsersTableLock(transaction, { projectionId: randomUUID() }),
    );
    expect((await post(command(await source(climber.userId)))).status).toBe(200);
  });
  it.each([
    { name: 'missing-exp', overrides: {}, omitted: ['exp'] },
    { name: 'missing-iat', overrides: {}, omitted: ['iat'] },
    { name: 'missing-exp-iat', overrides: {}, omitted: ['exp', 'iat'] },
    { name: 'future-iat', overrides: { iat: Math.floor(Date.now() / 1000) + 3600 }, omitted: [] },
    { name: 'missing-gen-is-zero', overrides: {}, omitted: ['gen'] },
    { name: 'null-gen-is-zero', overrides: { gen: null }, omitted: [] },
    { name: 'missing-age', overrides: {}, omitted: ['auth_time'] },
    { name: 'null-age', overrides: { auth_time: null }, omitted: [] },
    { name: 'missing-sid-jti', overrides: {}, omitted: ['authSessionId'] },
    { name: 'null-sid-jti', overrides: { authSessionId: null }, omitted: [] },
    { name: 'false-sid-jti', overrides: { authSessionId: false }, omitted: [] },
    { name: 'truthy-invalid-sid', overrides: { authSessionId: 7 }, omitted: [] },
    { name: 'missing-sid-jti-both-service-display-only', overrides: {}, omitted: ['authSessionId', 'jti'] },
  ])(
    'preserves source-accepted synthetic cohort $name without freshness/lineage invention',
    async ({ overrides, omitted }) => {
      const climber = await seed();
      const input = command(await source(climber.userId, overrides, omitted));
      expect(await post(input)).toMatchObject({ status: 200, body: { outcome: 'set' }, setCookies: [] });
      expect(await counts()).toEqual({
        credentials: 1,
        claims: 1,
        evidence: 0,
        cutoffs: 0,
        events: 0,
        sessions: 0,
        refresh: 0,
      });
    },
  );
  it.each(['generation', 'denial', 'deleted', 'malformed-generation', 'expired', 'null-exp', 'wrong-viewer'])(
    'refuses %s using raw source/current primary state',
    async (kind) => {
      const climber = await seed();
      const presented = await source(
        climber.userId,
        kind === 'malformed-generation'
          ? { gen: '0' }
          : kind === 'expired'
            ? { exp: Math.floor(Date.now() / 1000) - 15 }
            : kind === 'null-exp'
              ? { exp: null }
              : {},
      );
      if (kind === 'generation' || kind === 'deleted')
        await fixture.ownerDatabase.insert(authSubjectCutoffs).values({
          userId: climber.userId,
          generation: kind === 'generation' ? 1 : 0,
          nativeGeneration: 0,
          revokedThrough: new Date(0),
          lastOperationId: randomUUID(),
          ...(kind === 'deleted' ? { deletedAt: new Date() } : {}),
        });
      if (kind === 'denial')
        await fixture.ownerDatabase.insert(authSessionDenials).values({
          userId: climber.userId,
          sessionId: presented.viewer.authSessionId ?? '',
          expiresAt: new Date(Date.now() + 3600000),
        });
      const input = command(presented);
      if (kind === 'wrong-viewer') input.payload.viewer.userId = randomUUID();
      expect(await post(input)).toMatchObject({
        status: kind === 'wrong-viewer' ? 409 : 401,
        body: { outcome: kind === 'wrong-viewer' ? 'identity_changed' : 'unauthenticated' },
      });
      expect((await counts())?.credentials).toBe(0);
      expect((await counts())?.claims).toBe(0);
      expect(hooks.hashCalls).toBe(0);
    },
  );
  it.each([
    ['AUTH_BROWSER_SESSION_MODE', 'better-auth'],
    ['CURRENT_STORE_SET_PASSWORD_MODE', 'backend-staging'],
    ['AUTH_IDENTITY_MIRROR', 'on'],
    ['AUTH_IDENTITY_MIRROR', 'typo'],
    ['AUTH_CUTOFF_ENFORCEMENT', 'observe'],
    ['DEBUG_SQL', 'true'],
    ['AUTH_PASSWORD_CHANGE_EVIDENCE_MODE', 'typo'],
    ['NEXTAUTH_SECRET', ''],
  ])('backend-owned scope %s=%s refuses before hashing/mutation', async (name, content) => {
    const climber = await seed();
    const input = command(await source(climber.userId));
    vi.stubEnv(name, content);
    expect(await post(input)).toMatchObject({ status: 503, body: { error: 'disabled' } });
    expect((await counts())?.credentials).toBe(0);
    expect((await counts())?.claims).toBe(0);
    expect(hooks.hashCalls).toBe(0);
  });
  it('preserves characterized legacy/default provider-staging mismatch without activating policy', async () => {
    const climber = await seed();
    vi.stubEnv('CURRENT_STORE_PROVIDER_SECURITY_MODE', 'backend-staging');
    expect((await post(command(await source(climber.userId)))).status).toBe(200);
  });
  it('mode change during real bcrypt aborts without nonce/identity writes', async () => {
    const climber = await seed();
    hooks.afterHash = async () => {
      vi.stubEnv('AUTH_BROWSER_SESSION_MODE', 'better-auth');
    };
    expect(await post(command(await source(climber.userId)))).toMatchObject({
      status: 503,
      body: { code: 'unavailable' },
    });
    expect((await counts())?.credentials).toBe(0);
    expect((await counts())?.claims).toBe(0);
  });
  it('evidence off performs no evidence relation I/O under a role forbidden to read it', async () => {
    const climber = await seed();
    await expect(fixture.writer`SELECT user_id FROM auth_password_change_evidence`).rejects.toMatchObject({
      code: '42501',
    });
    expect((await post(command(await source(climber.userId)))).status).toBe(200);
    expect((await counts())?.evidence).toBe(0);
  });
  it('evidence on binds actual stored hash and DB time atomically without changing generation', async () => {
    const climber = await seed();
    await evidenceOn();
    const before = Date.now();
    expect((await post(command(await source(climber.userId)))).status).toBe(200);
    const [credential] = await fixture.ownerDatabase
      .select()
      .from(userCredentials)
      .where(eq(userCredentials.userId, climber.userId));
    const [evidence] = await fixture.ownerDatabase
      .select()
      .from(authPasswordChangeEvidence)
      .where(eq(authPasswordChangeEvidence.userId, climber.userId));
    expect(evidence.passwordFingerprint).toBe(createHash('sha256').update(credential.passwordHash).digest('hex'));
    expect(evidence.changedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(evidence.changedAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect((await counts())?.cutoffs).toBe(0);
  });
  it('actual users CHECK failure returns confirmed rollback500 and undoes partner/credential/nonce effects', async () => {
    const climber = await seed();
    const developer = await seed();
    const partner = await fixtureIo(async () => attachPartnerState(climber.userId, await createApp(developer.userId)));
    await getCredentialDatabase('private-registration-v1');
    await fixture.owner.unsafe(
      'ALTER TABLE users ADD CONSTRAINT owned_set_password_verification_failure CHECK ("emailVerified" IS NULL) NOT VALID',
    );
    try {
      expect(await post(command(await source(climber.userId)))).toMatchObject({
        status: 500,
        body: { code: 'rolled_back' },
      });
      expect((await counts())?.credentials).toBe(0);
      expect((await counts())?.claims).toBe(0);
      expect(await fixtureIo(async () => countsOf(await readPartnerState(partner)))).toEqual(INTACT_COUNTS);
    } finally {
      await fixture.owner.unsafe('ALTER TABLE users DROP CONSTRAINT owned_set_password_verification_failure');
    }
  });
  it('actual evidence CHECK failure500 rolls back password, verification, evidence and nonce', async () => {
    const climber = await seed();
    await evidenceOn();
    await getCredentialDatabase('private-registration-evidence-v1');
    await fixture.owner.unsafe(
      'ALTER TABLE auth_password_change_evidence ADD CONSTRAINT owned_set_password_evidence_failure CHECK (false) NOT VALID',
    );
    try {
      expect(await post(command(await source(climber.userId)))).toMatchObject({
        status: 500,
        body: { code: 'rolled_back' },
      });
      expect(await counts()).toEqual({
        credentials: 0,
        claims: 0,
        evidence: 0,
        cutoffs: 0,
        events: 0,
        sessions: 0,
        refresh: 0,
      });
      const [user] = await fixture.ownerDatabase.select().from(users).where(eq(users.id, climber.userId));
      expect(user.emailVerified).toBeNull();
    } finally {
      await fixture.owner.unsafe(
        'ALTER TABLE auth_password_change_evidence DROP CONSTRAINT owned_set_password_evidence_failure',
      );
    }
  });
  it('preserves prior verification timestamp and updatedAt instead of stamping them again', async () => {
    const climber = await seed();
    const verified = new Date('2019-03-02T01:02:03.000Z');
    const updated = new Date('2020-04-03T02:03:04.000Z');
    await fixture.ownerDatabase
      .update(users)
      .set({ emailVerified: verified, updatedAt: updated })
      .where(eq(users.id, climber.userId));
    expect((await post(command(await source(climber.userId)))).status).toBe(200);
    const [current] = await fixture.ownerDatabase.select().from(users).where(eq(users.id, climber.userId));
    expect(current.emailVerified).toEqual(verified);
    expect(current.updatedAt).toEqual(updated);
  });
  it.each([
    'missing-bearer',
    'origin',
    'media-type',
    'wrong-path',
    'wrong-operation',
    'old-protocol',
    'invalid-request-id',
    'stale-issued-at',
    'body-chosen-viewer-context',
  ])('strict private admission %s has no hash/identity/nonce work', async (variant) => {
    const climber = await seed();
    const input = command(await source(climber.userId));
    let submitted: unknown = input;
    const headers: Record<string, string> = {};
    let path = SET_PASSWORD_COMPATIBILITY_PATH;
    if (variant === 'missing-bearer') headers.authorization = '';
    if (variant === 'origin') headers.origin = 'https://www.boardsesh.com';
    if (variant === 'media-type') headers['content-type'] = 'text/plain';
    if (variant === 'wrong-path') path += '/not-an-operation';
    if (variant === 'wrong-operation') submitted = { ...input, operation: 'password' };
    if (variant === 'old-protocol') submitted = { ...input, protocolVersion: 1 };
    if (variant === 'invalid-request-id') submitted = { ...input, requestId: 'not-a-command-id' };
    if (variant === 'stale-issued-at') submitted = { ...input, issuedAt: Date.now() - 130000 };
    if (variant === 'body-chosen-viewer-context')
      submitted = {
        ...input,
        payload: { ...input.payload, viewer: { ...input.payload.viewer, clientAddress: '8.8.8.8' } },
      };
    // Missing DB config is a witness that admission must precede qualification.
    vi.stubEnv('AUTH_IDENTITY_DATABASE_URL', '');
    const expected = variant === 'missing-bearer' || variant === 'origin' ? 401 : variant === 'wrong-path' ? 404 : 400;
    const result = await post(submitted, headers, path);
    expect(result.status).toBe(expected);
    expect(hooks.hashCalls).toBe(0);
    expect((await counts())?.credentials).toBe(0);
    expect((await counts())?.claims).toBe(0);
  });
  it.each([
    { label: 'three-byte-BMP', password: '界'.repeat(128), bytes: 65535 },
    { label: 'three-byte-BMP', password: '界'.repeat(128), bytes: 65536 },
    { label: 'three-byte-BMP', password: '界'.repeat(128), bytes: 65537 },
    { label: 'JSON-escaped-control', password: '\u0000'.repeat(128), bytes: 65535 },
    { label: 'JSON-escaped-control', password: '\u0000'.repeat(128), bytes: 65536 },
    { label: 'JSON-escaped-control', password: '\u0000'.repeat(128), bytes: 65537 },
  ])('receiver exact UTF8 budget $label $bytes bytes', async ({ password, bytes }) => {
    const climber = await seed();
    const input = command(await source(climber.userId), password);
    const serialized = JSON.stringify(input);
    const body = serialized + ' '.repeat(bytes - Buffer.byteLength(serialized));
    expect(Buffer.byteLength(body)).toBe(bytes);
    const pending = fetch(`${origin}${SET_PASSWORD_COMPATIBILITY_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${rpcSecret}`, 'content-type': 'application/json' },
      body,
    });
    if (bytes > 65536) {
      await expect(pending).rejects.toBeInstanceOf(TypeError);
      await Promise.allSettled(active);
      expect((await counts())?.credentials).toBe(0);
      expect((await counts())?.claims).toBe(0);
    } else {
      const response = await pending;
      expect(response.status).toBe(200);
      expect(setPasswordCompatibilityReplySchema.parse(await response.json()).outcome).toBe('set');
      const [credential] = await fixture.ownerDatabase
        .select()
        .from(userCredentials)
        .where(eq(userCredentials.userId, climber.userId));
      expect(await compare(password, credential.passwordHash)).toBe(true);
    }
  });
  it('fresh DB clock after a blocked final-state read refuses expiry and leaves no mutation', async () => {
    const climber = await seed();
    await getCredentialDatabase('private-registration-v1');
    const expiry = Math.floor(Date.now() / 1000) - 12;
    const input = command(await source(climber.userId, { exp: expiry }));
    let held: Awaited<ReturnType<typeof holdTable>> | undefined;
    const lockReady = latch();
    hooks.afterHash = async () => {
      held = await holdTable('auth_session_denials');
      lockReady.release();
    };
    const pending = post(input);
    try {
      await lockReady.promise;
      await waitForBlockedQuery('auth_session_denials');
      await waitForDatabaseTime((expiry + 15) * 1000 + 10);
    } finally {
      await held?.release();
    }
    expect(await pending).toMatchObject({ status: 401, body: { outcome: 'unauthenticated' } });
    expect((await counts())?.credentials).toBe(0);
    expect((await counts())?.claims).toBe(0);
  });
  it('actual INSERT partner-trigger lock timeout is unavailable503, with all effects rolled back', async () => {
    const climber = await seed();
    const developer = await seed();
    const partner = await fixtureIo(async () => attachPartnerState(climber.userId, await createApp(developer.userId)));
    await getCredentialDatabase('private-registration-v1');
    const held = await holdTable('oauth_access_token');
    let result;
    try {
      result = await post(command(await source(climber.userId)));
    } finally {
      await held.release();
    }
    expect(result).toMatchObject({ status: 503, body: { code: 'unavailable' } });
    expect((await counts())?.credentials).toBe(0);
    expect((await counts())?.claims).toBe(0);
    expect(await fixtureIo(async () => countsOf(await readPartnerState(partner)))).toEqual(INTACT_COUNTS);
  });
  it('actual evidence SQL lock timeout503 rolls back credential, verification, evidence and nonce', async () => {
    const climber = await seed();
    await evidenceOn();
    await getCredentialDatabase('private-registration-evidence-v1');
    const held = await holdTable('auth_password_change_evidence');
    let result;
    try {
      result = await post(command(await source(climber.userId)));
    } finally {
      await held.release();
    }
    expect(result).toMatchObject({ status: 503, body: { code: 'unavailable' } });
    expect(await counts()).toEqual({
      credentials: 0,
      claims: 0,
      evidence: 0,
      cutoffs: 0,
      events: 0,
      sessions: 0,
      refresh: 0,
    });
  });
  it('captured evidence mode changing during real evidence SQL aborts without partial capture', async () => {
    const climber = await seed();
    await evidenceOn();
    await getCredentialDatabase('private-registration-evidence-v1');
    const held = await holdTable('auth_password_change_evidence');
    const pending = post(command(await source(climber.userId)));
    try {
      await waitForBlockedQuery('auth_password_change_evidence');
      vi.stubEnv('AUTH_PASSWORD_CHANGE_EVIDENCE_MODE', 'off');
    } finally {
      await held.release();
    }
    expect(await pending).toMatchObject({ status: 503, body: { code: 'unavailable' } });
    expect(await counts()).toEqual({
      credentials: 0,
      claims: 0,
      evidence: 0,
      cutoffs: 0,
      events: 0,
      sessions: 0,
      refresh: 0,
    });
  });
  it('lost real COMMIT acknowledgement is503 while committed nonce makes the same command replay503', async () => {
    const climber = await seed();
    const proxy = await startPostgresCommitAckFault(fixture.writerUrl);
    const writerUrl = new URL(fixture.writerUrl);
    writerUrl.port = String(proxy.port);
    const contentUrl = new URL(fixture.legacyUrl);
    contentUrl.port = String(proxy.port);
    vi.stubEnv('AUTH_IDENTITY_DATABASE_URL', writerUrl.toString());
    vi.stubEnv('DATABASE_URL', contentUrl.toString());
    const input = command(await source(climber.userId));
    hooks.afterHash = async () => {
      hooks.afterHash = undefined;
      hooks.afterDecryptFailure = undefined;
      proxy.arm();
    };
    try {
      expect(await post(input)).toMatchObject({ status: 503, body: { code: 'unavailable' } });
      expect(proxy.dropped()).toBe(true);
      expect((await counts())?.credentials).toBe(1);
      expect((await counts())?.claims).toBe(1);
      expect(await post(input)).toMatchObject({ status: 503, body: { code: 'replayed' } });
      expect(await post({ ...input, requestId: randomUUID() })).toMatchObject({
        status: 409,
        body: { outcome: 'already_set' },
      });
      expect(hooks.hashCalls).toBe(1);
    } finally {
      await closeCredentialDatabase();
      await proxy.close();
    }
  });
  it('a genuine private recovery reset during hash wins, and stale raw G0 never overwrites it', async () => {
    const climber = await seed();
    await grantOwnedCredentialWriterCapabilities(fixture.owner, 'private-recovery-v1');
    restoreGrants = true;
    vi.stubEnv('AUTH_IDENTITY_DATABASE_CONTRACT', 'private-recovery-v1');
    const input = command(await source(climber.userId));
    const resetPassword = 'actual recovery won this race';
    hooks.afterHash = async () => {
      hooks.afterHash = undefined;
      await fixture.ownerDatabase
        .insert(userCredentials)
        .values({ userId: climber.userId, passwordHash: await hash('concurrent first password', 4) });
      const forgot = await privateRecovery('forgot-password', { email: climber.email });
      expect(forgot.status).toBe(200);
      if (
        typeof forgot.body !== 'object' ||
        forgot.body === null ||
        !('mailPlan' in forgot.body) ||
        typeof forgot.body.mailPlan !== 'object' ||
        forgot.body.mailPlan === null ||
        !('token' in forgot.body.mailPlan)
      )
        throw new Error('ACTUAL_RECOVERY_PLAN_REQUIRED');
      const reset = await privateRecovery('reset-password', {
        email: climber.email,
        token: forgot.body.mailPlan.token,
        password: resetPassword,
        confirmPassword: resetPassword,
      });
      expect(reset.status).toBe(200);
      expect(reset.body).toMatchObject({ operation: 'reset-password', outcome: 'reset' });
    };
    expect(await post(input)).toMatchObject({ status: 401, body: { outcome: 'unauthenticated' } });
    const [credential] = await fixture.ownerDatabase
      .select()
      .from(userCredentials)
      .where(eq(userCredentials.userId, climber.userId));
    expect(await compare(resetPassword, credential.passwordHash)).toBe(true);
    const [cutoff] = await fixture.ownerDatabase
      .select()
      .from(authSubjectCutoffs)
      .where(eq(authSubjectCutoffs.userId, climber.userId));
    expect(cutoff.generation).toBe(1);
    expect((await fixture.ownerDatabase.select().from(authPreEnforcementPasswordResetEvents)).length).toBe(1);
  });
  it('absent to prepared transition during bcrypt refuses old context, while new explicit action qualifies', async () => {
    const climber = await seed();
    const input = command(await source(climber.userId));
    hooks.afterHash = async () => {
      hooks.afterHash = undefined;
      await fixture.ownerDatabase.transaction((transaction) =>
        prepareProjectionUnderUsersTableLock(transaction, { projectionId: randomUUID() }),
      );
    };
    expect(await post(input)).toMatchObject({ status: 503, body: { code: 'unavailable' } });
    expect((await counts())?.credentials).toBe(0);
    expect((await counts())?.claims).toBe(0);
    expect((await post({ ...input, requestId: randomUUID(), issuedAt: Date.now() })).status).toBe(200);
  });
  it('held writer gate delays synthetic enforced transition; later default command refuses without writes', async () => {
    const climber = await seed();
    const projectionId = randomUUID();
    await fixture.ownerDatabase.transaction((transaction) =>
      prepareProjectionUnderUsersTableLock(transaction, { projectionId }),
    );
    const barrier = await installInsertBarrier();
    const input = command(await source(climber.userId));
    const pending = post(input);
    let transitioned = false;
    let transition: Promise<unknown> | undefined;
    try {
      await waitForBlockedQuery('insert into "user_credentials"');
      transition = fixture.ownerDatabase.transaction(async (transaction) => {
        await lockAuthorityGateExclusively(transaction);
        transitioned = true;
        await transaction
          .update(authEmailProjection)
          .set({ phase: 'enforced' })
          .where(eq(authEmailProjection.projectionId, projectionId));
      });
      const expires = performance.now() + 1500;
      while (performance.now() < expires) {
        const [row] = await admin<
          { waiting: boolean }[]
        >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=${fixture.databaseName} AND usename='postgres' AND wait_event_type='Lock' AND query ILIKE '%pg_advisory_xact_lock(%') AS waiting`;
        if (row?.waiting) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(transitioned).toBe(false);
      await barrier.release();
      expect((await pending).status).toBe(200);
      await transition;
      const hashesBefore = hooks.hashCalls;
      expect(await post({ ...input, requestId: randomUUID(), issuedAt: Date.now() })).toMatchObject({
        status: 503,
        body: { code: 'unavailable' },
      });
      expect(hooks.hashCalls).toBe(hashesBefore);
      expect((await counts())?.credentials).toBe(1);
    } finally {
      await barrier.cleanup();
      await transition;
      await pending;
    }
  });
  it('aborted active caller retains actual work slot until row-lock settlement and capacity then recovers', async () => {
    const climber = await seed();
    const unrelated = await seed();
    guards = createSetPasswordCompatibilityGuards({ redis: () => null, concurrency: 1, maxWaiting: 0 });
    await getCredentialDatabase('private-registration-v1');
    const held = await holdRow(climber.userId);
    const input = command(await source(climber.userId));
    const controller = new AbortController();
    const abandoned = fetch(`${origin}${SET_PASSWORD_COMPATIBILITY_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${rpcSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    try {
      await waitForBlockedQuery('for update');
      controller.abort();
      await expect(abandoned).rejects.toBeInstanceOf(Error);
      const unrelatedInput = command(await source(unrelated.userId));
      expect(await post(unrelatedInput)).toMatchObject({ status: 503, body: { code: 'unavailable' } });
      expect((await fixture.ownerDatabase.select().from(userCredentials)).length).toBe(0);
    } finally {
      await held.release();
    }
    await Promise.allSettled(active);
    expect((await counts())?.credentials).toBe(0);
    expect((await counts())?.claims).toBe(0);
    expect((await post(command(await source(unrelated.userId)))).status).toBe(200);
  });
  it('initial failed timed source cannot later become an unlocked already-set actor', async () => {
    const climber = await seed();
    await fixture.ownerDatabase
      .insert(userCredentials)
      .values({ userId: climber.userId, passwordHash: await hash('existing password', 4) });
    hooks.hashCalls = 0;
    await getCredentialDatabase('private-registration-v1');
    const notBefore = Math.floor(Date.now() / 1000) + 18;
    const input = command(await source(climber.userId, { nbf: notBefore }));
    let failures = 0;
    hooks.afterDecryptFailure = async () => {
      failures += 1;
      if (failures === 2) await waitForDatabaseTime((notBefore - 15) * 1000 + 10);
    };
    expect(await post(input)).toMatchObject({ status: 401, body: { outcome: 'unauthenticated' } });
    expect(failures).toBe(2);
    expect(hooks.hashCalls).toBe(0);
    expect((await counts())?.claims).toBe(0);
    const actualCrypto = await import('../../legacy-web-jwe');
    expect((await actualCrypto.decryptLegacyWebJwe(input.payload.credential, jwtSecret, 15)).payload.sub).toBe(
      climber.userId,
    );
  });
  it('actual losing INSERT rolls back its real BEFORE trigger effects before outer409 nonce commits', async () => {
    const climber = await seed();
    const developer = await seed();
    const partner = await fixtureIo(async () => attachPartnerState(climber.userId, await createApp(developer.userId)));
    const barrier = await installInsertBarrier();
    const input = command(await source(climber.userId));
    const pending = post(input);
    try {
      await waitForBlockedQuery('insert into "user_credentials"');
      // Privileged, scoped fault control ONLY: bypass winner FK/trigger so it can
      // create a real PK race despite the held parent lock. The tested loser
      // runs its actual normal INSERT+partner trigger+savepoint unchanged.
      await fixture.owner.begin(async (transaction) => {
        await transaction.unsafe("SET LOCAL session_replication_role = 'replica'");
        await transaction`INSERT INTO public.user_credentials(user_id,password_hash) VALUES (${climber.userId},'owned forced winner hash')`;
      });
      await barrier.release();
      expect(await pending).toMatchObject({ status: 409, body: { outcome: 'already_set' } });
      expect(await fixtureIo(async () => countsOf(await readPartnerState(partner)))).toEqual(INTACT_COUNTS);
      expect((await counts())?.claims).toBe(1);
      expect(await post(input)).toMatchObject({ status: 503, body: { code: 'replayed' } });
    } finally {
      await barrier.cleanup();
      await pending;
    }
  });
  it('unrelated trigger23505 is definite rollback500, never credential already-set409', async () => {
    const climber = await seed();
    const developer = await seed();
    const partner = await fixtureIo(async () => attachPartnerState(climber.userId, await createApp(developer.userId)));
    await fixture.ownerDatabase.insert(verificationTokens).values({
      identifier: 'owned-set-password-unique-fault',
      token: 'collision',
      expires: new Date(Date.now() + 3600000),
    });
    await getCredentialDatabase('private-registration-v1');
    await fixture.owner.unsafe(
      `CREATE FUNCTION public.owned_set_password_unique_fault() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN INSERT INTO public."verificationTokens"(identifier,token,expires) VALUES ('owned-set-password-unique-fault','collision',clock_timestamp()+interval '1 hour'); RETURN NEW; END $$`,
    );
    await fixture.owner.unsafe(
      `CREATE TRIGGER z_owned_set_password_unique_fault BEFORE INSERT ON public.user_credentials FOR EACH ROW EXECUTE FUNCTION public.owned_set_password_unique_fault()`,
    );
    try {
      expect(await post(command(await source(climber.userId)))).toMatchObject({
        status: 500,
        body: { code: 'rolled_back' },
      });
      expect((await counts())?.credentials).toBe(0);
      expect((await counts())?.claims).toBe(1);
      expect(await fixtureIo(async () => countsOf(await readPartnerState(partner)))).toEqual(INTACT_COUNTS);
    } finally {
      await fixture.owner.unsafe('DROP TRIGGER z_owned_set_password_unique_fault ON public.user_credentials');
      await fixture.owner.unsafe('DROP FUNCTION public.owned_set_password_unique_fault()');
    }
  });
  it('unexpected direct partner routine grant refuses actual profile before hash or write', async () => {
    const climber = await seed();
    await fixture.owner.unsafe(
      'GRANT EXECUTE ON FUNCTION public.partner_revoke_user(text) TO boardsesh_identity_writer',
    );
    restoreGrants = true;
    expect(await post(command(await source(climber.userId)))).toMatchObject({
      status: 503,
      body: { code: 'unavailable' },
    });
    expect(hooks.hashCalls).toBe(0);
    expect((await counts())?.credentials).toBe(0);
    expect((await counts())?.claims).toBe(0);
  });
  it('saturated unvouched budget and more than180 other vouched clients leave unrelated valid actor available', async () => {
    const climber = await seed();
    const valid = command(await source(climber.userId));
    const { clientAddress: _address, ...unvouched } = valid;
    for (let attempt = 0; attempt < 180; attempt += 1) {
      const input = {
        ...unvouched,
        requestId: randomUUID(),
        payload: { ...valid.payload, credential: 'not-a-valid-jwe' },
      };
      expect((await post(input)).status).toBe(401);
    }
    expect(await post({ ...unvouched, requestId: randomUUID() })).toMatchObject({
      status: 429,
      body: { code: 'rate_limited' },
    });
    for (let attempt = 1; attempt <= 181; attempt += 1) {
      const input = {
        ...valid,
        requestId: randomUUID(),
        clientAddress: `8.8.9.${attempt}`,
        payload: { ...valid.payload, credential: 'not-a-valid-jwe' },
      };
      expect((await post(input)).status).toBe(401);
    }
    expect(await post({ ...valid, clientAddress: '8.8.10.250' })).toMatchObject({
      status: 200,
      body: { outcome: 'set' },
    });
    expect(hooks.hashCalls).toBe(1);
    expect((await counts())?.credentials).toBe(1);
    expect((await counts())?.claims).toBe(1);
  });
  it.each([
    { label: 'inner savepoint', ordinal: 1 as const },
    { label: 'outer transaction', ordinal: 2 as const },
  ])('lost actual $label ROLLBACK acknowledgement stays503 with no partial mutation', async ({ ordinal }) => {
    const climber = await seed();
    const developer = await seed();
    const partner = await fixtureIo(async () => attachPartnerState(climber.userId, await createApp(developer.userId)));
    const proxy = await startPostgresTransactionAckFault(fixture.writerUrl, { acknowledgement: 'ROLLBACK', ordinal });
    const writerUrl = new URL(fixture.writerUrl);
    writerUrl.port = String(proxy.port);
    const contentUrl = new URL(fixture.legacyUrl);
    contentUrl.port = String(proxy.port);
    vi.stubEnv('AUTH_IDENTITY_DATABASE_URL', writerUrl.toString());
    vi.stubEnv('DATABASE_URL', contentUrl.toString());
    await getCredentialDatabase('private-registration-v1');
    await fixture.owner.unsafe(
      'ALTER TABLE users ADD CONSTRAINT owned_set_password_rollback_ack CHECK ("emailVerified" IS NULL) NOT VALID',
    );
    hooks.afterHash = async () => {
      hooks.afterHash = undefined;
      proxy.arm();
    };
    try {
      expect(await post(command(await source(climber.userId)))).toMatchObject({
        status: 503,
        body: { code: 'unavailable' },
      });
      expect(proxy.dropped()).toBe(true);
      expect(proxy.acknowledgements()).toBe(ordinal);
      expect((await counts())?.credentials).toBe(0);
      expect((await counts())?.claims).toBe(0);
      const [current] = await fixture.ownerDatabase.select().from(users).where(eq(users.id, climber.userId));
      expect(current.emailVerified).toBeNull();
      expect(await fixtureIo(async () => countsOf(await readPartnerState(partner)))).toEqual(INTACT_COUNTS);
    } finally {
      await closeCredentialDatabase();
      await proxy.close();
      await fixture.owner.unsafe('ALTER TABLE users DROP CONSTRAINT owned_set_password_rollback_ack');
    }
  });
  it('actual HTTP7s deadline retains the unsettled hash work slot until settlement and recovery', async () => {
    const climber = await seed();
    const unrelated = await seed();
    guards = createSetPasswordCompatibilityGuards({ redis: () => null, concurrency: 1, maxWaiting: 0 });
    const input = { ...command(await source(climber.userId)), clientAddress: '8.8.8.71' };
    const entered = latch();
    const released = latch();
    // Actual cost12 bcrypt completes; this explicit test barrier withholds its
    // promise's settlement. No CPU/DB/Redis outcome or authority is fabricated.
    hooks.afterHash = async () => {
      hooks.afterHash = undefined;
      entered.release();
      await released.promise;
    };
    const pending = post(input);
    try {
      await entered.promise;
      expect(await pending).toMatchObject({ status: 503, body: { code: 'unavailable' } });
      expect(guards.work('client').isFull()).toBe(true);
      const next = { ...command(await source(unrelated.userId)), clientAddress: '8.8.8.72' };
      expect(await post(next)).toMatchObject({ status: 503, body: { code: 'unavailable' } });
      expect((await counts())?.credentials).toBe(0);
      expect((await counts())?.claims).toBe(0);
    } finally {
      released.release();
    }
    const settledBy = performance.now() + 2000;
    while (guards.work('client').isFull() && performance.now() < settledBy)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(guards.work('client').isFull()).toBe(false);
    expect((await counts())?.credentials).toBe(0);
    expect((await counts())?.claims).toBe(0);
    expect((await post({ ...command(await source(unrelated.userId)), clientAddress: '8.8.8.72' })).status).toBe(200);
    expect(hooks.hashCalls).toBe(2);
  });
});
