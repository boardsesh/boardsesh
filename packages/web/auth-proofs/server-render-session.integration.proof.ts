// @vitest-environment node
/**
 * #7596 B4a: server renders and private routes read the browser session
 * through `getAdmittedServerSession` and `getServerAuthToken`, unchanged
 * signatures. Under `AUTH_BROWSER_SESSION_MODE=better-auth` both come from the
 * one resolver the session read and ws-auth use, through Next's real request
 * store (patched to the served request), the real backend web-session
 * handlers over HTTP, the real backend GraphQL endpoint (Yoga, in process) and
 * real PostgreSQL. Nothing scripts a backend reply. One render is one React
 * `cache` scope; the proof clears it between renders.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { encode, type JWT } from './legacy-credential-fixture';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { authSession, userCredentials } from '@boardsesh/db/schema';
import { createEnvironment } from '../../backend/src/auth/authority/__tests__/environment';
import { readFirstPartySession } from '../../backend/src/auth/authority/session-reader';
import { CookieJar, ORIGIN, patchNextRequestIo, servedRequests } from './route-harness';
import {
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
  process.env.NEXTAUTH_SECRET = 'server-render-session-proof-nextauth-secret-7596';
  process.env.NEXTAUTH_URL = 'https://www.boardsesh.com';
  return { database: undefined as unknown };
});
vi.mock('server-only', () => ({}));
// Next's request store, answered from the served request, for the modules this proof imports.
// `headers()` is the request's own headers object, so its `Cookie` header is the raw one, with
// duplicate copies; one object per request, as Next's store is. `cookies()` has only `getAll`:
// a render that tried to set or delete a cookie would throw here. Nothing mocks React's `cache`:
// the helpers hold their one resolution per request themselves.
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
import { getAdmittedServerSession } from '../app/lib/auth/admitted-session.server';
import { CredentialAuthorityUnavailable } from '../app/lib/auth/credential-admission.server';
import { getServerAuthToken } from '../app/lib/auth/server-auth';
import { BRIDGES_PER_CLIENT } from '../app/lib/auth/browser-session-bridge.server';
import * as controllersRoute from '../app/api/internal/controllers/route';
import { readPartnerPageSession } from '../app/lib/partner-oauth/sign-in-session.server';
import { resolveFirstPartySession } from '../../backend/src/auth/partner/first-party-session';

const secret = 'server-render-session-proof-nextauth-secret-7596';
const ACCESS_SECRET = 'server-render-session-proof-access-secret-7596-b4a';
const COMMAND_PREFIX = '/api/internal/auth/current-store/web-session/v1/';
const { login, readSession, signOut } = browserSteps(authRoute);
let environment: Awaited<ReturnType<typeof createEnvironment>>;
let backend: WebSessionBackend;
let graphqlFetch: (request: Request) => Promise<Response>;
const realFetch = globalThis.fetch;
let commandsSent: string[] = [];

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
  commandsSent = [];
  // Counts the private web-session commands www sends; every request still goes out.
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.startsWith(COMMAND_PREFIX)) commandsSent.push(url.pathname.slice(COMMAND_PREFIX.length));
    return realFetch(input, init);
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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

/** One request carrying `cookie` (a page render unless `headers` say otherwise): its own request store. */
async function render<Result>(
  cookie: string,
  read: () => Promise<Result>,
  clientAddress = randomClientAddress(),
  extraHeaders: Record<string, string> = {},
): Promise<Result> {
  const request = new NextRequest(new URL('/settings', ORIGIN), {
    headers: { cookie, 'x-forwarded-for': clientAddress, ...extraHeaders },
  });
  return servedRequests.run(request, read);
}

/** What a private page reads: its session and the bearer it fetches data with, in one render. */
const renderPage = (cookie: string, clientAddress?: string) =>
  render(
    cookie,
    async () => ({ session: await getAdmittedServerSession(), token: await getServerAuthToken() }),
    clientAddress,
  );

/** A real `/api/internal/*` route handler, called the way Next calls it, inside its own request store. */
async function callInternalRoute(handler: (request: NextRequest) => Promise<Response>, path: string, cookie: string) {
  const request = new NextRequest(new URL(path, ORIGIN), {
    headers: { cookie, 'x-forwarded-for': randomClientAddress() },
  });
  return servedRequests.run(request, () => handler(request));
}

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

type SessionJson = { user?: { id: string }; authSessionId?: string };

describe('server renders with the mode unset, empty or legacy (as on main)', () => {
  it.each([undefined, '', 'legacy'])(
    'read the admitted legacy cookie and forward it as the bearer (mode %j)',
    async (mode) => {
      if (mode !== undefined) vi.stubEnv('AUTH_BROWSER_SESSION_MODE', mode);
      const climber = await createClimber(environment.database);
      const jar = new CookieJar();
      await login(jar, climber.email);
      const { session, token } = await renderPage(jar.header());
      expect(session?.user.id).toBe(climber.id);
      expect(token).toBe(jar.get(LEGACY, DOMAIN));
      expect(commandsSent).toEqual([]);
    },
  );
});

describe('server renders under better-auth', () => {
  beforeEach(betterAuth);

  it('render A with A’s session JSON and a token the backend accepts, one read and one token per request', async () => {
    const climber = await createClimber(environment.database);
    const jar = new CookieJar();
    await login(jar, climber.email);
    const sessionJson = (await (await readSession(jar.header())).json()) as SessionJson;
    commandsSent = [];
    const page = await render(jar.header(), async () => {
      // A page asks many times; the render resolves once.
      const reads = await Promise.all([getAdmittedServerSession(), getAdmittedServerSession(), getServerAuthToken()]);
      return { session: reads[0], again: reads[1], token: reads[2], tokenAgain: await getServerAuthToken() };
    });
    expect(page.session?.user.id).toBe(climber.id);
    expect(page.session?.authSessionId).toBe(sessionJson.authSessionId);
    expect(page.again).toEqual(page.session);
    expect(page.tokenAgain).toBe(page.token);
    expect(commandsSent.sort()).toEqual(['access', 'session']);
    // Neither the login cookie's token nor its rollback twin: the 15-minute token.
    expect(page.token).not.toBe(jar.get(LEGACY, DOMAIN));
    expect(page.token?.split('.')).toHaveLength(3);
    expect(await graphqlViewer(page.token ?? '')).toEqual({
      status: 200,
      body: { data: { authenticatedUserId: climber.id } },
    });
  });

  it('render a revoked session signed out, never from the legacy twin beside it', async () => {
    const climber = await createClimber(environment.database);
    const jar = new CookieJar();
    await login(jar, climber.email);
    const sessionJson = (await (await readSession(jar.header())).json()) as SessionJson;
    const cookiesBeforeSignOut = jar.header();
    await signOut(jar, { userId: climber.id, authSessionId: sessionJson.authSessionId ?? '' });
    expect(await renderPage(cookiesBeforeSignOut)).toEqual({ session: null, token: undefined });
  });

  it('render a browser signed in before the switch signed in on its first document, writing no cookie', async () => {
    const { climber, authSessionId, credential } = await legacyLogin();
    // Next's cookie store in this proof can only be read: a write would throw.
    const { session, token } = await renderPage(`${LEGACY}=${credential}`);
    expect(session?.user.id).toBe(climber.id);
    expect(session?.authSessionId).toBe(authSessionId);
    expect(token).not.toBe(credential);
    expect((await graphqlViewer(token ?? '')).body.data?.authenticatedUserId).toBe(climber.id);
    // The session read that follows bridges to the same login.
    const sessionJson = (await (
      await readSession(`${LEGACY}=${credential}`, 'GET', '', { bridges: true })
    ).json()) as SessionJson;
    expect(sessionJson.authSessionId).toBe(authSessionId);
  });

  it('render as the session read does for the two cookie states the resolver decides (#7792 review, M4)', async () => {
    const { climber, authSessionId, credential } = await legacyLogin();
    // A plain-named legacy cookie in a secure context: signed out, as NextAuth reads only the secure name.
    expect(await renderPage(`next-auth.session-token=${credential}`)).toEqual({ session: null, token: undefined });
    // An unverifiable first-party cookie beside it: bridged without a cookie, the legacy cookie's login.
    const beside = await renderPage(`${LOGIN}=not-a-signed-value; ${LEGACY}=${credential}`);
    expect(beside.session?.user.id).toBe(climber.id);
    expect(beside.session?.authSessionId).toBe(authSessionId);
    expect((await graphqlViewer(beside.token ?? '')).body.data?.authenticatedUserId).toBe(climber.id);
  });

  it('answer as the session read does over the render budget: from the legacy cookie', async () => {
    const { climber, credential } = await legacyLogin();
    const clientAddress = randomClientAddress();
    for (let count = 0; count < BRIDGES_PER_CLIENT; count += 1)
      await renderPage(`${LEGACY}=${credential}`, clientAddress);
    const limited = await renderPage(`${LEGACY}=${credential}`, clientAddress);
    expect(limited.session?.user.id).toBe(climber.id);
    expect(limited.token).toBe(credential);
    // The backend still accepts the legacy cookie as a bearer under better-auth.
    expect((await graphqlViewer(limited.token ?? '')).body.data?.authenticatedUserId).toBe(climber.id);
  });

  it('give a browser that can never get a cookie written its own, higher budget (#7798 review, L5)', async () => {
    const { climber, credential } = await legacyLogin();
    const clientAddress = randomClientAddress();
    const cookie = `${LOGIN}=not-a-signed-value; ${LEGACY}=${credential}`;
    for (let count = 0; count < BRIDGES_PER_CLIENT + 5; count += 1)
      expect((await renderPage(cookie, clientAddress)).session?.user.id).toBe(climber.id);
  });

  it('see duplicate copies of the login cookie as signed out, in a render and in a route (#7798 review, H1)', async () => {
    const [first, second] = [await createClimber(environment.database), await createClimber(environment.database)];
    const [jarA, jarB] = [new CookieJar(), new CookieJar()];
    await login(jarA, first.email);
    await login(jarB, second.email);
    // A Domain copy and a host-only copy of one name with differing values: which one a reader keeps is not reliable.
    const duplicated = `${LOGIN}=${jarA.get(LOGIN, DOMAIN)}; ${LOGIN}=${jarB.get(LOGIN, DOMAIN)}`;
    expect(await renderPage(duplicated)).toEqual({ session: null, token: undefined });
    const routeAnswer = await callInternalRoute(controllersRoute.GET, '/api/internal/controllers', duplicated);
    expect(routeAnswer.status).toBe(401);
  });

  it('resolve once per route request, not per helper call, and bridge only on reads (#7798 review, M1, L4)', async () => {
    const climber = await createClimber(environment.database);
    const jar = new CookieJar();
    await login(jar, climber.email);
    commandsSent = [];
    // A server action (Next marks it `Next-Action`): many helper calls, one resolution.
    const action = await render(
      jar.header(),
      async () => {
        const [token, session] = await Promise.all([getServerAuthToken(), getAdmittedServerSession()]);
        return { token, session, again: await getServerAuthToken() };
      },
      randomClientAddress(),
      { 'next-action': 'proof-action-id' },
    );
    expect(action.again).toBe(action.token);
    expect(action.session?.user.id).toBe(climber.id);
    expect(commandsSent.sort()).toEqual(['access', 'session']);
    // A write with only a legacy cookie: answered from the admitted legacy cookie, never bridged.
    const { climber: legacyClimber, credential } = await legacyLogin();
    commandsSent = [];
    const written = await render(
      `${LEGACY}=${credential}`,
      async () => ({ token: await getServerAuthToken(), session: await getAdmittedServerSession() }),
      randomClientAddress(),
      { 'next-action': 'proof-action-id' },
    );
    expect(written.token).toBe(credential);
    expect(written.session?.user.id).toBe(legacyClimber.id);
    expect(commandsSent).toEqual([]);
  });

  it('fail with the authority outage, never as anonymous, while the backend is off', async () => {
    const climber = await createClimber(environment.database);
    const jar = new CookieJar();
    await login(jar, climber.email);
    vi.stubEnv('CURRENT_STORE_WEB_SESSION_MODE', 'legacy');
    await expect(render(jar.header(), () => getAdmittedServerSession())).rejects.toBeInstanceOf(
      CredentialAuthorityUnavailable,
    );
    await expect(render(jar.header(), () => getServerAuthToken())).rejects.toBeInstanceOf(
      CredentialAuthorityUnavailable,
    );
  });

  it('render a page with no session cookie signed out without asking the backend', async () => {
    expect(await renderPage('')).toEqual({ session: null, token: undefined });
    expect(commandsSent).toEqual([]);
  });
});

describe('the partner sign-in and consent pages under better-auth (#7798 review, M2)', () => {
  beforeEach(betterAuth);

  /** The api consent endpoint's own read of the same Cookie header. */
  const consentRead = (cookie: string) =>
    resolveFirstPartySession(cookie, secret, () => environment.database, new Date(), COOKIE_SECRET);

  /** A climber whose password was set an hour ago, so a sign-in now is clearly after it. */
  async function climberWithOldPassword() {
    const climber = await createClimber(environment.database);
    await environment.database
      .update(userCredentials)
      .set({ updatedAt: new Date(Date.now() - 3_600_000) })
      .where(eq(userCredentials.userId, climber.id));
    return climber;
  }

  it('agree with the consent endpoint on account and recency for a login bridged from before the switch', async () => {
    const climber = await climberWithOldPassword();
    const credential = await encode({
      token: {
        sub: climber.id,
        email: climber.email,
        authSessionId: randomUUID(),
        gen: 0,
        auth_time: Math.floor(Date.now() / 1000) - 60,
        link_guarded: true,
      },
      secret,
      maxAge: 3600,
    });
    const cookie = `${LEGACY}=${credential}`;
    const page = await render(cookie, () => readPartnerPageSession());
    const consent = await consentRead(cookie);
    expect(consent.status).toBe('signed-in');
    expect(page).toMatchObject({ account: climber.email, recentGuardedSignIn: true });
    if (consent.status === 'signed-in') expect(consent.user.email).toBe(page?.account);
  });

  it('show no account when a stale login cookie sits beside a newer legacy login that cannot be bridged now', async () => {
    const climberA = await climberWithOldPassword();
    const jar = new CookieJar();
    await login(jar, climberA.email);
    const { authSessionId: staleId } = (await (await readSession(jar.header())).json()) as SessionJson;
    await environment.database
      .update(authSession)
      .set({ originalAuthenticatedAt: new Date(Date.now() - 3_600_000) })
      .where(eq(authSession.id, staleId ?? ''));
    const newer = await legacyLogin({ link_guarded: true });
    const clientAddress = randomClientAddress();
    // Use up this client's render bridges, so the newer login cannot be bridged now.
    const filler = await legacyLogin();
    for (let count = 0; count < BRIDGES_PER_CLIENT; count += 1)
      await renderPage(`${LEGACY}=${filler.credential}`, clientAddress);
    const cookie = `${LOGIN}=${jar.get(LOGIN, DOMAIN)}; ${LEGACY}=${newer.credential}`;
    expect(await render(cookie, () => readPartnerPageSession(), clientAddress)).toBeNull();
    // The consent endpoint follows the newer login, never A.
    const consent = await consentRead(cookie);
    if (consent.status === 'signed-in') expect(consent.user.id).toBe(newer.climber.id);
  });
});
