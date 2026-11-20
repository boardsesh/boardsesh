// @vitest-environment node
/**
 * #7596 B5b, Apple: under `AUTH_BROWSER_SESSION_MODE=better-auth`, an Apple
 * sign-in through the real `/api/auth/[...nextauth]` route publishes the
 * first-party session the backend's web OAuth `resolve` issues. Real route,
 * real NextAuth (the Apple provider pointed at a loopback stand-in that signs
 * real RS256 ID tokens and answers with `response_mode=form_post`), the real
 * backend web OAuth and web-session handlers over HTTP, real PostgreSQL.
 *
 * Apple's answer is a cross-site POST, so it carries only the SameSite=None
 * flow cookies, never the Lax session cookie. www holds it in a continuation
 * cookie and answers 303 to a same-site GET that resumes it; the session the
 * sign-in ends (`presented`) is read from that GET. Nothing scripts a backend
 * reply.
 */
import { verifyDeviceToken } from '@boardsesh/auth-protocol/device-token';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { decode } from './legacy-credential-fixture';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { authSession } from '@boardsesh/db/schema';
import { createEnvironment } from '../../backend/src/auth/authority/__tests__/environment';
import { readFirstPartySession, requireFreshAuthentication } from '../../backend/src/auth/authority/session-reader';
import { CookieJar, callRoute, patchNextRequestIo, setCookies } from './route-harness';
import {
  BRIDGED,
  DOMAIN,
  LEGACY,
  LOGIN,
  MARKER,
  browserSteps,
  canonicalStatus,
  createClimber,
  expectViewerMarkerFor,
  loginToken,
  randomClientAddress,
  sessionCookieNamesIn,
  startWebSessionBackend,
  stubBetterAuthEnvironment,
  type WebSessionBackend,
} from './web-session-harness';
import { startAppleOidcFixture, type AppleIdentity } from './apple-oidc-fixture';

const holder = vi.hoisted(() => {
  // auth-options reads these when it loads: production www, and a configured Apple provider.
  process.env.NEXTAUTH_SECRET = 'web-apple-sign-in-proof-nextauth-secret-7596';
  process.env.NEXTAUTH_URL = 'https://www.boardsesh.com';
  process.env.APPLE_ID = 'com.boardsesh.web-apple-sign-in-proof';
  process.env.APPLE_SECRET = 'web-apple-sign-in-proof-client-secret-jwt';
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
import { authOptions } from '../app/lib/auth/auth-options';

const secret = 'web-apple-sign-in-proof-nextauth-secret-7596';
const CALLBACK_PATH = '/api/auth/callback/apple';
const RESOLVE_PATH = '/api/internal/auth/current-store/web-oauth/v1/resolve';
const APP_RETURN = 'https://app.boardsesh.com/auth/login';
/** www's sealed hold of Apple's POST (`web-oauth-continuation.server.ts`). */
const CONTINUATION_PREFIX = '__Secure-boardsesh.web-oauth.apple.';
const { csrf, login, readSession } = browserSteps(authRoute);
let environment: Awaited<ReturnType<typeof createEnvironment>>;
let backend: WebSessionBackend;
let apple: Awaited<ReturnType<typeof startAppleOidcFixture>>;
const realFetch = globalThis.fetch;
/** The `webSession` field of every web OAuth `resolve` www sent (undefined when it sent none). */
let resolveSessionRequests: unknown[] = [];

beforeAll(async () => {
  environment = await createEnvironment();
  holder.database = environment.database;
  backend = await startWebSessionBackend(environment.database);
  apple = await startAppleOidcFixture({
    clientId: process.env.APPLE_ID ?? '',
    clientSecret: process.env.APPLE_SECRET ?? '',
  });
  patchNextRequestIo();
  // Point NextAuth's Apple provider at the stand-in (its user options win over the defaults).
  const provider = authOptions.providers.find((configured) => configured.id === 'apple');
  if (!provider || provider.type !== 'oauth' || !provider.options) throw new Error('No Apple provider configured');
  Object.assign(provider.options, { wellKnown: apple.discoveryUrl });
});
beforeEach(() => {
  resolveSessionRequests = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith(RESOLVE_PATH) && typeof init?.body === 'string')
      resolveSessionRequests.push((JSON.parse(init.body) as { webSession?: unknown }).webSession);
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
  await apple?.close();
  await backend?.close();
  await environment?.close();
});

const newAppleIdentity = (firstSignIn = false): AppleIdentity => {
  const id = randomUUID();
  return { subject: `apple-${id}`, email: `apple-${id}@privaterelay.example.test`, firstSignIn };
};

/**
 * A browser's whole Apple sign-in: the start, Apple's form posted cross-site
 * with only the cookies such a POST carries, then the same-site GET the 303
 * names, with every cookie of that path.
 */
async function appleSignIn(jar: CookieJar, identity: AppleIdentity, callbackUrl = 'https://www.boardsesh.com/') {
  const clientAddress = randomClientAddress();
  const csrfToken = await csrf(jar);
  const start = await callRoute(authRoute, '/api/auth/signin/apple', {
    cookie: jar.header(),
    form: { csrfToken, callbackUrl, json: 'true' },
    headers: { 'x-forwarded-for': clientAddress },
  });
  jar.apply(start);
  const { url } = (await start.clone().json()) as { url: string };
  const formPost = apple.authorize(url, identity);
  expect(new URL(formPost.action).pathname).toBe(CALLBACK_PATH);
  const crossSiteCookie = jar.crossSiteHeader(CALLBACK_PATH);
  const posted = await callRoute(authRoute, CALLBACK_PATH, {
    cookie: crossSiteCookie,
    form: formPost.fields,
    headers: { 'x-forwarded-for': clientAddress },
  });
  jar.apply(posted);
  const resumeAt = new URL(posted.headers.get('location') ?? '', 'https://www.boardsesh.com');
  const resumed = await callRoute(authRoute, `${resumeAt.pathname}${resumeAt.search}`, {
    cookie: jar.header(resumeAt.pathname),
    headers: { 'x-forwarded-for': clientAddress },
  });
  jar.apply(resumed);
  return { start, authorizationUrl: new URL(url), crossSiteCookie, posted, resumeAt, resumed };
}

/** The claims of the Domain-scoped legacy cookie a response wrote. */
async function legacyTwinOf(response: Response) {
  const written = setCookies(response).find(
    (header) => header.startsWith(`${LEGACY}=`) && !header.startsWith(`${LEGACY}=;`) && /Domain=/i.test(header),
  );
  if (!written) return undefined;
  return decode({ token: written.split(';', 1)[0].slice(LEGACY.length + 1), secret });
}

/** The response sets the login cookie, the legacy twin with the same session id, and the viewer marker last. */
async function expectPublishedLogin(response: Response, jar: CookieJar) {
  expect(
    setCookies(response).some((header) => header.startsWith(`${LOGIN}=`) && !header.startsWith(`${LOGIN}=;`)),
  ).toBe(true);
  const twin = await legacyTwinOf(response);
  const read = await readFirstPartySession(environment.database, { kind: 'canonical-token', token: loginToken(jar) });
  if (read.status !== 'admitted') throw new Error('The new login cookie does not read as live');
  expect(twin?.authSessionId).toBe(read.session.authSessionId);
  expectViewerMarkerFor(response, read.session.authSessionId);
  return { twin, session: read.session };
}

describe('Apple sign-in with the mode unset, empty or legacy (as on main)', () => {
  it.each([undefined, '', 'legacy'])(
    'holds the form_post, resumes it, writes only the legacy cookie and asks for no session (mode %j)',
    async (mode) => {
      stubBetterAuthEnvironment(backend.origin);
      vi.stubEnv('AUTH_BROWSER_SESSION_MODE', mode ?? '');
      if (mode === undefined) delete process.env.AUTH_BROWSER_SESSION_MODE;
      const jar = new CookieJar();
      const { posted, resumed } = await appleSignIn(jar, newAppleIdentity(true));
      expect(posted.status).toBe(303);
      expect(sessionCookieNamesIn(resumed)).toContain(LEGACY);
      expect(sessionCookieNamesIn(resumed)).not.toContain(LOGIN);
      expect(sessionCookieNamesIn(resumed)).not.toContain(MARKER);
      expect(resolveSessionRequests).toEqual([undefined]);
    },
  );
});

describe('Apple sign-in under better-auth', () => {
  beforeEach(() => stubBetterAuthEnvironment(backend.origin));

  it('asks Apple for form_post, holds its cross-site POST with no session cookie, and publishes a carried login on the resumed GET', async () => {
    const deviceSecret = 'combined-provider-device-token-secret-32bytes';
    vi.stubEnv('AUTH_DEVICE_TOKEN_SECRET', deviceSecret);
    const identity = newAppleIdentity(true);
    const jar = new CookieJar();
    const { authorizationUrl, crossSiteCookie, posted, resumeAt, resumed } = await appleSignIn(jar, identity);
    expect(authorizationUrl.searchParams.get('response_mode')).toBe('form_post');
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');

    // The cross-site POST carried the flow's SameSite=None cookies and nothing Lax.
    expect(crossSiteCookie).not.toBe('');
    for (const name of [LOGIN, BRIDGED, LEGACY, MARKER]) expect(crossSiteCookie).not.toContain(`${name}=`);
    // Held: 303 to the resume GET, a continuation cookie, and no session cookie at all.
    expect(posted.status).toBe(303);
    expect(resumeAt.pathname).toBe(CALLBACK_PATH);
    expect(resumeAt.searchParams.has('boardseshOAuthContinue')).toBe(true);
    expect(sessionCookieNamesIn(posted)).toEqual([]);
    const continuation = setCookies(posted).find((header) => header.startsWith(CONTINUATION_PREFIX));
    expect(continuation).toMatch(new RegExp(`Path=${CALLBACK_PATH}; Max-Age=\\d+; HttpOnly; SameSite=Lax; Secure$`));

    // The resumed GET publishes: login cookie, twin with its id, marker last.
    const { twin, session } = await expectPublishedLogin(resumed, jar);
    const recognition = setCookies(resumed).find((cookie) => cookie.startsWith('__Host-boardsesh.device='));
    expect(
      await verifyDeviceToken(recognition?.split(';')[0].split('=')[1], {
        userId: session.userId,
        secret: deviceSecret,
      }),
    ).not.toBeNull();
    expect(resolveSessionRequests).toHaveLength(1);
    // Apple is never fresh: the twin has no sign-in time and no link guard, the row is carried.
    expect(twin?.auth_time).toBeUndefined();
    expect(twin?.link_guarded).toBeUndefined();
    const [row] = await environment.database
      .select()
      .from(authSession)
      .where(eq(authSession.id, session.authSessionId));
    expect(row.legacyLineageId).toBe(`carried:${session.authSessionId}`);
    expect(requireFreshAuthentication(session)).toBe(false);
    const clears = setCookies(resumed).filter((header) => header.startsWith(`${BRIDGED}=;`));
    expect(clears.some((header) => /Domain=/i.test(header))).toBe(true);
    // The continuation cookie is spent.
    expect(jar.names().some((name) => name.startsWith(CONTINUATION_PREFIX))).toBe(false);
    const sessionJson = (await (await readSession(jar.header())).json()) as { user?: { email?: string } };
    expect(sessionJson.user?.email).toBe(identity.email);
  });

  it('ends the session the browser held as A, read from the resumed GET, when it signs in as B through Apple', async () => {
    const climberA = await createClimber(environment.database);
    const jar = new CookieJar();
    await login(jar, climberA.email);
    const tokenA = loginToken(jar);
    const legacyA = jar.get(LEGACY, DOMAIN) ?? '';
    // B's Apple identity belongs to account B already (D1: an unknown one would be link_required).
    const identityB = newAppleIdentity(true);
    await appleSignIn(new CookieJar(), identityB);
    resolveSessionRequests = [];

    const { crossSiteCookie, posted, resumed } = await appleSignIn(jar, { ...identityB, firstSignIn: false });
    // A's login cookie never rode the cross-site POST, and the hold changed no session cookie.
    expect(crossSiteCookie).not.toContain(`${LOGIN}=`);
    expect(sessionCookieNamesIn(posted)).toEqual([]);
    // `presented` is A's canonical token, from the GET that resumed the hold.
    expect(resolveSessionRequests).toEqual([
      expect.objectContaining({ presented: { kind: 'canonical-token', token: tokenA } }),
    ]);
    const { session } = await expectPublishedLogin(resumed, jar);
    expect(session.userId).not.toBe(climberA.id);
    expect(await canonicalStatus(environment.database, tokenA)).not.toBe('admitted');
    expect(
      (await readFirstPartySession(environment.database, { kind: 'legacy-jwe', credential: legacyA, secret })).status,
    ).not.toBe('admitted');
  });

  it('returns an Expo web sign-in to the app with the session published on the same response', async () => {
    const identity = newAppleIdentity(true);
    const jar = new CookieJar();
    const attempt = `attempt-${randomUUID().slice(0, 8)}`;
    const returnUrl = `${APP_RETURN}?boardseshOAuthProvider=apple&boardseshOAuthAttempt=${attempt}`;
    const { posted, resumed } = await appleSignIn(jar, identity, returnUrl);
    expect(posted.status).toBe(303);
    const location = new URL(resumed.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(APP_RETURN);
    expect(location.searchParams.get('boardseshOAuthAttempt')).toBe(attempt);
    expect(location.searchParams.has('boardseshOAuthError')).toBe(false);
    const { session } = await expectPublishedLogin(resumed, jar);
    expect(session.userId).toBeTruthy();
    // The app reads who it is from www's session read, which names the new login and writes nothing.
    const read = await readSession(jar.header());
    expect(setCookies(read)).toEqual([]);
    expect(((await read.json()) as { authSessionId?: string }).authSessionId).toBe(session.authSessionId);
  });

  it('a held POST whose state matches no flow of this browser publishes nothing', async () => {
    const identity = newAppleIdentity(true);
    const jar = new CookieJar();
    const csrfToken = await csrf(jar);
    const start = await callRoute(authRoute, '/api/auth/signin/apple', {
      cookie: jar.header(),
      form: { csrfToken, callbackUrl: 'https://www.boardsesh.com/', json: 'true' },
    });
    const { url } = (await start.clone().json()) as { url: string };
    const formPost = apple.authorize(url, identity);
    // Another browser (no flow cookies) receives the form.
    const stranger = new CookieJar();
    const posted = await callRoute(authRoute, CALLBACK_PATH, {
      cookie: stranger.crossSiteHeader(CALLBACK_PATH),
      form: formPost.fields,
    });
    expect(sessionCookieNamesIn(posted)).toEqual([]);
    expect(posted.headers.get('location') ?? '').not.toContain('boardseshOAuthContinue');
    expect(resolveSessionRequests).toEqual([]);
  });
});
