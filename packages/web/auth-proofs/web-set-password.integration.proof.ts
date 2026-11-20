// @vitest-environment node
/**
 * #7596 B4b-web: `/api/internal/set-password` under
 * `AUTH_BROWSER_SESSION_MODE=better-auth` presents the request's canonical
 * session (the one resolution the route already read) to the backend's staged
 * set-password command and writes no session cookie on any outcome. With the
 * mode unset the route answers as on main (pinned). Real route export, real
 * backend password, web-session and GraphQL handlers, real PostgreSQL.
 * Nothing scripts a backend reply; a lost reply is the real reply dropped on
 * the way back.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { decode, encode } from './legacy-credential-fixture';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { authSession, userCredentials } from '@boardsesh/db/schema';
import { createEnvironment } from '../../backend/src/auth/authority/__tests__/environment';
import { readFirstPartySession } from '../../backend/src/auth/authority/session-reader';
import { CookieJar, ORIGIN, patchNextRequestIo, servedRequests } from './route-harness';
import {
  BRIDGED,
  DOMAIN,
  LEGACY,
  browserSteps,
  createClimber,
  randomClientAddress,
  startWebSessionBackend,
  stubBetterAuthEnvironment,
  type WebSessionBackend,
} from './web-session-harness';

const holder = vi.hoisted(() => {
  // auth-options reads both when it loads: production www, shared Domain cookie.
  process.env.NEXTAUTH_SECRET = 'web-set-password-proof-nextauth-secret-7596-b4b';
  process.env.NEXTAUTH_URL = 'https://www.boardsesh.com';
  return { database: undefined as unknown };
});
vi.mock('server-only', () => ({}));
// Next's request store, answered from the served request: the raw `Cookie` header, one headers object per request.
vi.mock('next/headers', async () => {
  const { servedRequests: served } = await import('./route-harness');
  return {
    headers: async () => served.getStore()?.headers ?? new Headers(),
    cookies: async () => ({ getAll: () => served.getStore()?.cookies.getAll() ?? [] }),
  };
});
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
// The legacy cookie's admission, answered by the backend's own reader.
vi.mock('../app/lib/auth/credential-admission.server', async (original) => ({
  ...(await original<typeof import('../app/lib/auth/credential-admission.server')>()),
  admitPresentedWebCredential: async (credential: string) => {
    const result = await readFirstPartySession(environment.database, { kind: 'legacy-jwe', credential, secret });
    if (result.status === 'unavailable') throw new Error('Owned authority unavailable');
    return result.status === 'admitted' ? result.session.userId : null;
  },
}));
// The test seam: the preconditions alone, as once the www cutover list is empty.
vi.mock('../app/lib/auth/browser-session-mode.server', async (original) => {
  const actual = await original<typeof import('../app/lib/auth/browser-session-mode.server')>();
  return { ...actual, browserSessionRouteMode: actual.browserSessionRouteModeResolver([]) };
});

import * as authRoute from '../app/api/auth/[...nextauth]/route';
import * as setPasswordRoute from '../app/api/internal/set-password/route';
import { getServerAuthToken } from '../app/lib/auth/server-auth';

const secret = 'web-set-password-proof-nextauth-secret-7596-b4b';
const ACCESS_SECRET = 'web-set-password-proof-access-secret-7596-b4b-web';
const NEW_PASSWORD = 'a brand new password';
const SET_PASSWORD_COMMAND = '/api/internal/auth/current-store/set-password';
const { login, readSession } = browserSteps(authRoute);
let environment: Awaited<ReturnType<typeof createEnvironment>>;
let backend: WebSessionBackend;
let graphqlFetch: (request: Request) => Promise<Response>;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  environment = await createEnvironment();
  holder.database = environment.database;
  backend = await startWebSessionBackend(environment.database);
  patchNextRequestIo();
  const { createYogaInstance } = await import('../../backend/src/graphql/yoga');
  const yoga = createYogaInstance();
  graphqlFetch = async (request) => yoga.fetch(request);
});
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.mocked(console.warn).mockRestore();
  vi.mocked(console.error).mockRestore();
});
afterAll(async () => {
  vi.restoreAllMocks();
  await backend?.close();
  await environment?.close();
});

function betterAuth(): void {
  stubBetterAuthEnvironment(backend.origin);
  vi.stubEnv('AUTH_BROWSER_ACCESS_TOKEN_SECRET', ACCESS_SECRET);
  vi.stubEnv('CURRENT_STORE_SET_PASSWORD_MODE', 'backend-staging');
}

/** A climber signed in by password whose password is then removed, as an account that never had one. */
async function signedInWithoutPassword() {
  const climber = await createClimber(environment.database);
  const jar = new CookieJar();
  await login(jar, climber.email);
  await environment.database.delete(userCredentials).where(eq(userCredentials.userId, climber.id));
  // The legacy twin names the same session in every mode, and reading it writes nothing.
  const twin = await decode({ token: jar.get(LEGACY, DOMAIN) ?? '', secret });
  return { climber, jar, authSessionId: twin?.authSessionId ?? '' };
}

/** The settings card's request, through the guard: the expected viewer header and body. */
async function setPassword(cookie: string, viewer: { userId: string; authSessionId: string }, body = viewer) {
  const request = new NextRequest(new URL('/api/internal/set-password', ORIGIN), {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json',
      'x-forwarded-for': randomClientAddress(),
      'X-Boardsesh-Expected-Viewer': `${viewer.userId}:${viewer.authSessionId}`,
    },
    body: JSON.stringify({
      password: NEW_PASSWORD,
      confirmPassword: NEW_PASSWORD,
      expectedUserId: body.userId,
      expectedAuthSessionId: body.authSessionId,
    }),
  });
  const response = await servedRequests.run(request, () => setPasswordRoute.POST(request));
  return { response, status: response.status, body: (await response.clone().json()) as Record<string, unknown> };
}

/** The 15-minute token a page render forwards for `cookie`. */
async function renderToken(cookie: string) {
  const request = new NextRequest(new URL('/settings', ORIGIN), {
    headers: { cookie, 'x-forwarded-for': randomClientAddress() },
  });
  return servedRequests.run(request, () => getServerAuthToken());
}

async function graphqlViewer(bearer: string) {
  const response = await graphqlFetch(
    new Request('http://backend.invalid/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ query: '{ authenticatedUserId }' }),
    }),
  );
  const body = (await response.json()) as { data?: { authenticatedUserId?: string | null } | null };
  return body.data?.authenticatedUserId ?? null;
}

const hasPassword = async (userId: string) =>
  (await environment.database.select().from(userCredentials).where(eq(userCredentials.userId, userId))).length > 0;

describe('set-password with the mode unset (as on main)', () => {
  it('answers as before', async () => {
    const { climber, jar, authSessionId } = await signedInWithoutPassword();
    const { response, status, body } = await setPassword(jar.header(), { userId: climber.id, authSessionId });
    expect({ status, body, setCookie: response.headers.getSetCookie() }).toMatchInlineSnapshot(`
      {
        "body": {
          "message": "Password set successfully. You can now log in with your email and password.",
        },
        "setCookie": [],
        "status": 200,
      }
    `);
    expect(await hasPassword(climber.id)).toBe(true);
  });
});

describe('set-password under better-auth', () => {
  beforeEach(betterAuth);

  it('sets the password, keeps the session, writes no cookie, ends the old token and a new one works', async () => {
    const { climber, jar, authSessionId } = await signedInWithoutPassword();
    const oldToken = (await renderToken(jar.header())) ?? '';
    expect(await graphqlViewer(oldToken)).toBe(climber.id);
    const { response, status, body } = await setPassword(jar.header(), { userId: climber.id, authSessionId });
    expect(status).toBe(200);
    expect(body).toEqual({ outcome: 'set' });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await hasPassword(climber.id)).toBe(true);
    // Same session, same cookie: the next session read names it; the old 15-minute token is dead.
    expect(((await (await readSession(jar.header())).json()) as { authSessionId?: string }).authSessionId).toBe(
      authSessionId,
    );
    expect(await graphqlViewer(oldToken)).toBeNull();
    const newToken = (await renderToken(jar.header())) ?? '';
    expect(newToken).not.toBe(oldToken);
    expect(await graphqlViewer(newToken)).toBe(climber.id);
    // A retry finds the password set: shown as done, still no cookie.
    const retry = await setPassword(jar.header(), { userId: climber.id, authSessionId });
    expect(retry.status).toBe(409);
    expect(retry.body).toMatchObject({ code: 'already_set' });
    expect(retry.response.headers.getSetCookie()).toEqual([]);
  });

  it('asks a session signed in more than five minutes ago to sign in again, writing nothing', async () => {
    const { climber, jar, authSessionId } = await signedInWithoutPassword();
    await environment.database
      .update(authSession)
      .set({ originalAuthenticatedAt: new Date(Date.now() - 6 * 60_000) })
      .where(eq(authSession.id, authSessionId));
    const { response, status, body } = await setPassword(jar.header(), { userId: climber.id, authSessionId });
    expect(status).toBe(403);
    expect(body).toEqual({ error: 'reauthentication_required' });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await hasPassword(climber.id)).toBe(false);
  });

  it('asks a bridged session to sign in again (acceptance 4), writing nothing', async () => {
    const climber = await createClimber(environment.database);
    await environment.database.delete(userCredentials).where(eq(userCredentials.userId, climber.id));
    const authSessionId = randomUUID();
    const legacy = await encode({
      token: { sub: climber.id, authSessionId, gen: 0, auth_time: Math.floor(Date.now() / 1000), link_guarded: true },
      secret,
      maxAge: 3600,
    });
    const jar = new CookieJar();
    jar.set(LEGACY, legacy, DOMAIN);
    // The page's own session read bridges first.
    jar.apply(await readSession(jar.header(), 'GET', '', { bridges: true }));
    expect(jar.get(BRIDGED, DOMAIN)).toBeDefined();
    const { response, status, body } = await setPassword(jar.header(), { userId: climber.id, authSessionId });
    expect(status).toBe(403);
    expect(body).toEqual({ error: 'reauthentication_required' });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await hasPassword(climber.id)).toBe(false);
  });

  it('asks a request known only by its legacy cookie to sign in again, never acting on that cookie', async () => {
    const climber = await createClimber(environment.database);
    await environment.database.delete(userCredentials).where(eq(userCredentials.userId, climber.id));
    const authSessionId = randomUUID();
    const legacy = await encode({
      token: { sub: climber.id, authSessionId, gen: 0, auth_time: Math.floor(Date.now() / 1000) },
      secret,
      maxAge: 3600,
    });
    const { response, status, body } = await setPassword(`${LEGACY}=${legacy}`, { userId: climber.id, authSessionId });
    // Not "try again": a browser whose bridge never sets a cookie would never get past it.
    expect(status).toBe(403);
    expect(body).toEqual({ error: 'reauthentication_required' });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await hasPassword(climber.id)).toBe(false);
  });

  it('answers identity_changed, asking for a reload from the root, when the tab expected another login', async () => {
    const { climber, jar, authSessionId } = await signedInWithoutPassword();
    const { response, status, body } = await setPassword(
      jar.header(),
      { userId: climber.id, authSessionId },
      { userId: climber.id, authSessionId: randomUUID() },
    );
    expect(status).toBe(409);
    expect(body).toEqual({ error: 'identity_changed', reload: 'root' });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await hasPassword(climber.id)).toBe(false);
  });

  it('answers 503 with no cookie when the reply is lost after the commit, and the retry shows it done', async () => {
    const { climber, jar, authSessionId } = await signedInWithoutPassword();
    // The command reaches the backend and commits; its reply never comes back.
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const reply = await realFetch(input, init);
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === SET_PASSWORD_COMMAND) throw new TypeError('reply lost');
      return reply;
    });
    const lost = await setPassword(jar.header(), { userId: climber.id, authSessionId });
    vi.unstubAllGlobals();
    expect(lost.status).toBe(503);
    expect(lost.response.headers.getSetCookie()).toEqual([]);
    expect(await hasPassword(climber.id)).toBe(true);
    const retry = await setPassword(jar.header(), { userId: climber.id, authSessionId });
    expect(retry.status).toBe(409);
    expect(retry.body).toMatchObject({ code: 'already_set' });
  });

  it('refuses a session that has ended (the guard sees another viewer), writing no cookie', async () => {
    const { climber, jar, authSessionId } = await signedInWithoutPassword();
    await environment.database.delete(authSession).where(eq(authSession.id, authSessionId));
    const { status, body, response } = await setPassword(jar.header(), { userId: climber.id, authSessionId });
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'viewer_changed' });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await hasPassword(climber.id)).toBe(false);
  });
});
