// @vitest-environment node
/**
 * #7596 B3b: `/api/internal/ws-auth` hands browser JavaScript the backend's
 * 15-minute access token under `AUTH_BROWSER_SESSION_MODE=better-auth`, through
 * the real route exports, the real backend web-session handlers over HTTP, the
 * real backend GraphQL endpoint (Yoga, in process) and real PostgreSQL.
 * Nothing scripts a backend reply. With the mode unset or `legacy` the route
 * answers exactly as on main (the snapshot below was written from main's route).
 * The www cutover list is replaced through its test seam, never from the env.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { encode, type JWT } from './legacy-credential-fixture';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { signBrowserSessionCookie } from '@boardsesh/auth-protocol/browser-session-cookie';
import { authSession } from '@boardsesh/db/schema';
import { createEnvironment } from '../../backend/src/auth/authority/__tests__/environment';
import { readFirstPartySession } from '../../backend/src/auth/authority/session-reader';
import { CookieJar, ORIGIN, normalizedResponse, patchNextRequestIo, setCookies } from './route-harness';
import {
  BRIDGED,
  COOKIE_SECRET,
  DOMAIN,
  LEGACY,
  LOGIN,
  browserSteps,
  createClimber,
  randomClientAddress,
  startWebSessionBackend,
  stubBetterAuthEnvironment,
  type WebSessionBackend,
} from './web-session-harness';

const holder = vi.hoisted(() => {
  // auth-options reads both when it loads: production www, shared Domain cookie.
  process.env.NEXTAUTH_SECRET = 'ws-auth-access-token-proof-nextauth-secret-7596';
  process.env.NEXTAUTH_URL = 'https://www.boardsesh.com';
  return { database: undefined as unknown };
});
vi.mock('server-only', () => ({}));
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
import { GET as wsAuthRoute } from '../app/api/internal/ws-auth/route';
import { BRIDGES_PER_CLIENT } from '../app/lib/auth/browser-session-bridge.server';

const secret = 'ws-auth-access-token-proof-nextauth-secret-7596';
const ACCESS_SECRET = 'ws-auth-access-token-proof-access-secret-7596-b3b';
const { login, readSession, signOut } = browserSteps(authRoute);
let environment: Awaited<ReturnType<typeof createEnvironment>>;
let backend: WebSessionBackend;
let graphqlFetch: (request: Request) => Promise<Response>;

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
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(console.warn).mockRestore();
});
afterAll(async () => {
  vi.restoreAllMocks();
  await backend?.close();
  await environment?.close();
});

function betterAuth(): void {
  stubBetterAuthEnvironment(backend.origin);
  vi.stubEnv('AUTH_BROWSER_ACCESS_TOKEN_SECRET', ACCESS_SECRET);
}

type WsAuthBody = {
  token: string | null;
  authenticated?: boolean;
  userId?: string;
  authSessionId?: string;
  expiresAt?: string;
  expiresIn?: number;
};
type SessionJson = { user?: { id: string }; authSessionId?: string };

async function wsAuth(cookie: string, clientAddress = randomClientAddress()): Promise<Response> {
  return wsAuthRoute(
    new NextRequest(new URL('/api/internal/ws-auth', ORIGIN), {
      headers: { cookie, 'x-forwarded-for': clientAddress },
    }),
  );
}

/** The backend's own GraphQL endpoint, asked who the bearer is. */
async function graphqlViewer(bearer: string) {
  const response = await graphqlFetch(
    new Request('http://backend.invalid/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ query: '{ authenticatedUserId }' }),
    }),
  );
  return { status: response.status, body: (await response.json()) as { data?: { authenticatedUserId?: string } } };
}

/** Status, body and every `Set-Cookie`, with a string token replaced. */
async function normalizedWsAuth(response: Response) {
  const normalized = await normalizedResponse(response);
  const body = normalized.body as Record<string, unknown>;
  return { ...normalized, body: typeof body.token === 'string' ? { ...body, token: '<token>' } : body };
}

/** A NextAuth cookie from before the switch: a login with its own session id. */
async function legacyLogin(claims: Partial<JWT> = {}) {
  const climber = await createClimber(environment.database);
  const authSessionId = randomUUID();
  const credential = await encode({
    token: { sub: climber.id, authSessionId, gen: 0, auth_time: Math.floor(Date.now() / 1000), ...claims },
    secret,
    maxAge: 3600,
  });
  return { climber, authSessionId, credential };
}

describe('ws-auth with the mode unset or legacy', () => {
  it.each([undefined, '', 'legacy'])('answers as on main (mode %j)', async (mode) => {
    if (mode !== undefined) vi.stubEnv('AUTH_BROWSER_SESSION_MODE', mode);
    const climber = await createClimber(environment.database);
    const jar = new CookieJar();
    await login(jar, climber.email);
    const signedIn = await wsAuth(jar.header());
    const body = (await signedIn.clone().json()) as WsAuthBody;
    // The raw NextAuth JWE, as on main.
    expect(body.token).toBe(jar.get(LEGACY, DOMAIN));
    expect(await normalizedWsAuth(signedIn)).toMatchInlineSnapshot(`
      {
        "body": {
          "authSessionId": "<uuid>",
          "authenticated": true,
          "token": "<token>",
          "userId": "<uuid>",
        },
        "cacheControl": "private, no-store",
        "location": null,
        "setCookies": [],
        "status": 200,
      }
    `);
    expect(await normalizedWsAuth(await wsAuth(''))).toMatchInlineSnapshot(`
      {
        "body": {
          "authenticated": false,
          "token": null,
        },
        "cacheControl": "private, no-store",
        "location": null,
        "setCookies": [],
        "status": 200,
      }
    `);
  });
});

/** What the session read and ws-auth say about one cookie header: the ids must be the same. */
async function bothAnswers(cookie: string, clientAddress = randomClientAddress()) {
  const session = (await (await readSession(cookie, 'GET', '', { writes: true, clientAddress })).json()) as SessionJson;
  const tokenResponse = await wsAuth(cookie, clientAddress);
  expect(setCookies(tokenResponse)).toEqual([]);
  expect(tokenResponse.headers.get('cache-control')).toBe('private, no-store');
  const token = (await tokenResponse.json()) as WsAuthBody;
  return { session, token, status: tokenResponse.status };
}

function expectSameIds(session: SessionJson, token: WsAuthBody): void {
  expect(token.userId).toBe(session.user?.id);
  expect(token.authSessionId).toBe(session.authSessionId);
}

describe('ws-auth under better-auth', () => {
  beforeEach(betterAuth);

  it('answers a 15-minute token the backend GraphQL endpoint accepts, with the session read ids, until sign-out', async () => {
    const climber = await createClimber(environment.database);
    const jar = new CookieJar();
    await login(jar, climber.email);
    const { session, token, status } = await bothAnswers(jar.header());
    expect(status).toBe(200);
    expect(token.authenticated).toBe(true);
    expectSameIds(session, token);
    expect(token.userId).toBe(climber.id);
    // Neither cookie's credential: a three-part signed token that ends within 15 minutes.
    expect(token.token?.split('.')).toHaveLength(3);
    expect(token.token).not.toBe(jar.get(LEGACY, DOMAIN));
    expect(jar.get(LOGIN, DOMAIN)?.startsWith(`${token.token}.`)).toBe(false);
    const remainingMs = Date.parse(token.expiresAt ?? '') - Date.now();
    expect(remainingMs).toBeGreaterThan(14 * 60_000);
    expect(remainingMs).toBeLessThanOrEqual(15 * 60_000);
    // The lifetime clients time their refresh by, from receipt.
    expect(token.expiresIn).toBeGreaterThan(14 * 60);
    expect(token.expiresIn).toBeLessThanOrEqual(15 * 60);
    const bearer = token.token ?? '';
    expect(await graphqlViewer(bearer)).toEqual({ status: 200, body: { data: { authenticatedUserId: climber.id } } });

    const cookiesBeforeSignOut = jar.header();
    const signedOut = await signOut(jar, { userId: climber.id, authSessionId: session.authSessionId ?? '' });
    expect(signedOut.status).toBe(200);
    expect((await graphqlViewer(bearer)).status).toBe(401);
    // The dead cookie the browser may still send: 401, nothing written.
    const dead = await wsAuth(cookiesBeforeSignOut);
    expect(dead.status).toBe(401);
    expect(await dead.json()).toEqual({ token: null, authenticated: false });
    expect(setCookies(dead)).toEqual([]);
  });

  it('answers 401 for a dead login cookie and never falls back to a valid legacy cookie beside it', async () => {
    const climber = await createClimber(environment.database);
    const jar = new CookieJar();
    await login(jar, climber.email);
    const loginCookie = `${LOGIN}=${jar.get(LOGIN, DOMAIN)}`;
    const { authSessionId } = (await (await readSession(jar.header())).json()) as SessionJson;
    await signOut(jar, { userId: climber.id, authSessionId: authSessionId ?? '' });
    const older = await legacyLogin({ auth_time: Math.floor(Date.now() / 1000) - 7200 });
    const cookie = `${loginCookie}; ${LEGACY}=${older.credential}`;
    const { session, status } = await bothAnswers(cookie);
    expect(session).toEqual({});
    expect(status).toBe(401);
  });

  it('bridges a browser signed in before the switch without writing a cookie, and keeps its ids after the session read bridges', async () => {
    const { climber, authSessionId, credential } = await legacyLogin();
    const legacyOnly = `${LEGACY}=${credential}`;
    const first = await wsAuth(legacyOnly);
    expect(first.status).toBe(200);
    expect(setCookies(first)).toEqual([]);
    const token = (await first.json()) as WsAuthBody;
    expect(token).toMatchObject({ authenticated: true, userId: climber.id, authSessionId });
    expect(await graphqlViewer(token.token ?? '')).toMatchObject({ status: 200 });

    const bridgingRead = await readSession(legacyOnly, 'GET', '', { bridges: true });
    const jar = new CookieJar();
    jar.set(LEGACY, credential, DOMAIN);
    jar.apply(bridgingRead);
    expect(jar.get(BRIDGED, DOMAIN)).toBeDefined();
    const afterBridge = await bothAnswers(jar.header());
    expectSameIds(afterBridge.session, afterBridge.token);
    expect(afterBridge.token.authSessionId).toBe(authSessionId);
  });

  it('is signed out, with no cookie cleared, for a conflicted login cookie and for a legacy cookie the backend denies', async () => {
    const strays = [randomUUID(), randomUUID()].map((token) =>
      signBrowserSessionCookie('login', token.replaceAll('-', ''), COOKIE_SECRET),
    );
    const conflicted = await bothAnswers(`${LOGIN}=${strays[0]}; ${LOGIN}=${strays[1]}`);
    expect(conflicted.session).toEqual({});
    expect(conflicted).toMatchObject({ status: 200, token: { token: null, authenticated: false } });

    // A login's rollback twin on its own is denied by the bridge (decision 2).
    const climber = await createClimber(environment.database);
    const jar = new CookieJar();
    await login(jar, climber.email);
    const twinOnly = await wsAuth(`${LEGACY}=${jar.get(LEGACY, DOMAIN)}`);
    expect(twinOnly.status).toBe(200);
    expect(await twinOnly.json()).toEqual({ token: null, authenticated: false });
    expect(setCookies(twinOnly)).toEqual([]);
  });

  it('is signed out for a plain-named legacy cookie in a secure context, as the session read is', async () => {
    const { credential } = await legacyLogin();
    const { session, token, status } = await bothAnswers(`next-auth.session-token=${credential}`);
    expect(session).toEqual({});
    expect(status).toBe(200);
    expect(token).toEqual({ token: null, authenticated: false });
  });

  it('bridges a legacy cookie beside an unverifiable first-party cookie without any cookie write, as the session read does', async () => {
    const { climber, authSessionId, credential } = await legacyLogin();
    const cookie = `${LOGIN}=not-a-signed-value; ${LEGACY}=${credential}`;
    const sessionRead = await readSession(cookie);
    expect(setCookies(sessionRead)).toEqual([]);
    const session = (await sessionRead.json()) as SessionJson;
    expect(session).toMatchObject({ user: { id: climber.id }, authSessionId });
    const tokenResponse = await wsAuth(cookie);
    expect(setCookies(tokenResponse)).toEqual([]);
    expectSameIds(session, (await tokenResponse.json()) as WsAuthBody);
    // Backend off: both are an outage, never the legacy answer and never signed out.
    vi.stubEnv('CURRENT_STORE_WEB_SESSION_MODE', 'legacy');
    expect((await readSession(cookie)).status).toBe(503);
    expect((await wsAuth(cookie)).status).toBe(503);
  });

  it('names the newer legacy login beside a stale login cookie, exactly as the session read does', async () => {
    const climberA = await createClimber(environment.database);
    const jar = new CookieJar();
    await login(jar, climberA.email);
    const { authSessionId: staleId } = (await (await readSession(jar.header())).json()) as SessionJson;
    await environment.database
      .update(authSession)
      .set({ originalAuthenticatedAt: new Date(Date.now() - 3_600_000) })
      .where(eq(authSession.id, staleId ?? ''));
    const { climber: climberB, authSessionId, credential } = await legacyLogin();
    const { session, token } = await bothAnswers(`${LOGIN}=${jar.get(LOGIN, DOMAIN)}; ${LEGACY}=${credential}`);
    expect(session).toMatchObject({ user: { id: climberB.id }, authSessionId });
    expectSameIds(session, token);
  });

  it('answers 503 and writes nothing while the backend is off, refuses the channel, or lacks the token secret', async () => {
    const climber = await createClimber(environment.database);
    const jar = new CookieJar();
    await login(jar, climber.email);
    for (const [name, value] of [
      ['CURRENT_STORE_WEB_SESSION_MODE', 'legacy'],
      ['CURRENT_STORE_AUTH_BACKEND_ORIGIN', backend.refusingOrigin],
      ['AUTH_BROWSER_ACCESS_TOKEN_SECRET', ''],
    ] as const) {
      betterAuth();
      vi.stubEnv(name, value);
      const response = await wsAuth(jar.header());
      expect(response.status, name).toBe(503);
      expect(setCookies(response), name).toEqual([]);
    }
  });

  it('counts its bridges in its own bucket: over its limit it answers 503, and the session read still bridges', async () => {
    const { credential } = await legacyLogin();
    const clientAddress = randomClientAddress();
    for (let count = 0; count < BRIDGES_PER_CLIENT; count += 1)
      expect((await wsAuth(`${LEGACY}=${credential}`, clientAddress)).status).toBe(200);
    const limited = await wsAuth(`${LEGACY}=${credential}`, clientAddress);
    expect(limited.status).toBe(503);
    expect(setCookies(limited)).toEqual([]);
    const read = await readSession(`${LEGACY}=${credential}`, 'GET', '', { bridges: true, clientAddress });
    expect(setCookies(read).some((header) => header.startsWith(`${BRIDGED}=`))).toBe(true);
  });
});
