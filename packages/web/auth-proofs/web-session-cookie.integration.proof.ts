// @vitest-environment node
/**
 * #7596 B1c with `AUTH_BROWSER_SESSION_MODE=better-auth`: the real
 * `/api/auth/[...nextauth]` route exports write and clear the first-party
 * session cookie, and read the session, against the real backend handlers
 * over HTTP and real PostgreSQL. Nothing scripts a backend reply: an outage is
 * the real handler switched off, and the transport's 401 is the real handler
 * refusing a request that carries an `Origin`.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { hash } from 'bcryptjs';
import { decode, encode } from 'next-auth/jwt';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { signBrowserSessionCookie } from '@boardsesh/auth-protocol/browser-session-cookie';
import { authEmailProjection, userCredentials, users } from '@boardsesh/db/schema';
import { createEnvironment } from '../../backend/src/auth/authority/__tests__/environment';
import { readFirstPartySession } from '../../backend/src/auth/authority/session-reader';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../backend/src/auth/current-store/foundation-context';
import { createPasswordCompareGate } from '../../backend/src/auth/current-store/password-compare-gate';
import { createPasswordLoginLimiter } from '../../backend/src/auth/current-store/password-login-limits';
import { handleCurrentStoreWebAuth } from '../../backend/src/handlers/current-store-web-auth';
import { handleCurrentStoreWebSession } from '../../backend/src/handlers/current-store-web-session';
import { CookieJar, callRoute, patchNextRequestIo, setCookieNames, setCookies } from './route-harness';

const holder = vi.hoisted(() => {
  // auth-options reads both when it loads: production www, shared Domain cookie.
  process.env.NEXTAUTH_SECRET = 'web-session-cookie-proof-nextauth-secret-7596';
  process.env.NEXTAUTH_URL = 'https://www.boardsesh.com';
  return { database: undefined as unknown };
});
vi.mock('server-only', () => ({}));
vi.mock('@auth/drizzle-adapter', () => ({ DrizzleAdapter: () => ({}) }));
vi.mock('@/app/lib/db/db', () => ({ getDb: () => holder.database }));
vi.mock('../../backend/src/db/client', () => ({
  get db() {
    return holder.database;
  },
}));
vi.mock('../../backend/src/auth/admission-pool', () => ({
  readOnAdmissionConnection: async (mark: () => void, read: (database: unknown) => PromiseLike<unknown>) => {
    mark();
    return read(holder.database);
  },
}));
// The legacy cookie's GraphQL admission, answered by the backend's own reader.
vi.mock('../app/lib/auth/credential-admission.server', async (original) => ({
  ...(await original<typeof import('../app/lib/auth/credential-admission.server')>()),
  admitPresentedWebCredential: async (credential: string) => {
    const result = await readFirstPartySession(environment.database, { kind: 'legacy-jwe', credential, secret });
    if (result.status === 'unavailable') throw new Error('Owned authority unavailable');
    return result.status === 'admitted' ? result.session.userId : null;
  },
}));

import * as authRoute from '../app/api/auth/[...nextauth]/route';

const secret = 'web-session-cookie-proof-nextauth-secret-7596';
const cookieSecret = 'web-session-cookie-proof-browser-cookie-secret-7596';
const rpcSecret = randomBytes(32).toString('base64url');
const projectionId = 'web-session-cookie-proof-projection';
const PASSWORD = 'web session cookie proof password';
const LOGIN = '__Secure-boardsesh.session_token';
const BRIDGED = '__Secure-boardsesh.bridged_session_token';
const LEGACY = '__Secure-next-auth.session-token';
const SESSION_COOKIE_NAMES = [LOGIN, BRIDGED, LEGACY, 'next-auth.session-token'];

let environment: Awaited<ReturnType<typeof createEnvironment>>;
let backend: Server;
let originRefusingBackend: Server;
let origin: string;
let refusingOrigin: string;
const sockets = new Set<Socket>();

async function listen(handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>) {
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Owned command server failed to bind');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

beforeAll(async () => {
  environment = await createEnvironment();
  holder.database = environment.database;
  await environment.database.insert(authEmailProjection).values({
    projectionId,
    normalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
    writerEpoch: 1,
    phase: 'enforced',
    preparedAt: new Date(),
  });
  const guards = { limits: createPasswordLoginLimiter({ redis: () => null }), gate: createPasswordCompareGate() };
  const real = await listen((request, response) =>
    request.url?.startsWith('/api/internal/auth/current-store/web-session/v1/')
      ? handleCurrentStoreWebSession(request, response, environment.database)
      : handleCurrentStoreWebAuth(request, response, environment.database, guards),
  );
  backend = real.server;
  origin = real.origin;
  // The real handler, reached with a browser Origin: it answers its own 401 { error: 'unauthorized' }.
  const refusing = await listen((request, response) => {
    request.headers.origin = 'https://www.boardsesh.com';
    return handleCurrentStoreWebSession(request, response, environment.database);
  });
  originRefusingBackend = refusing.server;
  refusingOrigin = refusing.origin;
  patchNextRequestIo();
});
beforeEach(() => {
  for (const [name, content] of Object.entries({
    AUTH_BROWSER_SESSION_MODE: 'better-auth',
    AUTH_BROWSER_SESSION_COOKIE_SECRET: cookieSecret,
    CURRENT_STORE_AUTH_BACKEND_ORIGIN: origin,
    CURRENT_STORE_AUTH_RPC_SECRET: rpcSecret,
    CURRENT_STORE_WEB_AUTH_MODE: 'backend-staging',
    CURRENT_STORE_WEB_SESSION_MODE: 'backend-staging',
    CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE: 'required',
    CURRENT_STORE_AUTH_PROJECTION_ID: projectionId,
    CURRENT_STORE_AUTH_WRITER_EPOCH: '1',
    CURRENT_STORE_DELETED_EMAIL_KEY: 'web-session-cookie-proof-retired-mailbox-key',
    AUTH_CUTOFF_ENFORCEMENT: 'enforce',
    EMAIL_VERIFICATION_ENABLED: 'false',
    DEBUG_SQL: 'false',
    PARTNER_OAUTH_MODE: 'off',
  }))
    vi.stubEnv(name, content);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(console.warn).mockRestore();
});
afterAll(async () => {
  vi.restoreAllMocks();
  for (const socket of sockets) socket.destroy();
  for (const server of [backend, originRefusingBackend])
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await environment?.close();
});

async function climber() {
  const id = randomUUID();
  const email = `web-session-cookie-${id}@example.test`;
  await environment.database.insert(users).values({ id, email, name: 'Climber', emailVerified: new Date() });
  await environment.database.insert(userCredentials).values({ userId: id, passwordHash: await hash(PASSWORD, 4) });
  return { id, email };
}

async function csrf(jar: CookieJar): Promise<string> {
  const response = await callRoute(authRoute, '/api/auth/csrf', { cookie: jar.header() });
  expect(setCookieNames(response).filter((name) => SESSION_COOKIE_NAMES.includes(name))).toEqual([]);
  jar.apply(response);
  return ((await response.json()) as { csrfToken: string }).csrfToken;
}

async function login(jar: CookieJar, email: string, password = PASSWORD) {
  const csrfToken = await csrf(jar);
  const response = await callRoute(authRoute, '/api/auth/callback/credentials', {
    cookie: jar.header(),
    form: { csrfToken, email, password, json: 'true', callbackUrl: 'https://www.boardsesh.com/' },
  });
  jar.apply(response);
  return response;
}

async function readSession(cookie: string, method: 'GET' | 'POST' = 'GET', csrfToken = '') {
  const response = await callRoute(authRoute, '/api/auth/session', {
    cookie,
    ...(method === 'POST' ? { form: { csrfToken } } : {}),
  });
  expect(setCookieNames(response).filter((name) => SESSION_COOKIE_NAMES.includes(name))).toEqual([]);
  return response;
}

async function signOut(jar: CookieJar, expected: { userId: string; authSessionId: string }, csrfToken?: string) {
  const token = csrfToken ?? (await csrf(jar));
  return callRoute(authRoute, '/api/auth/signout', {
    cookie: jar.header(),
    form: {
      csrfToken: token,
      callbackUrl: 'https://www.boardsesh.com/',
      json: 'true',
      expectedUserId: expected.userId,
      expectedAuthSessionId: expected.authSessionId,
    },
  });
}

/** The raw session token inside the login cookie the jar holds (Domain scope). */
function loginToken(jar: CookieJar): string {
  const signed = jar.get(LOGIN, '.boardsesh.com');
  if (!signed) throw new Error('No login cookie');
  return signed.slice(0, signed.indexOf('.'));
}

async function canonicalStatus(token: string) {
  return (await readFirstPartySession(environment.database, { kind: 'canonical-token', token })).status;
}

type SessionJson = { user?: { id: string }; authSessionId?: string };

describe('login', () => {
  it('writes the login cookie, clears the bridged name and the host-only login copy, and keeps the legacy cookie on the same session', async () => {
    const climberA = await climber();
    const jar = new CookieJar();
    const response = await login(jar, climberA.email);
    expect(response.status).toBe(200);
    const written = setCookies(response);
    expect(written.filter((header) => header.startsWith(`${LOGIN}=`))).toEqual([
      `${LOGIN}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`,
      expect.stringMatching(
        new RegExp(
          `^${LOGIN}=[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{43}; Path=/; Domain=\\.boardsesh\\.com; Max-Age=34560000; HttpOnly; SameSite=Lax; Secure$`,
        ),
      ),
    ]);
    expect(written.filter((header) => header.startsWith(`${BRIDGED}=`))).toEqual([
      `${BRIDGED}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`,
      `${BRIDGED}=; Path=/; Domain=.boardsesh.com; Max-Age=0; HttpOnly; SameSite=Lax; Secure`,
    ]);
    const session = (await (await readSession(jar.header())).json()) as SessionJson;
    expect(session.user?.id).toBe(climberA.id);
    const legacy = await decode({ token: jar.get(LEGACY, '.boardsesh.com') ?? '', secret });
    expect(legacy?.authSessionId).toBe(session.authSessionId);
    expect(await canonicalStatus(loginToken(jar))).toBe('admitted');
  });

  it("as B while holding A's cookies revokes A's session and sets B's cookie", async () => {
    const [climberA, climberB] = [await climber(), await climber()];
    const jar = new CookieJar();
    await login(jar, climberA.email);
    const tokenA = loginToken(jar);
    const legacyA = jar.get(LEGACY, '.boardsesh.com') ?? '';
    await login(jar, climberB.email);
    expect(((await (await readSession(jar.header())).json()) as SessionJson).user?.id).toBe(climberB.id);
    expect(await canonicalStatus(tokenA)).not.toBe('admitted');
    const legacyStatus = await readFirstPartySession(environment.database, {
      kind: 'legacy-jwe',
      credential: legacyA,
      secret,
    });
    expect(legacyStatus.status).not.toBe('admitted');
  });

  it('with a wrong password changes nothing and writes no session cookie', async () => {
    const climberA = await climber();
    const jar = new CookieJar();
    await login(jar, climberA.email);
    const before = jar.header();
    const response = await login(jar, climberA.email, 'not the password');
    expect(response.status).toBe(401);
    expect(setCookieNames(response).filter((name) => SESSION_COOKIE_NAMES.includes(name))).toEqual([]);
    expect(await canonicalStatus(loginToken(jar))).toBe('admitted');
    expect(jar.header()).toBe(before);
  });

  it('drops an oversized legacy cookie before the command and still signs in', async () => {
    const climberA = await climber();
    const jar = new CookieJar();
    jar.set(LEGACY, 'x'.repeat(12_289), '.boardsesh.com');
    const response = await login(jar, climberA.email);
    expect(response.status).toBe(200);
    expect(((await (await readSession(jar.header())).json()) as SessionJson).user?.id).toBe(climberA.id);
  });

  it('answers 503 and writes nothing when the backend is off', async () => {
    const climberA = await climber();
    const jar = new CookieJar();
    vi.stubEnv('CURRENT_STORE_WEB_SESSION_MODE', 'legacy');
    const response = await login(jar, climberA.email);
    expect(response.status).toBe(503);
    expect(setCookies(response)).toEqual([]);
  });
});

describe('session read', () => {
  it('answers the NextAuth JSON shape from the backend, with no session Set-Cookie on GET, POST or csrf', async () => {
    const climberA = await climber();
    const jar = new CookieJar();
    await login(jar, climberA.email);
    const viaGet = await readSession(jar.header());
    expect(viaGet.status).toBe(200);
    expect(viaGet.headers.get('cache-control')).toBe('private, no-store');
    const body = (await viaGet.json()) as Record<string, unknown>;
    expect(body).toEqual({
      user: { name: 'Climber', email: climberA.email, image: null, id: climberA.id },
      expires: expect.any(String),
      authGeneration: 0,
      authSessionId: expect.any(String),
    });
    const csrfToken = await csrf(jar);
    const viaPost = await readSession(jar.header(), 'POST', csrfToken);
    expect(await viaPost.json()).toEqual(body);
  });

  it('answers a legacy-only cookie from the legacy path, without rewriting it', async () => {
    const climberA = await climber();
    const authSessionId = randomUUID();
    const legacy = await encode({ token: { sub: climberA.id, authSessionId, gen: 0 }, secret, maxAge: 3600 });
    const response = await readSession(`${LEGACY}=${legacy}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user: { id: climberA.id }, authSessionId });
  });

  it('reads a conflicted login cookie as signed out, never falling back to the bridged or legacy cookie', async () => {
    const climberA = await climber();
    const jar = new CookieJar();
    await login(jar, climberA.email);
    const token = loginToken(jar);
    const bridged = signBrowserSessionCookie('bridged', token, cookieSecret);
    const cookie = [
      `${LOGIN}=${jar.get(LOGIN, '.boardsesh.com')}`,
      `${LOGIN}=${signBrowserSessionCookie('login', randomBytes(32).toString('base64url'), cookieSecret)}`,
      `${BRIDGED}=${bridged}`,
      `${LEGACY}=${jar.get(LEGACY, '.boardsesh.com')}`,
    ].join('; ');
    const response = await readSession(cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
  });

  it('answers 503 with no Set-Cookie when the backend is off or refuses the channel', async () => {
    const climberA = await climber();
    const jar = new CookieJar();
    await login(jar, climberA.email);
    vi.stubEnv('CURRENT_STORE_WEB_SESSION_MODE', 'legacy');
    expect((await readSession(jar.header())).status).toBe(503);
    vi.stubEnv('CURRENT_STORE_WEB_SESSION_MODE', 'backend-staging');
    vi.stubEnv('CURRENT_STORE_AUTH_BACKEND_ORIGIN', refusingOrigin);
    expect((await readSession(jar.header())).status).toBe(503);
  });
});

describe('sign-out', () => {
  async function signedIn() {
    const climberA = await climber();
    const jar = new CookieJar();
    await login(jar, climberA.email);
    const session = (await (await readSession(jar.header())).json()) as { authSessionId: string };
    return { jar, expected: { userId: climberA.id, authSessionId: session.authSessionId } };
  }

  it('answers 409 and clears nothing when the cookie carries another login', async () => {
    const { jar, expected } = await signedIn();
    const response = await signOut(jar, { ...expected, authSessionId: randomUUID() });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'signout_identity_changed' });
    expect(setCookies(response)).toEqual([]);
    expect(await canonicalStatus(loginToken(jar))).toBe('admitted');
  });

  it('ends the session and clears all four session cookie names', async () => {
    const { jar, expected } = await signedIn();
    const token = loginToken(jar);
    const response = await signOut(jar, expected);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: 'https://www.boardsesh.com/' });
    const cleared = setCookies(response).filter((header) => /^[^=]+=;/.test(header));
    for (const name of [LOGIN, BRIDGED, LEGACY, 'next-auth.session-token']) {
      expect(cleared.some((header) => header.startsWith(`${name}=;`) && !/Domain=/.test(header))).toBe(true);
      expect(cleared.some((header) => header.startsWith(`${name}=;`) && /Domain=\.boardsesh\.com/.test(header))).toBe(
        true,
      );
    }
    expect(await canonicalStatus(token)).not.toBe('admitted');
  });

  it('signs out a browser holding only the login cookie', async () => {
    const { jar, expected } = await signedIn();
    const token = loginToken(jar);
    const onlyLogin = new CookieJar();
    onlyLogin.set(LOGIN, jar.get(LOGIN, '.boardsesh.com') ?? '', '.boardsesh.com');
    const response = await signOut(onlyLogin, expected);
    expect(response.status).toBe(200);
    expect(setCookieNames(response)).toContain(LOGIN);
    expect(await canonicalStatus(token)).not.toBe('admitted');
  });

  it("keeps NextAuth's CSRF refusal: nothing ends and nothing is cleared", async () => {
    const { jar, expected } = await signedIn();
    await csrf(jar);
    const response = await signOut(jar, expected, 'not-the-csrf-token');
    expect(setCookieNames(response).filter((name) => SESSION_COOKIE_NAMES.includes(name))).toEqual([]);
    expect(await canonicalStatus(loginToken(jar))).toBe('admitted');
  });

  it('answers 503 and clears nothing when the backend is off', async () => {
    const { jar, expected } = await signedIn();
    vi.stubEnv('CURRENT_STORE_WEB_SESSION_MODE', 'legacy');
    const response = await signOut(jar, expected);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'signout_authority_unavailable' });
    expect(setCookies(response)).toEqual([]);
    vi.stubEnv('CURRENT_STORE_WEB_SESSION_MODE', 'backend-staging');
    expect(await canonicalStatus(loginToken(jar))).toBe('admitted');
  });
});
