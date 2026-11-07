import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { jwtVerify } from 'jose';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql, type SQL } from 'drizzle-orm';
import type { DbInstance } from '@boardsesh/db/client';
import {
  authEmailProjection,
  authEmailReservations,
  authEmailReservationMembers,
  authEmailVerificationTokens,
  authEmailVerificationState,
  authSecurityMutationEvents,
  authSubjectCutoffs,
  accounts,
  users,
  userCredentials,
  userProfiles,
  mobileRefreshTokens,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import { AUTH_COMMAND_PATHS, registerReplySchema } from '@boardsesh/auth-protocol';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { db } from '../../../db/client';
import { setupWorkerDatabase } from '../../../__tests__/worker-db';
import {
  handleNativeAuthRegister,
  handleNativeAuthOAuth,
  __resetNativeAuthStateForTests,
} from '../../../handlers/native-auth';
import { handleCurrentStoreWebAuth } from '../../../handlers/current-store-web-auth';
import { logger } from '../../../utils/logger';
import { prepareProjectionUnderUsersTableLock } from '../email-reservations';
import { CURRENT_EMAIL_NORMALIZER_VERSION, type CurrentStoreTransaction } from '../foundation-context';
import { getPostgresErrorCode, getPostgresConstraintName } from '../../../utils/postgres-errors';
import { normalizeAccountEmail } from '../../normalize-email';
import { createNativeOAuthProviderFixture } from './fixtures/native-oauth-provider-fixture';
import { recordSecurityMutation } from '../security-mutations';

const suffix = randomUUID().replaceAll('-', '');
const nativeRole = `ba03_oauth_${suffix}`;
const webRole = `ba03_oauthpwd_${suffix}`;
const rolePassword = randomBytes(32).toString('hex');
const signingSecret = randomBytes(32).toString('base64url');
const rpcSecret = randomBytes(32).toString('base64url');
const ownedRoles: string[] = [];
const ownedPools: ReturnType<typeof postgres>[] = [];
const servers: Server[] = [];
const sockets = new Set<Socket>();
const activeHandlers = new Set<Promise<void>>();
let acceptingRequests = false;
let failedHandlerCleanup = false;
const googleAudience = 'owned-native-oauth-google';
const appleAudience = process.env.APPLE_BUNDLE_ID ?? 'com.boardsesh.app';
let providers: Awaited<ReturnType<typeof createNativeOAuthProviderFixture>>;
let restoreProviderFetch: (() => void) | undefined;
let userInsertAttempts = 0;
let databaseFailure: { code: string | undefined; constraint: string | undefined } | undefined;
const origins: string[] = [];
const password = '  café 山🧗 password  ';
let nativeWriter: DbInstance;
let secondNativeWriter: DbInstance;
let webWriter: DbInstance;
let projectionId: string;

interface NativeReply {
  jwt: string;
  refreshToken: string;
  expiresAt: string;
  userId: string;
  accountCreation: { userId: string; provider: string; accountCreated: boolean; createdAt: string };
}
/** Observe only sanitized DB failure fields before the real handler catches them. */
function observeDatabaseFailures(database: DbInstance): DbInstance {
  return new Proxy(database, {
    get(target, property, receiver): unknown {
      if (property === 'transaction')
        return async <Result>(
          callback: (transaction: CurrentStoreTransaction) => Promise<Result>,
          configuration?: Parameters<DbInstance['transaction']>[1],
        ): Promise<Result> => {
          try {
            return await target.transaction(callback, configuration);
          } catch (error) {
            databaseFailure = { code: getPostgresErrorCode(error), constraint: getPostgresConstraintName(error) };
            throw error;
          }
        };
      const member: unknown = Reflect.get(target, property, receiver);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
}
async function administrator(statement: SQL) {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
    await transaction.execute(sql`SET LOCAL lock_timeout = '4000ms'`);
    return transaction.execute(statement);
  });
}
async function changeWriterEpoch(epoch: number) {
  await db.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
    await transaction.execute(sql`SET LOCAL lock_timeout = '1000ms'`);
    await transaction
      .update(authEmailProjection)
      .set({ writerEpoch: epoch })
      .where(eq(authEmailProjection.projectionId, projectionId));
  });
}
async function post(payload: unknown, instance = 0) {
  return fetch(`${origins[instance]}/auth/native/oauth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
}
async function webCommand(email: string, requestId = randomUUID()) {
  const command = {
    protocolVersion: 2,
    operation: 'register',
    requestId,
    issuedAt: Date.now(),
    payload: { email, password },
  };
  const response = await fetch(`${origins[0]}${AUTH_COMMAND_PATHS.register}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rpcSecret}` },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(10_000),
  });
  return { response, reply: registerReplySchema.parse(await response.json()), command };
}
async function counts() {
  return {
    users: (await db.select().from(users)).length,
    accounts: (await db.select().from(accounts)).length,
    credentials: (await db.select().from(userCredentials)).length,
    profiles: (await db.select().from(userProfiles)).length,
    refresh: (await db.select().from(mobileRefreshTokens)).length,
    reservations: (await db.select().from(authEmailReservations)).length,
    members: (await db.select().from(authEmailReservationMembers)).length,
    nonces: (await db.select().from(verificationTokens)).length,
  };
}
const empty = {
  accounts: 0,
  users: 0,
  credentials: 0,
  profiles: 0,
  refresh: 0,
  reservations: 0,
  members: 0,
  nonces: 0,
};

async function signed(
  provider: 'apple' | 'google',
  email = `${randomUUID()}@example.test`,
  sub: string = randomUUID(),
  verified = true,
) {
  return {
    provider,
    identityToken: await providers.sign(provider, { sub, email, email_verified: verified, name: 'Provider Climber' }),
    sub,
    email,
  };
}
async function created(provider: 'apple' | 'google' = 'google', email?: string, sub?: string) {
  const input = await signed(provider, email, sub);
  const response = await post(input);
  expect(response.status).toBe(200);
  return { input, reply: (await response.json()) as NativeReply };
}
function barrier() {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { resolve, promise };
}
async function bounded<T>(promise: Promise<T>, active?: Promise<unknown>, milliseconds = 3500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Owned OAuth wait deadline')), milliseconds);
      }),
      ...(active
        ? [
            active.then(() => {
              throw new Error('OAuth request ended before lock barrier');
            }) as Promise<never>,
          ]
        : []),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function observedNativeLock(active: Promise<unknown>) {
  let stopped = false;
  const polling = (async () => {
    const until = Date.now() + 3000;
    while (!stopped && Date.now() < until) {
      const records = await administrator(
        sql`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE usename = ${nativeRole} AND wait_event_type = 'Lock') AS waiting`,
      );
      if (records[0]?.waiting === true) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Owned OAuth writer lock was not observed');
  })();
  try {
    await bounded(polling, active);
  } finally {
    stopped = true;
    await Promise.allSettled([polling]);
  }
}

describe('reserved native OAuth identity with actual JOSE and PostgreSQL', () => {
  beforeAll(async () => {
    const initialUrl = new URL(process.env.DATABASE_URL!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(initialUrl.hostname))
      throw new Error('OAuth fixture requires owned loopback');
    await setupWorkerDatabase();
    const databaseUrl = new URL(process.env.DATABASE_URL!);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(databaseUrl.hostname) ||
      !databaseUrl.pathname.startsWith('/boardsesh_backend_test_w')
    )
      throw new Error('Native registration fixture requires its owned local worker database');
    await db.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
      for (const role of [nativeRole, webRole]) {
        await transaction.execute(
          sql`CREATE ROLE ${sql.identifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${sql.raw(`'${rolePassword}'`)}`,
        );
        ownedRoles.push(role);
        await transaction.execute(sql`GRANT USAGE ON SCHEMA public TO ${sql.identifier(role)}`);
        await transaction.execute(sql`GRANT SELECT, INSERT ON TABLE ${users} TO ${sql.identifier(role)}`);
        await transaction.execute(sql`GRANT INSERT ON TABLE ${userProfiles} TO ${sql.identifier(role)}`);
        await transaction.execute(
          sql`GRANT SELECT, UPDATE ON TABLE ${authEmailProjection}, ${authSubjectCutoffs} TO ${sql.identifier(role)}`,
        );
        await transaction.execute(
          sql`GRANT SELECT, INSERT, UPDATE ON TABLE ${authEmailReservations} TO ${sql.identifier(role)}`,
        );
        await transaction.execute(
          sql`GRANT SELECT, INSERT ON TABLE ${authEmailReservationMembers} TO ${sql.identifier(role)}`,
        );
      }
      await transaction.execute(sql`GRANT INSERT ON TABLE ${mobileRefreshTokens} TO ${sql.identifier(nativeRole)}`);
      await transaction.execute(sql`GRANT UPDATE ON TABLE ${users} TO ${sql.identifier(nativeRole)}`);
      // This role also exercises native password registration. Permit its
      // issuer's row lock without granting identity-column UPDATE.
      await transaction.execute(sql`GRANT UPDATE (updated_at) ON TABLE ${users} TO ${sql.identifier(webRole)}`);
      await transaction.execute(
        sql`GRANT SELECT, INSERT, UPDATE ON TABLE ${accounts} TO ${sql.identifier(nativeRole)}`,
      );
      await transaction.execute(
        sql`GRANT INSERT ON TABLE ${userCredentials}, ${mobileRefreshTokens} TO ${sql.identifier(webRole)}`,
      );
      await transaction.execute(sql`GRANT SELECT, INSERT ON TABLE ${verificationTokens} TO ${sql.identifier(webRole)}`);
    });
    for (const role of [nativeRole, webRole, nativeRole]) {
      const url = new URL(databaseUrl);
      url.username = role;
      url.password = rolePassword;
      const pool = postgres(url.toString(), {
        debug: (_connection, query) => {
          if (role === nativeRole && query.startsWith('insert into "users"')) userInsertAttempts += 1;
        },
        max: 3,
        connect_timeout: 3,
        onnotice: () => {},
        connection: { statement_timeout: 5000, lock_timeout: 4000 },
      });
      ownedPools.push(pool);
      if (role === nativeRole && nativeWriter) secondNativeWriter = observeDatabaseFailures(drizzle(pool));
      else if (role === nativeRole) nativeWriter = observeDatabaseFailures(drizzle(pool));
      else webWriter = drizzle(pool);
    }
    for (let instance = 0; instance < 2; instance += 1) {
      const server = createServer((request, response) => {
        if (!acceptingRequests) {
          response.writeHead(503);
          response.end();
          return;
        }
        const handling = request.url?.startsWith('/auth/native/oauth')
          ? handleNativeAuthOAuth(request, response, instance === 0 ? nativeWriter : secondNativeWriter)
          : request.url?.startsWith('/auth/native/register')
            ? handleNativeAuthRegister(request, response, webWriter)
            : handleCurrentStoreWebAuth(request, response, webWriter);
        activeHandlers.add(handling);
        void handling.then(
          () => {
            activeHandlers.delete(handling);
          },
          () => {
            activeHandlers.delete(handling);
            try {
              if (!response.headersSent) response.writeHead(500);
              response.end();
            } catch {
              response.destroy();
            }
          },
        );
      });
      servers.push(server);
      server.requestTimeout = 11_000;
      server.headersTimeout = 11_000;
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Owned native HTTP failed to bind');
      origins.push(`http://127.0.0.1:${address.port}`);
    }
    providers = await createNativeOAuthProviderFixture({ googleAudience, appleAudience });
    restoreProviderFetch = providers.installFetch(origins);
  });
  beforeEach(async () => {
    if (failedHandlerCleanup || activeHandlers.size !== 0) throw new Error('Owned OAuth fixture is not quiescent');
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    __resetNativeAuthStateForTests();
    await db.delete(authEmailVerificationTokens);
    await db.delete(authEmailVerificationState);
    await db.delete(authEmailReservationMembers);
    await db.delete(authEmailReservations);
    await db.delete(authSubjectCutoffs);
    await db.delete(authSecurityMutationEvents);
    await db.delete(authEmailProjection);
    await db.delete(verificationTokens);
    await db.delete(accounts);
    await db.delete(users);
    projectionId = randomUUID();
    await db.transaction(async (transaction) => {
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
      await transaction
        .update(authEmailProjection)
        .set({ phase: 'enforced' })
        .where(eq(authEmailProjection.projectionId, projectionId));
    });
    userInsertAttempts = 0;
    databaseFailure = undefined;
    providers.failJwks('apple', null);
    providers.failJwks('google', null);
    vi.stubEnv('CURRENT_STORE_NATIVE_OAUTH_MODE', 'reserved-staging');
    vi.stubEnv('GOOGLE_WEB_CLIENT_ID', googleAudience);
    vi.stubEnv('GOOGLE_IOS_CLIENT_ID', 'owned-native-oauth-ios');
    vi.stubEnv('GOOGLE_ANDROID_CLIENT_ID', 'owned-native-oauth-android');
    vi.stubEnv('NEXTAUTH_SECRET', signingSecret);
    vi.stubEnv('CURRENT_STORE_NATIVE_REGISTRATION_MODE', 'reserved-staging');
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', rpcSecret);
    vi.stubEnv('CURRENT_STORE_AUTH_PROJECTION_ID', projectionId);
    vi.stubEnv('CURRENT_STORE_AUTH_WRITER_EPOCH', '1');
    vi.stubEnv('EMAIL_VERIFICATION_ENABLED', 'false');
    vi.stubEnv('DEBUG_SQL', 'false');
    acceptingRequests = true;
  });
  afterEach(async () => {
    acceptingRequests = false;
    try {
      await bounded(Promise.allSettled(activeHandlers), undefined, 12_000);
      if (activeHandlers.size !== 0) throw new Error('Owned OAuth handlers remain active');
    } catch {
      failedHandlerCleanup = true;
      throw new Error('Owned OAuth per-test cleanup failed; environment and provider guard retained');
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    acceptingRequests = false;
    const failures: Error[] = [];
    for (const server of servers) {
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            for (const socket of sockets) socket.destroy();
            reject(new Error('Owned OAuth HTTP close deadline'));
          }, 3000);
          server.close((error) => {
            clearTimeout(timer);
            if (error) reject(error);
            else resolve();
          });
          server.closeIdleConnections();
        });
      } catch {
        failures.push(new Error('Owned OAuth HTTP cleanup failed'));
      }
    }
    for (const pool of ownedPools) {
      try {
        await pool.end({ timeout: 3 });
      } catch {
        failures.push(new Error('Owned OAuth LOGIN cleanup failed'));
      }
    }
    try {
      await bounded(Promise.allSettled(activeHandlers), undefined, 12_000);
    } catch {
      failures.push(new Error('Owned OAuth handlers not quiescent; provider guard retained'));
    }
    if (activeHandlers.size === 0 && servers.every((server) => !server.listening)) {
      restoreProviderFetch?.();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    } else failures.push(new Error('Owned OAuth provider guard/environment retained until worker exit'));
    for (const role of ownedRoles) {
      try {
        const records = await administrator(
          sql`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${role}) AS present`,
        );
        if (records[0]?.present === false) continue;
      } catch {
        failures.push(new Error('Owned OAuth role lookup failed'));
      }
      try {
        await administrator(sql`REVOKE UPDATE (updated_at) ON TABLE ${users} FROM ${sql.identifier(role)}`);
        await administrator(
          sql`REVOKE ALL PRIVILEGES ON TABLE ${users}, ${accounts}, ${userCredentials}, ${userProfiles}, ${mobileRefreshTokens}, ${authEmailProjection}, ${authEmailReservations}, ${authEmailReservationMembers}, ${authSubjectCutoffs}, ${verificationTokens} FROM ${sql.identifier(role)}`,
        );
      } catch {
        failures.push(new Error('Owned OAuth grants cleanup failed'));
      }
      try {
        await administrator(sql`REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${sql.identifier(role)}`);
      } catch {
        failures.push(new Error('Owned OAuth schema cleanup failed'));
      }
      try {
        await administrator(sql`DROP ROLE IF EXISTS ${sql.identifier(role)}`);
      } catch {
        failures.push(new Error('Owned OAuth role cleanup failed'));
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Owned OAuth fixture cleanup failed');
  });

  it('supports the registration role user KEY SHARE without identity mutation or deletion', async () => {
    const probeId = randomUUID();
    const rollback = new Error('Owned OAuth row-lock probe rollback');
    await expect(
      webWriter.transaction(async (transaction) => {
        await transaction.insert(users).values({ id: probeId, email: `${probeId}@oauth-lock-probe.example.test` });
        const [subject] = await transaction
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, probeId))
          .for('key share', { of: users });
        expect(subject?.id).toBe(probeId);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await db.select({ id: users.id }).from(users).where(eq(users.id, probeId))).toEqual([]);
    await expect(webWriter.update(users).set({ id: randomUUID() }).where(eq(users.id, probeId))).rejects.toMatchObject({
      cause: { code: '42501' },
    });
    await expect(
      webWriter.update(users).set({ email: 'forbidden@oauth-lock-probe.example.test' }).where(eq(users.id, probeId)),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(webWriter.delete(users).where(eq(users.id, probeId))).rejects.toMatchObject({
      cause: { code: '42501' },
    });
  });

  it('keeps actual cold JWKS network/HTTP/malformed failures unavailable and valid cached keys usable', async () => {
    expect(providers.counters.apple).toBe(0);
    const input = await signed('apple');
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    for (const kind of ['network', 'http', 'malformed'] as const) {
      providers.failJwks('apple', kind);
      const response = await post(input);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'Service temporarily unavailable' });
      expect(await counts()).toEqual(empty);
    }
    expect(error).not.toHaveBeenCalled();
    expect(warning.mock.calls).toEqual(
      Array.from({ length: 3 }, () => [
        '[NativeAuth] OAuth verification rejected',
        { category: 'provider-unavailable' },
      ]),
    );
    providers.failJwks('apple', null);
    const guardedFetch = globalThis.fetch;
    let epochChanged = false;
    globalThis.fetch = async (address, options) => {
      const url = typeof address === 'string' || address instanceof URL ? String(address) : address.url;
      if (url === 'https://appleid.apple.com/auth/keys') {
        await changeWriterEpoch(2);
        epochChanged = true;
      }
      return guardedFetch(address, options);
    };
    try {
      expect((await post(input)).status).toBe(503);
      expect(epochChanged).toBe(true);
      expect(await counts()).toEqual(empty);
      expect(warning).toHaveBeenLastCalledWith('[NativeAuth] Reserved OAuth unavailable', {
        category: 'authority-or-database',
      });
    } finally {
      // The outer shim delegates only to the still-installed egress guard.
      globalThis.fetch = guardedFetch;
      await changeWriterEpoch(1);
    }
    expect((await post(input)).status).toBe(200);
    const lookups = providers.counters.apple;
    providers.failJwks('apple', 'network');
    expect((await post(input)).status).toBe(200);
    expect(providers.counters.apple).toBe(lookups);
    expect(providers.counters.blocked).toBe(0);
  });
  it('distinguishes a cached unknown kid from a known-key wrong signature using actual JOSE', async () => {
    expect(providers.counters.google).toBe(0);
    await created('google');
    const lookups = providers.counters.google;
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const before = await counts();
    const claims = { sub: randomUUID(), email: `${randomUUID()}@example.test`, email_verified: true };
    const unknown = await post({
      provider: 'google',
      identityToken: await providers.sign('google', claims, { unknownKid: true }),
    });
    expect(unknown.status).toBe(503);
    expect(providers.counters.google).toBe(lookups);
    const forged = await post({
      provider: 'google',
      identityToken: await providers.sign('google', claims, { wrongKey: true }),
    });
    expect(forged.status).toBe(401);
    expect(await counts()).toEqual(before);
    expect(warning.mock.calls).toEqual([
      ['[NativeAuth] OAuth verification rejected', { category: 'provider-unavailable' }],
      ['[NativeAuth] OAuth verification rejected', { category: 'invalid-token' }],
    ]);
  });
  it.each(['apple', 'google'] as const)(
    'creates %s through actual RS256 verification and preserves new/returning receipts without rewrites',
    async (provider) => {
      const input = await signed(provider, ` Mixed.${randomUUID()}+Tag@Example.TEST `);
      const requestedUserId = randomUUID();
      const first = await post({
        ...input,
        requestedUserId,
        protocolVersion: 999,
        emailVerified: true,
        name: { firstName: '  First ', lastName: ' Last  ' },
      });
      expect(first.status).toBe(200);
      const reply = (await first.json()) as NativeReply;
      expect(reply.userId).not.toBe(requestedUserId);
      const { payload } = await jwtVerify(reply.jwt, new TextEncoder().encode(signingSecret), {
        issuer: 'boardsesh',
        audience: 'boardsesh-mobile',
        algorithms: ['HS256'],
      });
      expect(payload.sub).toBe(reply.userId);
      const [user] = await db.select().from(users);
      expect(user.email).toBe(normalizeAccountEmail(input.email));
      expect(user.name).toBe('First   Last');
      expect(reply.accountCreation).toEqual({
        userId: user.id,
        provider,
        accountCreated: true,
        createdAt: user.createdAt.toISOString(),
      });
      const original = { ...user };
      const returning = await post({
        provider,
        identityToken: await providers.sign(provider, {
          sub: input.sub,
          email: 'changed@example.test',
          email_verified: false,
          name: 'Changed Name',
        }),
      });
      expect(returning.status).toBe(200);
      const returned = (await returning.json()) as NativeReply;
      expect(returned.userId).toBe(reply.userId);
      expect(returned.accountCreation).toEqual({ ...reply.accountCreation, accountCreated: false });
      expect((await db.select().from(users))[0]).toEqual(original);
      const missing = await post({ provider, identityToken: await providers.sign(provider, { sub: input.sub }) });
      expect(missing.status).toBe(200);
      expect(((await missing.json()) as NativeReply).userId).toBe(reply.userId);
      expect((await counts()).accounts).toBe(1);
      await expect(nativeWriter.delete(users)).rejects.toMatchObject({ cause: { code: '42501' } });
      await expect(nativeWriter.execute(sql`TRUNCATE TABLE ${accounts}`)).rejects.toMatchObject({
        cause: { code: '42501' },
      });
    },
  );
  it.each([true, false])(
    'refuses email-only linking and duplicate creation for verified claim %s',
    async (verified) => {
      const email = `${randomUUID()}@example.test`;
      const passwordResponse = await fetch(`${origins[0]}/auth/native/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        signal: AbortSignal.timeout(10_000),
      });
      expect(passwordResponse.status).toBe(201);
      const original = await counts();
      const response = await post(await signed('google', email, randomUUID(), verified));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: 'This sign-in method is not linked to that account. Use your existing sign-in method.',
      });
      expect(await counts()).toEqual(original);
    },
  );
  it('keeps an unverified new provider email unverified', async () => {
    const input = await signed('google', undefined, undefined, false);
    expect((await post({ ...input, emailVerified: true, userId: randomUUID() })).status).toBe(200);
    expect((await db.select().from(users))[0].emailVerified).toBeNull();
  });
  it('serializes the same provider subject with different signed email claims across independent pools', async () => {
    const sub = randomUUID();
    const first = await signed('google', undefined, sub);
    const second = await signed('google', undefined, sub);
    const replies = await Promise.all([post(first), post(second, 1)]);
    expect(replies.map((response) => response.status)).toEqual([200, 200]);
    const owners = await Promise.all(replies.map((response) => response.json() as Promise<NativeReply>));
    expect(owners[0].userId).toBe(owners[1].userId);
    expect(owners.map((owner) => owner.accountCreation.accountCreated).sort((a, b) => Number(a) - Number(b))).toEqual([
      false,
      true,
    ]);
    expect(await counts()).toEqual({
      ...empty,
      users: 1,
      accounts: 1,
      profiles: 1,
      refresh: 2,
      reservations: 1,
      members: 1,
    });
  });
  it('lets only one different subject or web password writer take the same normalized key', async () => {
    const email = `Shared.${randomUUID()}@Example.TEST`;
    const [first, second, web] = await Promise.all([
      post(await signed('apple', email)),
      post(await signed('google', ` ${email.toLowerCase()} `), 1),
      webCommand(email),
    ]);
    expect(
      [first.status, second.status, web.response.status].filter((status) => status === 200 || status === 201),
    ).toHaveLength(1);
    expect([first.status, second.status, web.response.status].filter((status) => status === 409)).toHaveLength(2);
    const measured = await counts();
    expect(measured).toMatchObject({ users: 1, profiles: 1, reservations: 1, members: 1, nonces: 1 });
    expect(measured.accounts + measured.credentials).toBe(1);
  });
  it.each(['owned-other', 'missing-member', 'stale-basis', 'missing-key', 'invalid-key'] as const)(
    'makes linked evidence %s unavailable without retargeting a subject',
    async (kind) => {
      const owner = await created();
      const key = normalizeAccountEmail(owner.input.email);
      if (kind === 'owned-other')
        await db
          .update(authEmailReservations)
          .set({ ownerUserId: randomUUID() })
          .where(eq(authEmailReservations.normalizedEmail, key));
      if (kind === 'missing-member')
        await db.delete(authEmailReservationMembers).where(eq(authEmailReservationMembers.normalizedEmail, key));
      if (kind === 'invalid-key')
        await db
          .update(authEmailReservations)
          .set({ state: 'blocked_invalid', ownerUserId: null })
          .where(eq(authEmailReservations.normalizedEmail, key));
      if (kind === 'missing-key') {
        await db.delete(authEmailReservationMembers).where(eq(authEmailReservationMembers.normalizedEmail, key));
        await db.delete(authEmailReservations).where(eq(authEmailReservations.normalizedEmail, key));
      }
      if (kind === 'stale-basis') {
        const prior = randomUUID();
        await db.insert(authEmailProjection).values({
          projectionId: prior,
          isCurrent: false,
          normalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
          phase: 'prepared',
          writerEpoch: 1,
          preparedAt: new Date(),
        });
        await db
          .update(authEmailReservations)
          .set({ basisProjectionId: prior })
          .where(eq(authEmailReservations.normalizedEmail, key));
      }
      const before = await counts();
      expect((await post(owner.input)).status).toBe(503);
      expect(await counts()).toEqual(before);
    },
  );
  it('preserves the exact linked UID inside a current ambiguous group', async () => {
    const owner = await created();
    const key = normalizeAccountEmail(owner.input.email);
    const other = randomUUID();
    await db.insert(users).values({ id: other, email: key.toUpperCase() });
    await db.insert(authEmailReservationMembers).values({ normalizedEmail: key, userId: other });
    await db
      .update(authEmailReservations)
      .set({ state: 'blocked_ambiguous', ownerUserId: null })
      .where(eq(authEmailReservations.normalizedEmail, key));
    const response = await post({
      provider: 'google',
      identityToken: await providers.sign('google', { sub: owner.input.sub }),
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as NativeReply).userId).toBe(owner.reply.userId);
    expect((await counts()).users).toBe(2);
  });
  it('denies a deleted linked subject before minting', async () => {
    const owner = await created();
    await db.transaction((transaction) =>
      recordSecurityMutation(transaction, {
        expectedProjectionId: projectionId,
        expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
        expectedWriterEpoch: 1,
        operationId: randomUUID(),
        userId: owner.reply.userId,
        expectedGeneration: 0,
        kind: 'account-deletion',
        domains: ['first-party', 'partner'],
      }),
    );
    const before = await counts();
    expect((await post(owner.input)).status).toBe(401);
    expect(await counts()).toEqual(before);
  });
  it('does not mistake a dangling provider row for permission to create', async () => {
    const sub = randomUUID();
    await db.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL session_replication_role = 'replica'`);
      await transaction
        .insert(accounts)
        .values({ provider: 'google', providerAccountId: sub, userId: randomUUID(), type: 'oauth' });
    });
    expect((await post(await signed('google', undefined, sub))).status).toBe(503);
    expect(await counts()).toEqual({ ...empty, accounts: 1 });
    expect(userInsertAttempts).toBe(0);
  });
  it.each(['owner-change', 'user-delete'] as const)(
    'rejects a known link changed by a legacy %s across an observed lock wait',
    async (mutation) => {
      const owner = await created();
      const other = await created('apple');
      const refreshBefore = await db.select().from(mobileRefreshTokens).orderBy(mobileRefreshTokens.tokenHash);
      const held = barrier();
      const release = barrier();
      const modifying = db.transaction(async (transaction) => {
        await transaction.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
        if (mutation === 'owner-change')
          await transaction
            .update(accounts)
            .set({ userId: other.reply.userId })
            .where(eq(accounts.providerAccountId, owner.input.sub));
        else await transaction.delete(users).where(eq(users.id, owner.reply.userId));
        held.resolve();
        await release.promise;
      });
      let active: Promise<Response> | undefined;
      try {
        await bounded(held.promise, modifying);
        active = post(owner.input);
        await observedNativeLock(active);
        release.resolve();
        await modifying;
        expect((await active).status).toBe(503);
        expect(userInsertAttempts).toBe(2);
        const persisted = await db.select().from(accounts).where(eq(accounts.providerAccountId, owner.input.sub));
        if (mutation === 'owner-change') {
          expect(persisted).toHaveLength(1);
          expect(persisted[0].userId).toBe(other.reply.userId);
        } else {
          expect(persisted).toEqual([]);
          expect(await db.select().from(users).where(eq(users.id, owner.reply.userId))).toEqual([]);
        }
        expect(await db.select().from(mobileRefreshTokens).orderBy(mobileRefreshTokens.tokenHash)).toEqual(
          mutation === 'owner-change'
            ? refreshBefore
            : refreshBefore.filter((row) => row.userId !== owner.reply.userId),
        );
      } finally {
        release.resolve();
        await Promise.allSettled([modifying, ...(active ? [active] : [])]);
      }
    },
  );
  it('rolls back a new owner when an unfenced provider INSERT wins the actual unique conflict', async () => {
    const existing = await created('apple');
    const input = await signed('google');
    const held = barrier();
    const release = barrier();
    const legacy = db.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
      await transaction
        .insert(accounts)
        .values({ provider: 'google', providerAccountId: input.sub, userId: existing.reply.userId, type: 'oauth' });
      held.resolve();
      await release.promise;
    });
    let active: Promise<Response> | undefined;
    const before = await counts();
    try {
      await bounded(held.promise, legacy);
      active = post(input);
      await observedNativeLock(active);
      release.resolve();
      await legacy;
      expect((await active).status).toBe(503);
      expect(databaseFailure).toEqual({ code: '23505', constraint: 'accounts_provider_providerAccountId_pk' });
      expect(userInsertAttempts).toBe(2);
      expect(await counts()).toEqual({ ...before, accounts: before.accounts + 1 });
    } finally {
      release.resolve();
      await Promise.allSettled([legacy, ...(active ? [active] : [])]);
    }
    const retried = await post(input);
    expect(retried.status).toBe(200);
    expect(((await retried.json()) as NativeReply).userId).toBe(existing.reply.userId);
  });
  it.each(['profile', 'refresh', 'signing'] as const)(
    'rolls all new identity writes back on actual %s failure without private logging',
    async (kind) => {
      const constraint = `ba03_oauth_fault_${suffix}`;
      const table = kind === 'profile' ? userProfiles : mobileRefreshTokens;
      const warning = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
      const error = vi.spyOn(logger, 'error').mockImplementation(() => logger);
      try {
        if (kind === 'signing') vi.stubEnv('NEXTAUTH_SECRET', '');
        else await administrator(sql`ALTER TABLE ${table} ADD CONSTRAINT ${sql.identifier(constraint)} CHECK (false)`);
        const response = await post(await signed('google'));
        expect(response.status).toBe(503);
        if (kind === 'signing')
          expect(await response.json()).toEqual({ error: 'Authentication is temporarily unavailable' });
        if (kind !== 'signing') expect(databaseFailure).toEqual({ code: '23514', constraint });
        expect(await counts()).toEqual(empty);
        expect(JSON.stringify([...warning.mock.calls, ...error.mock.calls])).not.toContain('insert into');
        expect(JSON.stringify([...warning.mock.calls, ...error.mock.calls])).not.toContain('Failed query');
        if (kind === 'signing') expect(error).not.toHaveBeenCalled();
        else
          expect(warning).toHaveBeenCalledWith('[NativeAuth] Reserved OAuth unavailable', {
            category: 'authority-or-database',
          });
      } finally {
        if (kind !== 'signing')
          await administrator(sql`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${sql.identifier(constraint)}`);
      }
    },
  );
  it.each(['wrong-issuer', 'wrong-audience', 'expired', 'missing-exp', 'wrong-algorithm'] as const)(
    'rejects %s through actual JOSE with zero writes',
    async (kind) => {
      const opts =
        kind === 'wrong-issuer'
          ? { issuer: 'https://invalid.example.test' }
          : kind === 'wrong-audience'
            ? { audience: 'unconfigured' }
            : kind === 'expired'
              ? { expiresAt: Math.floor(Date.now() / 1000) - 120 }
              : kind === 'missing-exp'
                ? { omitExpiry: true }
                : { algorithm: 'HS256' as const };
      const token = await providers.sign(
        'google',
        { sub: randomUUID(), email: `${randomUUID()}@example.test`, email_verified: true },
        opts,
      );
      expect((await post({ provider: 'google', identityToken: token })).status).toBe(401);
      expect(await counts()).toEqual(empty);
    },
  );
  it.each([undefined, 0, [], {}, '', '   ', 'A'.repeat(1025), 'é'.repeat(513)])(
    'rejects malformed runtime provider subject %#',
    async (sub) => {
      const token = await providers.sign('google', {
        sub,
        email: `${randomUUID()}@example.test`,
        email_verified: true,
      });
      expect((await post({ provider: 'google', identityToken: token })).status).toBe(401);
      expect(await counts()).toEqual(empty);
    },
  );
  it.each([undefined, '', 'not-an-email', 123])(
    'rejects invalid new email %# without following a current user',
    async (email) => {
      const token = await providers.sign('google', { sub: randomUUID(), email, email_verified: true });
      expect((await post({ provider: 'google', identityToken: token })).status).toBe(401);
      expect(await counts()).toEqual(empty);
    },
  );
  it('retains installed nonce behavior for hashed/raw matches and omitted nonce', async () => {
    const raw = 'owned-raw-nonce';
    for (const nonce of [raw, createHash('sha256').update(raw).digest('hex')]) {
      const token = await providers.sign('apple', {
        sub: randomUUID(),
        email: `${randomUUID()}@example.test`,
        email_verified: true,
        nonce,
      });
      expect((await post({ provider: 'apple', identityToken: token, nonce: raw })).status).toBe(200);
    }
    const token = await providers.sign('apple', {
      sub: randomUUID(),
      email: `${randomUUID()}@example.test`,
      nonce: 'other',
    });
    expect((await post({ provider: 'apple', identityToken: token, nonce: raw })).status).toBe(401);
    expect((await post({ provider: 'apple', identityToken: token })).status).toBe(200);
  });
  it('keeps independent modes/default-off and rejects enabled logging before verification', async () => {
    vi.stubEnv('CURRENT_STORE_NATIVE_REGISTRATION_MODE', 'legacy');
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
    vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', '');
    expect((await post(await signed('google'))).status).toBe(200);
    const before = await counts();
    vi.stubEnv('DEBUG_SQL', 'true');
    expect((await post(await signed('google'))).status).toBe(503);
    expect(await counts()).toEqual(before);
    vi.stubEnv('CURRENT_STORE_NATIVE_OAUTH_MODE', 'legacy');
    vi.stubEnv('CURRENT_STORE_AUTH_PROJECTION_ID', '');
    expect((await post(await signed('google'))).status).toBe(200);
    expect((await counts()).reservations).toBe(before.reservations);
  });
  it.each([
    ['https://accounts.google.com', googleAudience],
    ['accounts.google.com', googleAudience],
    ['https://accounts.google.com', 'owned-native-oauth-ios'],
    ['accounts.google.com', 'owned-native-oauth-ios'],
    ['https://accounts.google.com', 'owned-native-oauth-android'],
    ['accounts.google.com', 'owned-native-oauth-android'],
  ])('accepts actual Google issuer %s and configured audience %s', async (issuer, audience) => {
    const token = await providers.sign(
      'google',
      { sub: randomUUID(), email: `${randomUUID()}@example.test`, email_verified: true },
      { issuer, audience },
    );
    expect((await post({ provider: 'google', identityToken: token })).status).toBe(200);
    expect((await counts()).users).toBe(1);
  });
  it('rejects actual Apple audience mismatch without writes', async () => {
    const token = await providers.sign(
      'apple',
      { sub: randomUUID(), email: `${randomUUID()}@example.test`, email_verified: true },
      { audience: 'unconfigured-apple-audience' },
    );
    expect((await post({ provider: 'apple', identityToken: token })).status).toBe(401);
    expect(await counts()).toEqual(empty);
  });
  it('treats missing configured Google audiences as unavailable before any key lookup', async () => {
    const input = await signed('google');
    for (const name of ['GOOGLE_IOS_CLIENT_ID', 'GOOGLE_ANDROID_CLIENT_ID', 'GOOGLE_WEB_CLIENT_ID'])
      vi.stubEnv(name, '');
    const lookups = providers.counters.google;
    const response = await post(input);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Service temporarily unavailable' });
    expect(await counts()).toEqual(empty);
    expect(providers.counters.google).toBe(lookups);
  });
  it('preserves case-sensitive provider subjects as distinct identities', async () => {
    const sub = `OwnedSubject-${randomUUID()}`;
    const first = await created('google', undefined, sub);
    const second = await created('google', undefined, sub.toLowerCase());
    expect(first.reply.userId).not.toBe(second.reply.userId);
    expect((await counts()).accounts).toBe(2);
    expect((await counts()).users).toBe(2);
  });
});
