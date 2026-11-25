import { decode } from './legacy-credential-fixture';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import {
  hkdf,
  EncryptJWT,
  type JWTPayload,
} from '../../backend/src/auth/authority/__tests__/fixtures/legacy-jwe-crypto';
import postgres from 'postgres';
import { compare } from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  SET_PASSWORD_COMPATIBILITY_PATH,
  setPasswordCompatibilityCommandSchema,
  type SetPasswordCompatibilityCommand,
} from '@boardsesh/auth-protocol';
import { users, userCredentials, authSubjectCutoffs, authPasswordChangeEvidence } from '@boardsesh/db/schema/auth';
import {
  createCredentialWriterEnvironment,
  ownedCredentialProofUrl,
} from '../../backend/src/auth/authority/__tests__/fixtures/credential-writer-environment';
import { closeCredentialDatabase, getCredentialDatabase } from '../../backend/src/auth/credential-database';
import { handleCurrentStoreSetPasswordCompatibility } from '../../backend/src/handlers/current-store-set-password-compatibility';
import { createSetPasswordCompatibilityGuards } from '../../backend/src/auth/current-store/set-password-compatibility-limits';
import { prepareProjectionUnderUsersTableLock } from '../../backend/src/auth/current-store/email-reservations';
import { createYogaInstance } from '../../backend/src/graphql/yoga';
import { stopClientUsageReporter } from '../../backend/src/services/client-usage';
import { resetAllRateLimits } from '../../backend/src/utils/rate-limiter';
import { patchNextRequestIo, servedRequests } from './route-harness';

const holder = vi.hoisted(() => {
  process.env.NEXTAUTH_SECRET = 'owned-set-password-web-jwe-secret-6975';
  process.env.NEXTAUTH_URL = 'https://www.boardsesh.com';
  return { database: undefined as unknown, webReads: 0 };
});
vi.mock('server-only', () => ({}));
vi.mock('next/headers', async () => {
  const { servedRequests: requests } = await import('./route-harness');
  return {
    headers: async () => requests.getStore()?.headers ?? new Headers(),
    cookies: async () => ({ getAll: () => requests.getStore()?.cookies.getAll() ?? [] }),
  };
});
vi.mock('@/app/lib/db/db', () => ({
  getDb: () => {
    if (holder.database) {
      holder.webReads += 1;
      throw new Error('WEB_CREDENTIAL_DATABASE_FORBIDDEN');
    }
    return undefined;
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
    read: (database: Awaited<ReturnType<typeof getCredentialDatabase>>) => PromiseLike<unknown>,
  ) => {
    mark();
    return read(await getCredentialDatabase('private-registration-v1'));
  },
}));
vi.mock('graphql', async () => {
  const { createRequire } = await import('node:module');
  return createRequire(new URL('../../backend/package.json', import.meta.url))('graphql') as typeof import('graphql');
});
// Initialize the no-op adapter fixture before runtime DB-access trapping begins.
import '../app/lib/auth/auth-options';
import { POST } from '../app/api/internal/set-password/route';
import { getAdmittedServerSession } from '../app/lib/auth/admitted-session.server';
import { admittedViewerKey } from '../app/lib/auth/expected-viewer.server';

const secret = 'owned-set-password-web-jwe-secret-6975';
const rpcSecret = 'owned-set-password-web-rpc-secret-6975';
const cookieName = '__Secure-next-auth.session-token';
const password = ' raw é\u0301 chosen password ';
const copyName = `epic6975_identity_import_${randomUUID().replaceAll('-', '')}`;
let environment: Awaited<ReturnType<typeof createCredentialWriterEnvironment>>;
let admin: postgres.Sql;
let server: Server;
let origin: string;
let key: Uint8Array;
let guards: ReturnType<typeof createSetPasswordCompatibilityGuards>;
let loseNextAck = false;
let commands: SetPasswordCompatibilityCommand[] = [];
let primarySources: string[] = [];
let caseNumber = 0;

function incoming(cookie: string, body: unknown, viewer?: string) {
  return new NextRequest('https://www.boardsesh.com/api/internal/set-password', {
    method: 'POST',
    headers: {
      cookie,
      'Content-Type': 'application/json',
      'x-forwarded-for': `192.0.2.${++caseNumber}`,
      ...(viewer === undefined ? {} : { 'X-Boardsesh-Expected-Viewer': viewer }),
    },
    body: JSON.stringify(body),
  });
}
async function resolved(cookie: string) {
  return servedRequests.run(incoming(cookie, {}), () => getAdmittedServerSession({ method: 'POST' }));
}
async function submit(cookie: string, body: unknown = { password, confirmPassword: password }, viewer?: string) {
  const selectedViewer = viewer ?? admittedViewerKey(await resolved(cookie));
  const request = incoming(cookie, body, selectedViewer);
  return servedRequests.run(request, () => POST(request));
}
async function seed() {
  const userId = randomUUID();
  await environment.ownerDatabase
    .insert(users)
    .values({ id: userId, email: `set-password-${userId}@example.test`, name: 'Climber', emailVerified: null });
  return userId;
}
async function credential(userId: string, overrides: Record<string, unknown> = {}, omitted: string[] = []) {
  const now = Math.floor(Date.now() / 1000);
  const claims: JWTPayload = {
    sub: userId,
    gen: 0,
    authSessionId: randomUUID(),
    jti: randomUUID(),
    iat: now - 3600,
    exp: now + 3600,
    auth_time: now - 86400,
    link_guarded: true,
    profileClaimsRefreshedAt: Date.now(),
    ...overrides,
  };
  for (const name of omitted) delete claims[name];
  return new EncryptJWT(claims).setProtectedHeader({ alg: 'dir', enc: 'A256GCM' }).encrypt(key);
}
async function state(userId: string) {
  const [stored] = await environment.ownerDatabase
    .select()
    .from(userCredentials)
    .where(eq(userCredentials.userId, userId));
  const [cutoff] = await environment.ownerDatabase
    .select()
    .from(authSubjectCutoffs)
    .where(eq(authSubjectCutoffs.userId, userId));
  const evidence = await environment.ownerDatabase
    .select()
    .from(authPasswordChangeEvidence)
    .where(eq(authPasswordChangeEvidence.userId, userId));
  return { stored, cutoff, evidence };
}
function unchangedCookies(response: Response) {
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(holder.webReads).toBe(0);
}

describe('default set-password actual source → private writer → qualified LOGIN', () => {
  beforeAll(async () => {
    const target = ownedCredentialProofUrl();
    const template = target.pathname.slice(1);
    target.pathname = '/postgres';
    admin = postgres(target.toString(), { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE "${copyName}" TEMPLATE "${template}"`);
    environment = await createCredentialWriterEnvironment('private-registration-evidence-v1', {
      copyDatabase: copyName,
    });
    holder.database = environment.database;
    key = await hkdf('sha256', new TextEncoder().encode(secret), '', 'NextAuth.js Generated Encryption Key', 32);
    const yoga = createYogaInstance();
    server = createServer((request, response) => {
      if (request.url === '/graphql') {
        primarySources.push(request.headers.authorization?.replace(/^Bearer /, '') ?? '');
        void yoga.handle(request, response);
        return;
      }
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const parsed = setPasswordCompatibilityCommandSchema.safeParse(
          JSON.parse(Buffer.concat(chunks).toString('utf8')),
        );
        if (parsed.success) commands.push(parsed.data);
      });
      if (loseNextAck) {
        loseNextAck = false;
        response.end = (() => {
          response.destroy();
          return response;
        }) as typeof response.end;
      }
      void handleCurrentStoreSetPasswordCompatibility(request, response, undefined, guards);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('OWNED_HTTP_BINDING_REQUIRED');
    origin = `http://127.0.0.1:${address.port}`;
    patchNextRequestIo();
  });
  beforeEach(async () => {
    await closeCredentialDatabase();
    await environment.owner`DELETE FROM public.users`;
    await environment.owner.unsafe(
      'TRUNCATE auth_email_projection,auth_subject_cutoffs,auth_security_mutation_events,"verificationTokens" CASCADE',
    );
    for (const [name, content] of Object.entries({
      DATABASE_URL: environment.legacyUrl,
      AUTH_IDENTITY_DATABASE_URL: environment.writerUrl,
      AUTH_IDENTITY_DATABASE_CONTRACT: 'private-registration-evidence-v1',
      CURRENT_STORE_AUTH_BACKEND_ORIGIN: origin,
      NEXT_PUBLIC_WS_URL: origin.replace('http://', 'ws://') + '/graphql',
      CURRENT_STORE_AUTH_RPC_SECRET: rpcSecret,
      NEXTAUTH_SECRET: secret,
      NEXTAUTH_URL: 'https://www.boardsesh.com',
      CURRENT_STORE_WEB_AUTH_MODE: 'legacy',
      CURRENT_STORE_SET_PASSWORD_MODE: 'legacy',
      CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE: 'off',
      AUTH_BROWSER_SESSION_MODE: 'legacy',
      AUTH_IDENTITY_MIRROR: 'off',
      AUTH_CUTOFF_ENFORCEMENT: 'enforce',
      AUTH_PASSWORD_CHANGE_EVIDENCE_MODE: 'off',
      AUTH_ACCOUNT_GUESS_LIMIT_MODE: 'off',
      AUTH_DEVICE_TOKEN_SECRET: '',
      PARTNER_OAUTH_MODE: 'off',
      DEBUG_SQL: 'false',
    }))
      vi.stubEnv(name, content);
    holder.webReads = 0;
    commands = [];
    primarySources = [];
    loseNextAck = false;
    guards = createSetPasswordCompatibilityGuards({ redis: () => null });
    resetAllRateLimits();
  });
  afterEach(async () => {
    await closeCredentialDatabase();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
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

  it('legacy/default set-password answers as before on the owned current-profile fixture', async () => {
    const userId = await seed();
    const token = await credential(userId);
    const response = await submit(`${cookieName}=${token}`);
    const status = response.status;
    const body: unknown = await response.json();
    expect({ status, body, setCookie: response.headers.getSetCookie() }).toMatchInlineSnapshot(`
      {
        "body": {
          "message": "Password set successfully. You can now log in with your email and password.",
        },
        "setCookie": [],
        "status": 200,
      }
    `);
    const hasPassword = async (id: string) =>
      (await environment.ownerDatabase.select().from(userCredentials).where(eq(userCredentials.userId, id))).length > 0;
    expect(await hasPassword(userId)).toBe(true);
    unchangedCookies(response);
  });
  it.each([false, true])(
    'sets on the actual source without generation/cookie changes, prepared=%s',
    async (prepared) => {
      const userId = await seed();
      if (prepared)
        await environment.ownerDatabase.transaction((transaction) =>
          prepareProjectionUnderUsersTableLock(transaction, { projectionId: randomUUID() }),
        );
      const token = await credential(userId);
      const response = await submit(`${cookieName}=${token}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        message: 'Password set successfully. You can now log in with your email and password.',
      });
      const after = await state(userId);
      expect(await compare(password, after.stored.passwordHash)).toBe(true);
      expect(after.cutoff).toBeUndefined();
      expect(after.evidence).toEqual([]);
      expect(commands).toHaveLength(1);
      expect(commands[0].payload.credential).toBe(token);
      expect(commands[0].payload.viewer.userId).toBe(userId);
      expect(primarySources.every((source) => source === token)).toBe(true);
      const claims = await decode({ token, secret });
      expect(claims?.gen).toBe(0);
      unchangedCookies(response);
    },
  );
  it.each([
    ['missing-exp', {}, ['exp'], 200],
    ['missing-iat', {}, ['iat'], 200],
    ['missing-exp-iat', {}, ['exp', 'iat'], 200],
    ['null-exp', { exp: null }, [], 401],
    ['string-exp', { exp: 'invalid' }, [], 401],
    ['null-iat', { iat: null }, [], 401],
    ['string-iat', { iat: 'invalid' }, [], 401],
    ['future-iat', { iat: Math.floor(Date.now() / 1000) + 3600 }, [], 200],
    ['null-SID', { authSessionId: null }, [], 200],
    ['empty-SID', { authSessionId: '' }, [], 200],
    ['false-SID', { authSessionId: false }, [], 200],
    ['truthy-invalid-SID', { authSessionId: 7 }, [], 200],
    ['missing-SID', {}, ['authSessionId'], 200],
    ['missing-SID-and-jti', {}, ['authSessionId', 'jti'], 409],
    ['missing-age', {}, ['auth_time'], 200],
    ['null-age', { auth_time: null }, [], 200],
    ['unguarded-age', {}, ['link_guarded'], 200],
  ] as const)('retains measured%s outcome', async (_name, overrides, omitted, expected) => {
    const userId = await seed();
    const token = await credential(userId, overrides, [...omitted]);
    const response = await submit(`${cookieName}=${token}`);
    expect(response.status).toBe(expected);
    expect((await state(userId)).stored !== undefined).toBe(expected === 200);
    unchangedCookies(response);
  });
  it('keeps sameUID/differentSID aliases on the selected held source and refuses a stale viewer', async () => {
    const userId = await seed();
    const original = await credential(userId);
    const alternate = await credential(userId);
    const cookie = `${cookieName}=${original}; next-auth.session-token=${alternate}`;
    const response = await submit(cookie);
    expect(response.status).toBe(200);
    expect(commands[0].payload.credential).toBe(original);
    expect(primarySources.every((source) => source === original)).toBe(true);
    const wrongViewer = admittedViewerKey(await resolved(`next-auth.session-token=${alternate}`));
    const stale = await submit(cookie, undefined, wrongViewer);
    expect(stale.status).toBe(409);
    expect(commands).toHaveLength(1);
    unchangedCookies(response);
    unchangedCookies(stale);
  });
  it.each([false, true])(
    'forwards chunked source with family envelope and independent serviceSID cap, large=%s',
    async (large) => {
      const userId = await seed();
      const token = await credential(
        userId,
        large ? { filler: 'x'.repeat(11600) } : { authSessionId: 's'.repeat(1025) },
      );
      const cookie = (token.match(/.{1,3800}/g) ?? [])
        .map((part, index) => `${cookieName}.${index}=${part}`)
        .join('; ');
      const submittedPassword = large ? '界'.repeat(128) : password;
      const response = await submit(cookie, { password: submittedPassword, confirmPassword: submittedPassword });
      expect(response.status).toBe(200);
      expect(commands[0].payload.credential).toBe(token);
      if (large) expect(Buffer.byteLength(JSON.stringify(commands[0]))).toBeGreaterThan(16384);
      else expect(commands[0].payload.viewer.authSessionId).toHaveLength(1025);
      unchangedCookies(response);
    },
  );
  it('does not invent success after a lost commit acknowledgement and rejects exact private replay', async () => {
    const userId = await seed();
    const token = await credential(userId);
    const cookie = `${cookieName}=${token}`;
    loseNextAck = true;
    const response = await submit(cookie);
    expect(response.status).toBe(503);
    expect((await state(userId)).stored).toBeDefined();
    const replay = await fetch(origin + SET_PASSWORD_COMPATIBILITY_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rpcSecret}` },
      body: JSON.stringify(commands[0]),
    });
    expect(replay.status).toBe(503);
    expect(await replay.json()).toMatchObject({ outcome: 'error', code: 'replayed' });
    const next = await submit(cookie);
    expect(next.status).toBe(409);
    unchangedCookies(response);
    unchangedCookies(next);
  });
  it('captures real hash-bound evidence only in explicitly enabled mode', async () => {
    vi.stubEnv('AUTH_PASSWORD_CHANGE_EVIDENCE_MODE', 'on');
    const userId = await seed();
    const token = await credential(userId);
    const response = await submit(`${cookieName}=${token}`);
    expect(response.status).toBe(200);
    expect((await state(userId)).evidence).toHaveLength(1);
    unchangedCookies(response);
  });
});
