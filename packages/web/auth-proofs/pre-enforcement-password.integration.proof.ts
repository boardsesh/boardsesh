import './legacy-credential-fixture';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import postgres from 'postgres';
import { compare, hash } from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { AUTH_COMMAND_PATHS, PRE_ENFORCEMENT_PASSWORD_PATH } from '@boardsesh/auth-protocol';
import { users, userCredentials, authEmailProjection, authSubjectCutoffs } from '@boardsesh/db/schema/auth';
import {
  createCredentialWriterEnvironment,
  ownedCredentialProofUrl,
} from '../../backend/src/auth/authority/__tests__/fixtures/credential-writer-environment';
import { closeCredentialDatabase } from '../../backend/src/auth/credential-database';
import { handleCurrentStorePasswordLogin } from '../../backend/src/handlers/current-store-password-login';
import { handleCurrentStoreWebAuth } from '../../backend/src/handlers/current-store-web-auth';
import { prepareProjectionUnderUsersTableLock } from '../../backend/src/auth/current-store/email-reservations';
import { createYogaInstance } from '../../backend/src/graphql/yoga';
import { stopClientUsageReporter } from '../../backend/src/services/client-usage';
import { createPasswordLoginLimiter } from '../../backend/src/auth/current-store/password-login-limits';
import { createPasswordCompareGate } from '../../backend/src/auth/current-store/password-compare-gate';
import { resetAllRateLimits } from '../../backend/src/utils/rate-limiter';
import { CookieJar, callRoute, patchNextRequestIo } from './route-harness';

const holder = vi.hoisted(() => {
  process.env.NEXTAUTH_SECRET = 'owned-default-password-jwe-secret-6975';
  process.env.NEXTAUTH_URL = 'https://www.boardsesh.com';
  return {
    database: undefined as unknown,
    localCredentialReads: 0,
    claims: [] as { gen?: number; auth_time?: number; authSessionId?: string }[],
    admissions: [] as number[],
  };
});
vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/db/db', () => ({
  getDb: () => {
    const database = holder.database as typeof environment.ownerDatabase;
    if (!database) return database;
    return new Proxy(database, {
      get: (target, property) => {
        if (property !== 'select') return Reflect.get(target, property);
        return (...arguments_: Parameters<typeof database.select>) => {
          const fields = arguments_[0];
          if (fields && ('generation' in fields || 'passwordHash' in fields)) {
            holder.localCredentialReads += 1;
            throw new Error('LOCAL_PASSWORD_GENERATION_READ_FORBIDDEN');
          }
          return database.select(...arguments_);
        };
      },
    });
  },
}));
vi.mock('../../backend/src/db/client', () => ({
  get db() {
    return holder.database;
  },
  get dbRead() {
    return holder.database;
  },
  queueDatabaseEffect: () => false,
  runWithDatabaseTransaction: (work: (database: unknown) => unknown) => work(holder.database),
}));
vi.mock('../../backend/src/auth/admission-pool', () => ({
  readOnAdmissionConnection: async (
    mark: () => void,
    read: (database: typeof environment.ownerDatabase) => PromiseLike<unknown>,
  ) => {
    mark();
    return read(environment.ownerDatabase);
  },
}));
// Keep real web codec/status/timeout validation and mounted backend Yoga admission.
vi.mock('graphql', async () => {
  const { createRequire } = await import('node:module');
  return createRequire(import.meta.url)('graphql') as typeof import('graphql');
});
import * as authRoute from '../app/api/auth/[...nextauth]/route';
import { authOptions } from '../app/lib/auth/auth-options';

const jwtSecret = 'owned-default-password-jwe-secret-6975';
const rpcSecret = 'owned-default-password-private-rpc-secret-6975';
const copyName = `epic6975_identity_import_${randomUUID().replaceAll('-', '')}`;
const email = 'Mixed.Password@example.test';
const oldPassword = ' raw old password ';
const newPassword = ' raw replacement password ';
let environment: Awaited<ReturnType<typeof createCredentialWriterEnvironment>>;
let admin: postgres.Sql;
let server: Server;
let origin: string;
let privatePaths: string[] = [];
let guards: Parameters<typeof handleCurrentStorePasswordLogin>[3];
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
let holdNext: { started: ReturnType<typeof latch>; released: ReturnType<typeof latch> } | undefined;
const heldResponses = new Set<ReturnType<typeof latch>>();
const originalJwt = authOptions.callbacks?.jwt;
async function seed() {
  const userId = randomUUID();
  await environment.ownerDatabase.insert(users).values({
    id: userId,
    email,
    name: 'Climber',
    emailVerified: new Date('2020-01-01'),
    createdAt: new Date('2020-01-01'),
  });
  await environment.ownerDatabase.insert(userCredentials).values({ userId, passwordHash: await hash(oldPassword, 4) });
  return userId;
}
async function login(jar: CookieJar, password = oldPassword) {
  const csrf = await callRoute(authRoute, '/api/auth/csrf', { cookie: jar.header() });
  jar.apply(csrf);
  const body = (await csrf.json()) as { csrfToken: string };
  return callRoute(authRoute, '/api/auth/callback/credentials', {
    cookie: jar.header(),
    form: { csrfToken: body.csrfToken, email, password, json: 'true', callbackUrl: 'https://www.boardsesh.com/' },
  });
}
async function issuedClaims(jar: CookieJar) {
  return getToken({
    req: new NextRequest('https://www.boardsesh.com', { headers: { cookie: jar.header() } }),
    secret: jwtSecret,
  });
}
async function staged(operation: 'forgot-password' | 'reset-password', payload: unknown) {
  const response = await fetch(`${origin}${AUTH_COMMAND_PATHS[operation]}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${rpcSecret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 2, operation, requestId: randomUUID(), issuedAt: Date.now(), payload }),
  });
  const reply = (await response.json()) as Record<string, unknown>;
  expect(response.status).toBe(200);
  return reply;
}
async function enforceAndReset() {
  const projectionId = randomUUID();
  await environment.ownerDatabase.transaction((transaction) =>
    prepareProjectionUnderUsersTableLock(transaction, { projectionId }),
  );
  // Real fixture preparation and enforcement on owned synthetic state; this is
  // not production activation and does not remove the external owner gates.
  await environment.ownerDatabase
    .update(authEmailProjection)
    .set({ phase: 'enforced' })
    .where(eq(authEmailProjection.projectionId, projectionId));
  vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
  vi.stubEnv('CURRENT_STORE_AUTH_PROJECTION_ID', projectionId);
  vi.stubEnv('CURRENT_STORE_AUTH_WRITER_EPOCH', '1');
  vi.stubEnv('CURRENT_STORE_DELETED_EMAIL_KEY', 'owned-default-password-deleted-key-6975');
  const forgot = await staged('forgot-password', { email });
  const plan = forgot.mailPlan as { token: string };
  expect(forgot.outcome).toBe('accepted');
  expect(plan.token).toMatch(/^pr1_/);
  const reset = await staged('reset-password', {
    email,
    token: plan.token,
    password: newPassword,
    confirmPassword: newPassword,
  });
  expect(reset.outcome).toBe('reset');
  vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
}

describe('default password route → strict RPC → restricted LOGIN → real JWT and emitted-cookie admission', () => {
  beforeAll(async () => {
    const target = ownedCredentialProofUrl();
    const template = target.pathname.slice(1);
    target.pathname = '/postgres';
    admin = postgres(target.toString(), { max: 2, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE "${copyName}" TEMPLATE "${template}"`);
    environment = await createCredentialWriterEnvironment('private-registration-v1', { copyDatabase: copyName });
    holder.database = environment.ownerDatabase;
    const yoga = createYogaInstance();
    server = createServer((request, response) => {
      if (request.url === '/graphql') {
        void (async () => {
          const [cutoff] = await environment.ownerDatabase.select().from(authSubjectCutoffs);
          holder.admissions.push(cutoff?.generation ?? 0);
          await yoga.handle(request, response);
        })().catch(() => {
          if (!response.headersSent) response.writeHead(500);
          response.end();
        });
        return;
      }
      privatePaths.push(request.url ?? '');
      if (request.url === PRE_ENFORCEMENT_PASSWORD_PATH && holdNext) {
        const hold = holdNext;
        holdNext = undefined;
        heldResponses.add(hold.released);
        const originalEnd = response.end.bind(response);
        response.end = ((...arguments_: Parameters<typeof response.end>) => {
          hold.started.release();
          void hold.released.promise.then(() => {
            heldResponses.delete(hold.released);
            originalEnd(...arguments_);
          });
          return response;
        }) as typeof response.end;
      }
      void (
        request.url === PRE_ENFORCEMENT_PASSWORD_PATH
          ? handleCurrentStorePasswordLogin(request, response, undefined, guards)
          : handleCurrentStoreWebAuth(request, response)
      ).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Owned HTTP binding missing');
    origin = `http://127.0.0.1:${address.port}`;
    patchNextRequestIo();
    if (!originalJwt || !authOptions.callbacks) throw new Error('Real JWT callback missing');
    authOptions.callbacks.jwt = async (parameters) => {
      const claims = await originalJwt(parameters);
      holder.claims.push({ gen: claims.gen, auth_time: claims.auth_time, authSessionId: claims.authSessionId });
      return claims;
    };
  });
  beforeEach(async () => {
    await closeCredentialDatabase();
    await environment.owner`DELETE FROM public.users`;
    await environment.owner.unsafe(
      'TRUNCATE auth_email_projection,auth_subject_cutoffs,auth_security_mutation_events,auth_password_recovery_state,"verificationTokens" CASCADE',
    );
    for (const [name, content] of Object.entries({
      DATABASE_URL: environment.legacyUrl,
      AUTH_IDENTITY_DATABASE_URL: environment.writerUrl,
      AUTH_IDENTITY_DATABASE_CONTRACT: 'private-registration-v1',
      CURRENT_STORE_AUTH_BACKEND_ORIGIN: origin,
      NEXT_PUBLIC_WS_URL: origin.replace('http://', 'ws://') + '/graphql',
      CURRENT_STORE_AUTH_RPC_SECRET: rpcSecret,
      NEXTAUTH_SECRET: jwtSecret,
      NEXTAUTH_URL: 'https://www.boardsesh.com',
      CURRENT_STORE_WEB_AUTH_MODE: 'legacy',
      CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE: 'off',
      AUTH_BROWSER_SESSION_MODE: 'legacy',
      AUTH_IDENTITY_MIRROR: 'off',
      AUTH_CUTOFF_ENFORCEMENT: 'enforce',
      AUTH_ACCOUNT_GUESS_LIMIT_MODE: 'off',
      AUTH_DEVICE_TOKEN_SECRET: '',
      EMAIL_VERIFICATION_ENABLED: 'false',
      PARTNER_OAUTH_MODE: 'off',
      DEBUG_SQL: 'false',
    }))
      vi.stubEnv(name, content);
    guards = {
      limits: createPasswordLoginLimiter({ redis: () => null, maxPendingRedisCommands: 4 }),
      gate: createPasswordCompareGate(),
    };
    holder.localCredentialReads = 0;
    holder.claims = [];
    holder.admissions = [];
    privatePaths = [];
    resetAllRateLimits();
  });
  afterEach(async () => {
    holdNext = undefined;
    for (const held of heldResponses) held.release();
    await closeCredentialDatabase();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    if (authOptions.callbacks && originalJwt) authOptions.callbacks.jwt = originalJwt;
    vi.restoreAllMocks();
    stopClientUsageReporter();
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await environment?.close();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${copyName}"`);
      await admin.end();
    }
  });
  it.each([false, true])(
    'publishes an actual generation-zero password cookie without a reset, prepared=%s',
    async (prepared) => {
      const userId = await seed();
      if (prepared)
        await environment.ownerDatabase.transaction((transaction) =>
          prepareProjectionUnderUsersTableLock(transaction, { projectionId: randomUUID() }),
        );
      const jar = new CookieJar();
      const response = await login(jar);
      expect(response.status).toBe(200);
      jar.apply(response);
      const claims = await issuedClaims(jar);
      expect(claims).toMatchObject({ sub: userId, gen: 0, link_guarded: true });
      expect(claims?.auth_time).toBeTypeOf('number');
      expect(holder.claims.at(-1)?.auth_time).toBe(claims?.auth_time);
      expect(holder.localCredentialReads).toBe(0);
      expect(privatePaths).toEqual([PRE_ENFORCEMENT_PASSWORD_PATH]);
      expect(holder.admissions).toContain(0);
    },
  );
  it('denies a delayed committed G0 HTTP reply after the real qualified reset commits H1/G1', async () => {
    const userId = await seed();
    const jar = new CookieJar();
    const hold = { started: latch(), released: latch() };
    holdNext = hold;
    const pending = login(jar);
    await hold.started.promise;
    try {
      await enforceAndReset();
    } finally {
      hold.released.release();
    }
    expect(process.env.CURRENT_STORE_WEB_AUTH_MODE).toBe('legacy');
    expect(process.env.CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE).toBe('off');
    const response = await pending;
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(holder.claims.at(-1)).toMatchObject({ gen: 0 });
    expect(holder.admissions).toContain(1);
    expect(holder.localCredentialReads).toBe(0);
    const [credential] = await environment.ownerDatabase
      .select()
      .from(userCredentials)
      .where(eq(userCredentials.userId, userId));
    expect(await compare(oldPassword, credential.passwordHash)).toBe(false);
    expect(await compare(newPassword, credential.passwordHash)).toBe(true);
    const [cutoff] = await environment.ownerDatabase
      .select()
      .from(authSubjectCutoffs)
      .where(eq(authSubjectCutoffs.userId, userId));
    expect(cutoff.generation).toBe(1);
    expect(privatePaths).toEqual([
      PRE_ENFORCEMENT_PASSWORD_PATH,
      AUTH_COMMAND_PATHS['forgot-password'],
      AUTH_COMMAND_PATHS['reset-password'],
    ]);
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    vi.stubEnv('CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE', 'required');
    const fresh = await login(jar, newPassword);
    expect(fresh.status).toBe(200);
    jar.apply(fresh);
    expect((await issuedClaims(jar))?.gen).toBe(1);
    expect(privatePaths.at(-1)).toBe(AUTH_COMMAND_PATHS.password);
  });
  it('refuses reads and rolling-cookie publication after a real reset follows a completed login', async () => {
    await seed();
    const jar = new CookieJar();
    const signedIn = await login(jar);
    expect(signedIn.status).toBe(200);
    jar.apply(signedIn);
    await enforceAndReset();
    const response = await callRoute(authRoute, '/api/auth/session', { cookie: jar.header() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(response.headers.getSetCookie()).toEqual([]);
  });
  it('preserves an existing cookie on default backend configuration failure, with no local password fallback', async () => {
    await seed();
    const jar = new CookieJar();
    const signedIn = await login(jar);
    expect(signedIn.status).toBe(200);
    jar.apply(signedIn);
    const before = jar.header();
    const requests = privatePaths.length;
    vi.stubEnv('CURRENT_STORE_AUTH_BACKEND_ORIGIN', '');
    const unavailable = await login(jar);
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.getSetCookie()).toEqual([]);
    expect(jar.header()).toBe(before);
    expect(holder.localCredentialReads).toBe(0);
    expect(privatePaths).toHaveLength(requests);
  });
});
