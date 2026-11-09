import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql, type SQL } from 'drizzle-orm';
import {
  accounts,
  authEmailProjection,
  authEmailReservationMembers,
  authEmailReservations,
  authSecurityMutationEvents,
  authSubjectCutoffs,
  authWebOAuthCommands,
  authWebOAuthIntents,
  sessions,
  userCredentials,
  userProfiles,
  users,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { db } from '../../../db/client';
import { setupWorkerDatabase } from '../../../__tests__/worker-db';
import { prepareProjectionUnderUsersTableLock, reserveEnforcedEmail } from '../email-reservations';
import { CURRENT_EMAIL_NORMALIZER_VERSION, type ExpectedCurrentStoreAuthority } from '../foundation-context';
import { RouteExportBrowser, startAppRouterHarness, type BridgeResponse } from './fixtures/app-router-harness';
import type { ConfiguredIdentity, ConfiguredProvider } from './fixtures/app-router-providers';
import { startWebOAuthBackend } from './fixtures/web-oauth-backend';

const salt = randomUUID().replaceAll('-', '');
const readerRole = `ba03_router_readonly_${salt}`;
const writerRole = `ba03_weboauth_router_${salt}`;
const password = randomBytes(32).toString('hex');
const trackedRoles: string[] = [];
const resources: { close(): Promise<void> }[] = [];
const readTables = [users, accounts, userCredentials, userProfiles, sessions, verificationTokens, authSubjectCutoffs];
const backendTables = [
  users,
  accounts,
  userProfiles,
  authEmailProjection,
  authEmailReservations,
  authEmailReservationMembers,
  authSubjectCutoffs,
  authWebOAuthCommands,
  authWebOAuthIntents,
];
const insertTables = [
  users,
  accounts,
  userProfiles,
  authEmailReservations,
  authEmailReservationMembers,
  authWebOAuthCommands,
  authWebOAuthIntents,
];
const updateTables = [
  users,
  accounts,
  authEmailProjection,
  authEmailReservations,
  authSubjectCutoffs,
  authWebOAuthIntents,
];
const cleanupTables = [...new Set([...readTables, ...backendTables])];
const sessionName = '__Secure-next-auth.session-token';
let pool: ReturnType<typeof postgres> | undefined;
let readerUrl: string;
let authority: ExpectedCurrentStoreAuthority;
let cleanupFailed = false;

async function admin(statement: SQL) {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL statement_timeout='5000ms'`);
    await transaction.execute(sql`SET LOCAL lock_timeout='4000ms'`);
    return transaction.execute(statement);
  });
}
async function closeResources() {
  const failures: Error[] = [];
  for (let index = resources.length - 1; index >= 0; index -= 1) {
    const resource = resources[index];
    try {
      await resource.close();
      resources.splice(index, 1);
    } catch {
      cleanupFailed = true;
      failures.push(new Error('Owned web OAuth integration resource cleanup failed'));
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Owned identity integration cleanup failed');
}
function identity(): ConfiguredIdentity {
  const subject = randomUUID();
  return { subject, email: ` Case+${subject}@EXAMPLE.test `, name: 'Actual Provider Climber', emailVerified: true };
}
type Faults = NonNullable<Parameters<typeof startAppRouterHarness>[0]['faults']>;
async function fixture(faults: Faults = {}) {
  if (!pool) throw new Error('Missing owned restricted identity pool');
  const database = drizzle(pool);
  const secret = randomBytes(32).toString('base64url');
  const nextAuthSecret = randomBytes(32).toString('base64url');
  vi.stubEnv('CURRENT_STORE_WEB_OAUTH_MODE', 'backend-staging');
  vi.stubEnv('CURRENT_STORE_AUTH_PROJECTION_ID', authority.expectedProjectionId);
  vi.stubEnv('CURRENT_STORE_AUTH_WRITER_EPOCH', String(authority.expectedWriterEpoch));
  vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', secret);
  vi.stubEnv('NEXTAUTH_SECRET', nextAuthSecret);
  vi.stubEnv('DEBUG_SQL', 'false');
  const backend = await startWebOAuthBackend(database);
  const stopBackend = backend.close;
  resources.push(backend);
  const harness = await startAppRouterHarness({
    databaseUrl: readerUrl,
    nextAuthSecret,
    webOAuthIdentity: { origin: backend.origin, secret },
    faults,
  });
  resources.push(harness);
  return { harness, browser: new RouteExportBrowser(harness), requests: backend.requests, stopBackend };
}
async function seedOwner(profile: ConfiguredIdentity, provider: ConfiguredProvider, linked = true) {
  const userId = randomUUID();
  await db.transaction(async (transaction) => {
    await reserveEnforcedEmail(transaction, { ...authority, rawEmail: profile.email!, requestedUserId: userId });
    await transaction.insert(users).values({
      id: userId,
      email: profile.email!,
      name: 'Preserved Original Owner',
      image: 'original-image',
      emailVerified: new Date('2020-01-02T03:04:05Z'),
      createdAt: new Date('2019-01-02T03:04:05Z'),
    });
    await transaction.insert(userProfiles).values({ userId, displayName: 'Original Profile' });
    if (linked)
      await transaction.insert(accounts).values({
        userId,
        provider,
        providerAccountId: profile.subject,
        type: 'oauth',
        access_token: 'preserved-existing-provider-token',
      });
  });
  return userId;
}
async function setActor(
  current: Awaited<ReturnType<typeof fixture>>,
  userId: string,
  lineage: { authSessionId?: string; jti?: string } = { authSessionId: randomUUID() },
) {
  const token = String(await current.harness.call('encode', { claims: { sub: userId, ...lineage } }));
  current.browser.cookies.set(sessionName, token);
  return token;
}
async function callback(
  current: Awaited<ReturnType<typeof fixture>>,
  authorization: string,
  profile: ConfiguredIdentity,
  provider: ConfiguredProvider,
): Promise<BridgeResponse> {
  const responseDescriptor = await current.harness.authorize(authorization, profile);
  let response = await current.browser.request(responseDescriptor.url, {
    method: responseDescriptor.method,
    ...(responseDescriptor.method === 'POST' ? { form: responseDescriptor.form } : {}),
  });
  if (
    provider === 'apple' &&
    response.status === 303 &&
    response.location?.startsWith(`${current.harness.origin}/api/auth/callback/apple?boardseshOAuthContinue=`)
  )
    response = await current.browser.request(response.location);
  return response;
}
function expectNoAuthCookie(response: BridgeResponse) {
  expect(response.cookies.some((cookie) => /^(?:__Secure-)?next-auth\.session-token(?:[.=])/.test(cookie))).toBe(false);
}
function expectUnavailable(current: Awaited<ReturnType<typeof fixture>>, response: BridgeResponse) {
  expectNoAuthCookie(response);
  expect(response.status).toBe(303);
  expect(new URL(response.location!, current.harness.origin).searchParams.get('error')).toBe('AuthBackendUnavailable');
}
async function expectConsumedIntent() {
  const rows = await db.select().from(authWebOAuthIntents);
  expect(rows).toHaveLength(1);
  expect(rows[0].consumedAt).not.toBe(null);
}

async function expectCreationReceipt(
  current: Awaited<ReturnType<typeof fixture>>,
  provider: ConfiguredProvider,
  owner: typeof users.$inferSelect,
  accountCreated: boolean,
  requestStartedAt: number,
  responseCompletedAt: number,
) {
  const claims = await current.browser.claims();
  expect(claims?.sub).toBe(owner.id);
  expect(typeof claims?.authSessionId === 'string' && claims.authSessionId.length > 0).toBe(true);
  const proof = claims?.nativeOAuthCreationProof as
    | {
        authSessionId: string;
        provider: string;
        signedInAt: number;
        accountCreation: unknown;
      }
    | undefined;
  if (provider === 'facebook') expect(proof).toBeUndefined();
  else {
    expect(proof?.authSessionId === claims?.authSessionId).toBe(true);
    expect(proof?.provider).toBe(provider);
    expect(proof?.accountCreation).toEqual({
      userId: owner.id,
      accountCreated,
      provider,
      createdAt: owner.createdAt.toISOString(),
    });
    // This is conversion attribution time, never an original-authentication-age proof.
    expect(Number.isSafeInteger(proof?.signedInAt)).toBe(true);
    expect(proof!.signedInAt).toBeGreaterThanOrEqual(requestStartedAt);
    expect(proof!.signedInAt).toBeLessThanOrEqual(responseCompletedAt);
  }
  const response = await current.browser.request('/api/auth/session');
  expect(response.status).toBe(200);
  const session = JSON.parse(response.body) as {
    user: { id: string };
    authSessionId: string;
    nativeOAuthCreationProof?: unknown;
  };
  expect(session.user.id).toBe(owner.id);
  expect(session.authSessionId === claims?.authSessionId).toBe(true);
  expect(session.nativeOAuthCreationProof).toEqual(proof);
}

describe('shipping App Router identity delegation over actual provider and backend HTTP', () => {
  beforeAll(async () => {
    await setupWorkerDatabase();
    await db.transaction(async (transaction) => {
      for (const role of [readerRole, writerRole]) {
        await transaction.execute(
          sql`CREATE ROLE ${sql.identifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${sql.raw(`'${password}'`)}`,
        );
        trackedRoles.push(role);
        await transaction.execute(sql`GRANT USAGE ON SCHEMA public TO ${sql.identifier(role)}`);
      }
      await transaction.execute(
        sql`GRANT SELECT ON TABLE ${sql.join(readTables, sql`, `)} TO ${sql.identifier(readerRole)}`,
      );
      await transaction.execute(
        sql`GRANT SELECT ON TABLE ${sql.join(backendTables, sql`, `)} TO ${sql.identifier(writerRole)}`,
      );
      await transaction.execute(
        sql`GRANT INSERT ON TABLE ${sql.join(insertTables, sql`, `)} TO ${sql.identifier(writerRole)}`,
      );
      await transaction.execute(
        sql`GRANT UPDATE ON TABLE ${sql.join(updateTables, sql`, `)} TO ${sql.identifier(writerRole)}`,
      );
    });
    const database = new URL(process.env.DATABASE_URL ?? '');
    database.password = password;
    database.username = readerRole;
    readerUrl = database.href;
    database.username = writerRole;
    pool = postgres(database.href, {
      max: 2,
      connect_timeout: 3,
      onnotice: () => {},
      connection: { statement_timeout: 5000, lock_timeout: 4000 },
    });
  }, 30000);
  beforeEach(async () => {
    await closeResources();
    await db.delete(authWebOAuthIntents);
    await db.delete(authWebOAuthCommands);
    await db.delete(verificationTokens);
    await db.delete(sessions);
    await db.delete(authEmailReservationMembers);
    await db.delete(authEmailReservations);
    await db.delete(authSecurityMutationEvents);
    await db.delete(authSubjectCutoffs);
    await db.delete(authEmailProjection);
    await db.delete(users);
    const projectionId = randomUUID();
    authority = {
      expectedProjectionId: projectionId,
      expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
      expectedWriterEpoch: 1,
    };
    await db.transaction(async (transaction) => {
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
      await transaction.update(authEmailProjection).set({ phase: 'enforced' });
    });
  });
  afterAll(async () => {
    const failures: Error[] = [];
    try {
      await closeResources();
    } catch {
      failures.push(new Error('Owned App Router identity teardown failed'));
    }
    try {
      await pool?.end({ timeout: 3 });
    } catch {
      failures.push(new Error('Owned identity writer pool cleanup failed'));
    }
    for (const role of trackedRoles) {
      let roleMayExist = true;
      try {
        roleMayExist = (await admin(sql`SELECT 1 FROM pg_roles WHERE rolname=${role}`)).length > 0;
      } catch {
        failures.push(new Error('Owned identity role lookup failed'));
      }
      if (!roleMayExist) continue;
      for (const statement of [
        sql`REVOKE ALL PRIVILEGES ON TABLE ${sql.join(cleanupTables, sql`, `)} FROM ${sql.identifier(role)}`,
        sql`REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${sql.identifier(role)}`,
        sql`DROP ROLE IF EXISTS ${sql.identifier(role)}`,
      ]) {
        try {
          await admin(statement);
        } catch {
          failures.push(new Error('Owned identity role cleanup failed'));
        }
      }
    }
    if (!cleanupFailed && resources.length === 0) vi.unstubAllEnvs();
    else failures.push(new Error('Owned identity environment guards retained after incomplete cleanup'));
    if (failures.length) throw new AggregateError(failures, 'Owned web OAuth identity cleanup failed');
  }, 30000);

  it.each<ConfiguredProvider>(['google', 'apple', 'facebook'])(
    'creates %s through actual configured callbacks and backend writes while the web role cannot write',
    async (provider) => {
      const current = await fixture();
      const profile = identity();
      const requestStartedAt = Date.now();
      const result = await current.browser.complete(provider, profile);
      const responseCompletedAt = Date.now();
      expect(result.response.status).toBe(302);
      expect(result.response.location).toBe(`${current.harness.origin}/signed-in`);
      if (provider === 'apple') expect(result.handoff.status).toBe(303);
      const [owner] = await db.select().from(users);
      // The installed public getProfile lowercases upstream email before signIn.
      // Preserve that exact asserted string, including whitespace; only the
      // reservation key is independently trimmed/lowercased by the backend.
      expect(owner.email).toBe(profile.email!.toLowerCase());
      expect(owner.name).toBe(profile.name);
      expect(owner.emailVerified).toBe(null);
      expect(await db.select({ userId: userProfiles.userId }).from(userProfiles)).toEqual([{ userId: owner.id }]);
      const [account] = await db.select().from(accounts);
      expect(account).toMatchObject({
        userId: owner.id,
        provider,
        providerAccountId: profile.subject,
        access_token: null,
        refresh_token: null,
        id_token: null,
      });
      await expectCreationReceipt(current, provider, owner, true, requestStartedAt, responseCompletedAt);
      expect(current.requests).toEqual([
        { operation: 'intent', status: 200 },
        { operation: 'resolve', status: 200 },
      ]);
      await expectConsumedIntent();
      const privileges = await admin(
        sql`SELECT has_table_privilege(${readerRole}, 'users', 'INSERT') AS insert, has_table_privilege(${readerRole}, 'users', 'UPDATE') AS update, has_table_privilege(${readerRole}, 'users', 'DELETE') AS delete`,
      );
      expect(privileges[0]).toMatchObject({ insert: false, update: false, delete: false });
    },
    30000,
  );
  for (const provider of ['google', 'apple', 'facebook'] as const)
    it.each(['missing', 'changed'] as const)(
      `keeps linked ${provider} owner/profile/verification with %s upstream email`,
      async (change) => {
        const profile = identity();
        const userId = await seedOwner(profile, provider);
        const original = (await db.select().from(users))[0];
        const originalAccount = (await db.select().from(accounts))[0];
        const originalProfile = (await db.select().from(userProfiles))[0];
        const current = await fixture();
        const requestStartedAt = Date.now();
        const result = await current.browser.complete(provider, {
          subject: profile.subject,
          ...(change === 'changed' ? { email: `${randomUUID()}@example.test` } : {}),
          name: 'Different upstream name',
        });
        const responseCompletedAt = Date.now();
        expect(result.response.status).toBe(302);
        await expectCreationReceipt(current, provider, original, false, requestStartedAt, responseCompletedAt);
        expect(original.id).toBe(userId);
        expect(await db.select().from(users)).toEqual([original]);
        expect(await db.select().from(accounts)).toEqual([originalAccount]);
        expect(await db.select().from(userProfiles)).toEqual([originalProfile]);
        await expectConsumedIntent();
      },
      30000,
    );

  it('accepts actual normal JWE renewal within the same actor SID without changing canonical ownership', async () => {
    const profile = identity();
    const owner = await seedOwner(profile, 'google');
    const current = await fixture();
    const sid = randomUUID();
    const original = await setActor(current, owner, { authSessionId: sid });
    const authorization = await current.browser.start('google');
    const renewal = await current.browser.request('/api/auth/session');
    expect(renewal.status).toBe(200);
    expect(current.browser.session() !== original).toBe(true);
    expect((await current.browser.claims())?.authSessionId).toBe(sid);
    const response = await callback(current, authorization, profile, 'google');
    expect(response.status).toBe(302);
    expect((await current.browser.claims())?.sub).toBe(owner);
    expect(await db.select().from(users)).toHaveLength(1);
    await expectConsumedIntent();
  }, 30000);
  it('preserves the original signed jti as stable actor lineage when the actual session route first adds SID', async () => {
    const profile = identity();
    const owner = await seedOwner(profile, 'google');
    const current = await fixture();
    await setActor(current, owner, {});
    const before = await current.browser.claims();
    expect(typeof before?.jti).toBe('string');
    expect(before?.authSessionId).toBeUndefined();
    const authorization = await current.browser.start('google');
    expect((await current.browser.request('/api/auth/session')).status).toBe(200);
    const after = await current.browser.claims();
    expect(after?.authSessionId).toBe(before?.jti);
    expect(after?.jti).not.toBe(before?.jti);
    expect((await callback(current, authorization, profile, 'google')).status).toBe(302);
    expect((await current.browser.claims())?.sub).toBe(owner);
    await expectConsumedIntent();
  }, 30000);
  it('withholds an unlinked signed-actor callback behind the recent-authentication stage gate', async () => {
    const local = identity();
    const owner = await seedOwner(local, 'google');
    const current = await fixture();
    const incumbent = await setActor(current, owner);
    const result = await current.browser.complete('facebook', identity());
    expectUnavailable(current, result.response);
    expect(current.browser.session() === incumbent).toBe(true);
    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(accounts)).toHaveLength(1);
    expect(current.requests.at(-1)).toEqual({ operation: 'resolve', status: 503 });
    await expectConsumedIntent();
  }, 30000);
  it('never attaches a new Facebook subject to an occupied matching email', async () => {
    const profile = identity();
    const owner = await seedOwner(profile, 'google');
    const current = await fixture();
    const result = await current.browser.complete('facebook', { ...profile, subject: randomUUID() });
    expectNoAuthCookie(result.response);
    expect(current.browser.session().length).toBe(0);
    expect(new URL(result.response.location!, current.harness.origin).searchParams.get('error')).toBe(
      'OAuthAccountNotLinked',
    );
    expect(await db.select({ id: users.id }).from(users)).toEqual([{ id: owner }]);
    expect(await db.select().from(accounts)).toHaveLength(1);
    expect(current.requests.at(-1)).toEqual({ operation: 'resolve', status: 409 });
    await expectConsumedIntent();
  }, 30000);
  it.each(['different-owner', 'same-owner-new-SID'] as const)(
    'rejects callback actor change: %s',
    async (change) => {
      const profile = identity();
      const owner = await seedOwner(profile, 'google');
      const other = await seedOwner(identity(), 'facebook');
      const current = await fixture();
      await setActor(current, owner);
      const authorization = await current.browser.start('google');
      const replacement = await setActor(current, change === 'different-owner' ? other : owner);
      const response = await callback(current, authorization, profile, 'google');
      expectNoAuthCookie(response);
      expect(current.browser.session() === replacement).toBe(true);
      expect(new URL(response.location!).searchParams.get('error')).toBe('AccessDenied');
      expect(current.requests.at(-1)).toEqual({ operation: 'resolve', status: 409 });
      expect((await db.select().from(authWebOAuthIntents))[0].consumedAt).toBe(null);
      expect(await db.select().from(users)).toHaveLength(2);
    },
    30000,
  );
  it('rejects malformed present actor material without recording an anonymous intent', async () => {
    const current = await fixture();
    current.browser.cookies.set(sessionName, 'not-an-encrypted-actor');
    const csrf = await current.browser.request('/api/auth/csrf');
    const token = (JSON.parse(csrf.body) as { csrfToken: string }).csrfToken;
    const response = await current.browser.request('/api/auth/signin/google', {
      method: 'POST',
      form: new URLSearchParams({ csrfToken: token }).toString(),
    });
    expectUnavailable(current, response);
    expect(current.browser.session() === 'not-an-encrypted-actor').toBe(true);
    expect(await db.select().from(authWebOAuthIntents)).toEqual([]);
    expect(await db.select().from(users)).toEqual([]);
  }, 30000);
  it('does not compensate a committed identity or publish cookies when its actual successful resolve reply is discarded', async () => {
    const current = await fixture({ discardSuccessfulWebOAuthResponse: true });
    const profile = identity();
    const result = await current.browser.complete('google', profile);
    expectUnavailable(current, result.response);
    expect(current.browser.session().length).toBe(0);
    const [owner] = await db.select().from(users);
    // The installed public getProfile lowercases upstream email before signIn.
    // Preserve that exact asserted string, including whitespace; only the
    // reservation key is independently trimmed/lowercased by the backend.
    expect(owner.email).toBe(profile.email!.toLowerCase());
    expect(await db.select({ userId: accounts.userId }).from(accounts)).toEqual([{ userId: owner.id }]);
    expect(current.requests).toEqual([
      { operation: 'intent', status: 200 },
      { operation: 'resolve', status: 200 },
    ]);
    await expectConsumedIntent();
  }, 30000);
  it.each(['failEvent', 'failEncode'] as const)(
    'withholds session publication after real late %s while retaining committed identity',
    async (fault) => {
      const current = await fixture({ [fault]: true });
      const profile = identity();
      const result = await current.browser.complete('google', profile);
      expectUnavailable(current, result.response);
      expect(current.browser.session().length).toBe(0);
      expect(await db.select().from(users)).toHaveLength(1);
      expect(await db.select().from(accounts)).toHaveLength(1);
      expect(await db.select().from(userProfiles)).toHaveLength(1);
      expect(current.requests.at(-1)).toEqual({ operation: 'resolve', status: 200 });
      await expectConsumedIntent();
    },
    30000,
  );
  it('keeps the incumbent cookie when the backend becomes unavailable after intent creation', async () => {
    const profile = identity();
    const owner = await seedOwner(profile, 'google');
    const current = await fixture();
    const incumbent = await setActor(current, owner);
    const authorization = await current.browser.start('google');
    await current.stopBackend();
    const response = await callback(current, authorization, profile, 'google');
    expectUnavailable(current, response);
    expect(current.browser.session() === incumbent).toBe(true);
    expect((await current.browser.claims())?.sub).toBe(owner);
    expect((await db.select().from(authWebOAuthIntents))[0].consumedAt).toBe(null);
    expect(await db.select().from(users)).toHaveLength(1);
  }, 30000);
  it('does not resolve or create identity after actual provider cancellation', async () => {
    const current = await fixture();
    const result = await current.browser.complete('google', identity(), { cancel: true });
    expectNoAuthCookie(result.response);
    expect(current.requests).toEqual([{ operation: 'intent', status: 200 }]);
    expect(await db.select().from(users)).toEqual([]);
    expect((await db.select().from(authWebOAuthIntents))[0].consumedAt).toBe(null);
  }, 30000);
  it('keeps actual provider sign-in working and logs only a fixed category after real profile SELECT denial', async () => {
    const readerPool = postgres(readerUrl, {
      max: 1,
      connect_timeout: 3,
      onnotice: () => {},
      connection: { statement_timeout: 5000, lock_timeout: 4000 },
    });
    try {
      await admin(sql`REVOKE SELECT ON TABLE ${userProfiles} FROM ${sql.identifier(readerRole)}`);
      await expect(drizzle(readerPool).select().from(userProfiles)).rejects.toMatchObject({
        cause: { code: '42501' },
      });
      const current = await fixture();
      const result = await current.browser.complete('google', identity());
      expect(result.response.status).toBe(302);
      const [owner] = await db.select().from(users);
      expect((await current.browser.claims())?.sub).toBe(owner.id);
      expect(await db.select().from(userProfiles)).toHaveLength(1);
      const snapshot = (await current.harness.call('snapshot')) as {
        webOAuthConsole: {
          profileRefreshUnavailable: number;
          identityErrors: number;
          identityWarnings: number;
          unknownArguments: number;
        };
      };
      expect(snapshot.webOAuthConsole).toEqual({
        profileRefreshUnavailable: 1,
        identityErrors: 0,
        identityWarnings: 0,
        unknownArguments: 0,
      });
      await expectConsumedIntent();
    } finally {
      try {
        await closeResources();
      } finally {
        try {
          await readerPool.end({ timeout: 3 });
        } finally {
          await admin(sql`GRANT SELECT ON TABLE ${userProfiles} TO ${sql.identifier(readerRole)}`);
        }
      }
    }
  }, 30000);
});
