// @vitest-environment node
/**
 * #7596 B5b: under `AUTH_BROWSER_SESSION_MODE=better-auth`, a Google sign-in
 * through the real `/api/auth/[...nextauth]` route publishes the first-party
 * session the backend's web OAuth `resolve` issues, beside the legacy twin
 * with the same session id. Real route, real NextAuth (Google provider pointed
 * at a loopback stand-in that signs real ID tokens), the real backend web
 * OAuth and web-session handlers over HTTP, real PostgreSQL. The backend's own
 * Google freshness verifier checks the same token (its certificate fetch is
 * answered with the stand-in's key). Nothing scripts a backend reply.
 */
import { verifyDeviceToken } from '@boardsesh/auth-protocol/device-token';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { decode, encode } from './legacy-credential-fixture';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { authSession, users } from '@boardsesh/db/schema';
import { createEnvironment } from '../../backend/src/auth/authority/__tests__/environment';
import { readFirstPartySession, requireFreshAuthentication } from '../../backend/src/auth/authority/session-reader';
import { NextRequest } from 'next/server';
import { CookieJar, ORIGIN, callRoute, patchNextRequestIo, servedRequests, setCookies } from './route-harness';
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
  reserveClimberEmail,
  sessionCookieNamesIn,
  startWebSessionBackend,
  stubBetterAuthEnvironment,
  type WebSessionBackend,
} from './web-session-harness';
import { GOOGLE_CERTS_URL, startGoogleOidcFixture, type GoogleIdentity } from './google-oidc-fixture';

const holder = vi.hoisted(() => {
  // auth-options reads these when it loads: production www, and a configured Google provider.
  process.env.NEXTAUTH_SECRET = 'web-provider-session-proof-nextauth-secret-7596';
  process.env.NEXTAUTH_URL = 'https://www.boardsesh.com';
  process.env.GOOGLE_CLIENT_ID = 'web-provider-session-proof.apps.googleusercontent.test';
  process.env.GOOGLE_CLIENT_SECRET = 'web-provider-session-proof-google-secret';
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
import * as reauthenticationRoute from '../app/api/auth/reauthenticate/[action]/route';
import { authOptions } from '../app/lib/auth/auth-options';
import { GOOGLE_FORCED_REAUTHENTICATION } from '../app/lib/auth/google-forced-reauthentication';

const secret = 'web-provider-session-proof-nextauth-secret-7596';
const ACCESS_SECRET = 'web-provider-session-proof-access-secret-7596-b5b';
const RESOLVE_PATH = '/api/internal/auth/current-store/web-oauth/v1/resolve';
const { csrf, login, readSession } = browserSteps(authRoute);
let environment: Awaited<ReturnType<typeof createEnvironment>>;
let backend: WebSessionBackend;
let google: Awaited<ReturnType<typeof startGoogleOidcFixture>>;
const realFetch = globalThis.fetch;
/** The `webSession` field of every web OAuth `resolve` www sent (undefined when it sent none). */
let resolveSessionRequests: unknown[] = [];

beforeAll(async () => {
  environment = await createEnvironment();
  holder.database = environment.database;
  backend = await startWebSessionBackend(environment.database);
  google = await startGoogleOidcFixture(process.env.GOOGLE_CLIENT_ID ?? '');
  patchNextRequestIo();
  // Point NextAuth's Google provider at the stand-in (its user options win over the defaults).
  const provider = authOptions.providers.find((configured) => configured.id === 'google');
  if (!provider || provider.type !== 'oauth' || !provider.options) throw new Error('No Google provider configured');
  Object.assign(provider.options, { wellKnown: google.discoveryUrl });
});
beforeEach(() => {
  resolveSessionRequests = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    // The backend's Google freshness verifier fetches Google's certificates.
    if (url === GOOGLE_CERTS_URL) return Response.json(google.certificates());
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
  await google?.close();
  await backend?.close();
  await environment?.close();
});

function betterAuth(): void {
  stubBetterAuthEnvironment(backend.origin);
  vi.stubEnv('AUTH_BROWSER_ACCESS_TOKEN_SECRET', ACCESS_SECRET);
  vi.stubEnv('CURRENT_STORE_PROVIDER_GOOGLE_AUTH_TIME_MODE', 'auth-time-staging');
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
const newGoogleIdentity = (authAgoSeconds?: number): GoogleIdentity => {
  const id = randomUUID();
  return {
    subject: `google-${id}`,
    email: `google-${id}@example.test`,
    ...(authAgoSeconds === undefined ? {} : { authTimeSeconds: nowSeconds() - authAgoSeconds }),
  };
};

/** A browser's whole Google sign-in: start, Google's answer, the callback. */
async function googleSignIn(
  jar: CookieJar,
  identity: GoogleIdentity,
  authorizationParams: Readonly<Record<string, string>> = {},
) {
  const clientAddress = randomClientAddress();
  const csrfToken = await csrf(jar);
  const query = new URLSearchParams({ ...authorizationParams }).toString();
  const start = await callRoute(authRoute, `/api/auth/signin/google${query ? `?${query}` : ''}`, {
    cookie: jar.header(),
    form: { csrfToken, callbackUrl: 'https://www.boardsesh.com/', json: 'true' },
    headers: { 'x-forwarded-for': clientAddress },
  });
  jar.apply(start);
  const { url } = (await start.clone().json()) as { url: string };
  const callback = new URL(await google.authorize(url, identity));
  const response = await callRoute(authRoute, `${callback.pathname}${callback.search}`, {
    cookie: jar.header(),
    headers: { 'x-forwarded-for': clientAddress },
  });
  jar.apply(response);
  return { start, response };
}

/** The claims of the Domain-scoped legacy cookie a response wrote. */
async function legacyTwinOf(response: Response) {
  const written = setCookies(response).find(
    (header) => header.startsWith(`${LEGACY}=`) && !header.startsWith(`${LEGACY}=;`) && /Domain=/i.test(header),
  );
  if (!written) return undefined;
  return decode({ token: written.split(';', 1)[0].slice(LEGACY.length + 1), secret });
}

/**
 * The invariant (#7789 review, #7793 review): a response that sets the login
 * cookie also writes the legacy twin with the same session id, so no legacy
 * cookie with another id stays beside it.
 */
async function expectTwinBesideLogin(response: Response, jar: CookieJar) {
  expect(
    setCookies(response).some((header) => header.startsWith(`${LOGIN}=`) && !header.startsWith(`${LOGIN}=;`)),
  ).toBe(true);
  const twin = await legacyTwinOf(response);
  const read = await readFirstPartySession(environment.database, { kind: 'canonical-token', token: loginToken(jar) });
  if (read.status !== 'admitted') throw new Error('The new login cookie does not read as live');
  expect(twin?.authSessionId).toBe(read.session.authSessionId);
  // The viewer marker names the same login, written last (#7596 decision).
  expectViewerMarkerFor(response, read.session.authSessionId);
  return { twin, session: read.session };
}

describe('Google sign-in with the mode unset, empty or legacy (as on main)', () => {
  it.each([undefined, '', 'legacy'])(
    'asks Google for no max_age and no nonce, writes only the legacy cookie and asks for no session (mode %j)',
    async (mode) => {
      stubBetterAuthEnvironment(backend.origin);
      vi.stubEnv('AUTH_BROWSER_SESSION_MODE', mode ?? '');
      if (mode === undefined) delete process.env.AUTH_BROWSER_SESSION_MODE;
      const jar = new CookieJar();
      const { start, response } = await googleSignIn(jar, newGoogleIdentity(30));
      const authorization = google.authorizations().at(-1);
      expect(authorization?.has('max_age')).toBe(false);
      expect(authorization?.has('nonce')).toBe(false);
      expect(setCookies(start).some((header) => header.includes('next-auth.nonce.'))).toBe(false);
      expect(sessionCookieNamesIn(response)).toContain(LEGACY);
      expect(sessionCookieNamesIn(response)).not.toContain(LOGIN);
      expect(sessionCookieNamesIn(response)).not.toContain(MARKER);
      expect(resolveSessionRequests).toEqual([undefined]);
    },
  );
});

describe('Google sign-in under better-auth', () => {
  beforeEach(betterAuth);

  it('publishes a fresh login: login cookie, legacy twin with its id and sign-in time, bridged name cleared', async () => {
    const deviceSecret = 'combined-provider-device-token-secret-32bytes';
    vi.stubEnv('AUTH_DEVICE_TOKEN_SECRET', deviceSecret);
    const identity = newGoogleIdentity(30);
    const jar = new CookieJar();
    const { start, response } = await googleSignIn(jar, identity);
    // Google was asked for auth_time and a nonce of at least 128 bits, kept in a host-only cookie.
    const authorization = google.authorizations().at(-1);
    expect(authorization?.get('max_age')).toBeTruthy();
    expect(authorization?.get('nonce')?.length).toBeGreaterThanOrEqual(22);
    const nonceCookie = setCookies(start).find((header) => header.includes('next-auth.nonce.'));
    // `__Host-`: host-only, Secure, Path=/, so a sibling subdomain cannot plant a copy.
    expect(nonceCookie?.startsWith('__Host-next-auth.nonce.')).toBe(true);
    expect(nonceCookie).toMatch(/HttpOnly/i);
    expect(nonceCookie).toMatch(/Secure/i);
    expect(nonceCookie).not.toMatch(/Domain=/i);
    expect(resolveSessionRequests).toHaveLength(1);
    expect(resolveSessionRequests[0]).toMatchObject({ googleAuthentication: { nonce: authorization?.get('nonce') } });

    const { twin, session } = await expectTwinBesideLogin(response, jar);
    const recognition = setCookies(response).find((cookie) => cookie.startsWith('__Host-boardsesh.device='));
    expect(
      await verifyDeviceToken(recognition?.split(';')[0].split('=')[1], {
        userId: session.userId,
        secret: deviceSecret,
      }),
    ).not.toBeNull();
    expect(twin?.auth_time).toBe(identity.authTimeSeconds);
    expect(twin?.link_guarded).toBe(true);
    const clears = setCookies(response).filter((header) => header.startsWith(`${BRIDGED}=;`));
    expect(clears.some((header) => /Domain=/i.test(header))).toBe(true);
    expect(clears.some((header) => !/Domain=/i.test(header))).toBe(true);
    const [row] = await environment.database
      .select()
      .from(authSession)
      .where(eq(authSession.id, session.authSessionId));
    expect(row.legacyLineageId).toBeNull();
    expect(row.originalAuthenticatedAt?.getTime()).toBe((identity.authTimeSeconds ?? 0) * 1000);
    const sessionJson = (await (await readSession(jar.header())).json()) as { user?: { email?: string } };
    expect(sessionJson.user?.email).toBe(identity.email);
  });

  it('publishes a silent Google sign-in as carried: the twin has no auth_time and no link guard', async () => {
    const jar = new CookieJar();
    const { response } = await googleSignIn(jar, newGoogleIdentity(2 * 60 * 60));
    const { twin, session } = await expectTwinBesideLogin(response, jar);
    expect(twin?.auth_time).toBeUndefined();
    expect(twin?.link_guarded).toBeUndefined();
    const [row] = await environment.database
      .select()
      .from(authSession)
      .where(eq(authSession.id, session.authSessionId));
    expect(row.legacyLineageId?.startsWith('carried:')).toBe(true);
  });

  it('publishes a Google sign-in whose ID token has no auth_time (Google ignored max_age) as carried', async () => {
    const jar = new CookieJar();
    const { response } = await googleSignIn(jar, newGoogleIdentity());
    const { twin, session } = await expectTwinBesideLogin(response, jar);
    expect(twin?.auth_time).toBeUndefined();
    expect(twin?.link_guarded).toBeUndefined();
    const [row] = await environment.database
      .select()
      .from(authSession)
      .where(eq(authSession.id, session.authSessionId));
    expect(row.legacyLineageId).toBe(`carried:${session.authSessionId}`);
  });

  it.each([
    ['a Domain', DOMAIN],
    ['a host-only', ''],
  ])(
    'leaves no leftover legacy cookie (%s copy, another id, written inside the four minutes) beside a fresh login',
    async (_scope, domain) => {
      const leftoverClimber = await createClimber(environment.database);
      const leftover = await encode({
        token: { sub: leftoverClimber.id, authSessionId: randomUUID(), gen: 0, auth_time: nowSeconds() - 60 },
        secret,
        maxAge: 3600,
      });
      const jar = new CookieJar();
      jar.set(LEGACY, leftover, domain);
      const identity = newGoogleIdentity(4 * 60);
      // A known identity: beside a live leftover session an unknown one would be link_required (D1).
      await googleSignIn(new CookieJar(), identity);
      const { response } = await googleSignIn(jar, identity);
      await expectTwinBesideLogin(response, jar);
      expect(jar.get(LEGACY, '')).toBeUndefined();
      // The next session read answers the Google login and writes nothing: no rule (c) switch.
      const read = await readSession(jar.header());
      expect(((await read.json()) as { user?: { email?: string } }).user?.email).toBe(identity.email);
      expect(setCookies(read)).toEqual([]);
    },
  );

  it('ends the session the browser held as A when it signs in as B through Google', async () => {
    const climberA = await createClimber(environment.database);
    const jar = new CookieJar();
    await login(jar, climberA.email);
    const tokenA = loginToken(jar);
    const legacyA = jar.get(LEGACY, DOMAIN) ?? '';
    // B's Google identity belongs to account B already (D1: an unknown one would be link_required).
    const identityB = newGoogleIdentity(30);
    await googleSignIn(new CookieJar(), identityB);
    const { response } = await googleSignIn(jar, identityB);
    await expectTwinBesideLogin(response, jar);
    expect(await canonicalStatus(environment.database, tokenA)).not.toBe('admitted');
    expect(
      (await readFirstPartySession(environment.database, { kind: 'legacy-jwe', credential: legacyA, secret })).status,
    ).not.toBe('admitted');
    expect(resolveSessionRequests.at(-1)).toMatchObject({ presented: { kind: 'canonical-token', token: tokenA } });
  });

  it('changes no session cookie when the backend will not issue a session, or the email belongs to another account', async () => {
    const climberA = await createClimber(environment.database);
    const jar = new CookieJar();
    await login(jar, climberA.email);
    const before = jar.header();
    // The backend's web-session mode is off: `resolve` with a session answers 404, www answers its outage page.
    vi.stubEnv('CURRENT_STORE_WEB_SESSION_MODE', 'legacy');
    const off = await googleSignIn(jar, newGoogleIdentity(30));
    expect(sessionCookieNamesIn(off.response)).toEqual([]);
    expect(off.response.headers.get('location')).toContain('/auth/error');
    // The withheld reply still retires the flow's nonce cookie, with the options it was written with.
    const nonceClear = setCookies(off.response).find((header) => header.startsWith('__Host-next-auth.nonce.'));
    expect(nonceClear).toMatch(/Max-Age=0/i);
    expect(nonceClear).not.toMatch(/Domain=/i);
    expect(jar.names().some((name) => name.startsWith('__Host-next-auth.nonce.'))).toBe(false);
    betterAuth();
    await reserveClimberEmail(environment.database, climberA);
    // Signed out, a new Google subject with the email of an existing account: today's page, no cookie change.
    const signedOut = new CookieJar();
    const conflict = await googleSignIn(signedOut, { ...newGoogleIdentity(30), email: climberA.email });
    expect(sessionCookieNamesIn(conflict.response)).toEqual([]);
    expect(conflict.response.headers.get('location')).toContain('OAuthAccountNotLinked');
    expect(await canonicalStatus(environment.database, loginToken(jar))).toBe('admitted');
    expect(jar.header()).toContain(before.split('; ').find((pair) => pair.startsWith(`${LOGIN}=`)) ?? 'missing');
  });

  it.each([
    ['a new address', false],
    ['the address of the signed-in account', true],
  ])(
    'signed in as A, an unknown Google identity (%s) is link_required: no account, no cookie change, A kept (D1)',
    async (_case, sameAddress) => {
      const climberA = await createClimber(environment.database);
      await reserveClimberEmail(environment.database, climberA);
      const jar = new CookieJar();
      await login(jar, climberA.email);
      const tokenA = loginToken(jar);
      const identity = newGoogleIdentity(30);
      const { response } = await googleSignIn(jar, sameAddress ? { ...identity, email: climberA.email } : identity);
      expect(sessionCookieNamesIn(response)).toEqual([]);
      expect(response.headers.get('location')).toContain('/auth/error?error=OAuthLinkRequired');
      expect(loginToken(jar)).toBe(tokenA);
      expect(await canonicalStatus(environment.database, tokenA)).toBe('admitted');
      expect(await environment.database.select().from(users).where(eq(users.email, identity.email))).toEqual([]);
      expect(resolveSessionRequests.at(-1)).toMatchObject({ presented: { kind: 'canonical-token', token: tokenA } });
    },
  );

  it('keeps the invariant for a password login too: login cookie and twin with one id', async () => {
    const climber = await createClimber(environment.database);
    const jar = new CookieJar();
    const response = await login(jar, climber.email);
    await expectTwinBesideLogin(response, jar);
  });
});

describe('the forced re-sign-in (#7655 item 6) under better-auth', () => {
  beforeEach(betterAuth);

  it('asks Google for a fresh sign-in, and only a fresh auth_time makes the new session pass a five-minute check', async () => {
    const identity = newGoogleIdentity(2 * 60 * 60);
    const jar = new CookieJar();
    await googleSignIn(jar, identity);
    const passes: boolean[] = [];
    for (const authAgoSeconds of [2 * 60 * 60, 15]) {
      const before = loginToken(jar);
      const { response } = await googleSignIn(
        jar,
        { ...identity, authTimeSeconds: nowSeconds() - authAgoSeconds },
        GOOGLE_FORCED_REAUTHENTICATION,
      );
      const authorization = google.authorizations().at(-1);
      expect(authorization?.get('max_age')).toBe('0');
      expect(authorization?.get('prompt')).toBe('select_account consent');
      // A re-sign-in is a login: it writes the login cookie and ends the session it arrived with.
      await expectTwinBesideLogin(response, jar);
      expect(await canonicalStatus(environment.database, before)).not.toBe('admitted');
      const read = await readFirstPartySession(environment.database, {
        kind: 'canonical-token',
        token: loginToken(jar),
      });
      if (read.status !== 'admitted') throw new Error('The re-sign-in session is not live');
      passes.push(requireFreshAuthentication(read.session));
    }
    // Google's own auth_time decides: a silent answer never passes, a real sign-in does.
    expect(passes).toEqual([false, true]);
  });
});

/** The forced re-sign-in's own two routes, as the page calls them. */
async function reauthenticationStep(action: 'start' | 'return', jar: CookieJar, callbackUrl = '/developers/apps') {
  const headers = new Headers({ cookie: jar.header(), 'x-forwarded-for': randomClientAddress() });
  if (action === 'start') {
    const read = await readSession(jar.header());
    const session = (await read.json()) as { user?: { id?: string }; authSessionId?: string };
    headers.set('origin', ORIGIN);
    headers.set('content-type', 'application/json');
    headers.set('X-Boardsesh-Expected-Viewer', `${session.user?.id}:${session.authSessionId}`);
  }
  const request = new NextRequest(new URL(`/api/auth/reauthenticate/${action}`, ORIGIN), {
    method: action === 'start' ? 'POST' : 'GET',
    headers,
    ...(action === 'start' ? { body: JSON.stringify({ callbackUrl }) } : {}),
  });
  const context = { params: Promise.resolve({ action }) };
  const response = await servedRequests.run(request, () =>
    action === 'start' ? reauthenticationRoute.POST(request, context) : reauthenticationRoute.GET(request, context),
  );
  expect(sessionCookieNamesIn(response)).toEqual([]);
  jar.apply(response);
  return response;
}

describe('the forced re-sign-in comes back only as the account that started it (#7804 review M1)', () => {
  it.each(['', 'legacy'])('its routes answer 404 with the mode %j', async (mode) => {
    stubBetterAuthEnvironment(backend.origin);
    vi.stubEnv('AUTH_BROWSER_SESSION_MODE', mode);
    const jar = new CookieJar();
    expect((await reauthenticationStep('return', jar)).status).toBe(404);
  });

  it('forwards to the return path after the same account signs in, and not after another one', async () => {
    betterAuth();
    const identityA = newGoogleIdentity(2 * 60 * 60);
    const identityB = newGoogleIdentity(2 * 60 * 60);
    await googleSignIn(new CookieJar(), identityB);
    const jar = new CookieJar();
    await googleSignIn(jar, identityA);

    expect((await reauthenticationStep('start', jar)).status).toBe(200);
    await googleSignIn(jar, { ...identityA, authTimeSeconds: nowSeconds() - 10 }, GOOGLE_FORCED_REAUTHENTICATION);
    const same = await reauthenticationStep('return', jar);
    expect(same.status).toBe(303);
    expect(new URL(same.headers.get('location') ?? '').pathname).toBe('/developers/apps');

    expect((await reauthenticationStep('start', jar)).status).toBe(200);
    // Google offered another (known) account, and the climber picked it.
    await googleSignIn(jar, { ...identityB, authTimeSeconds: nowSeconds() - 10 }, GOOGLE_FORCED_REAUTHENTICATION);
    const other = await reauthenticationStep('return', jar);
    const location = new URL(other.headers.get('location') ?? '');
    expect(location.pathname).toBe('/auth/reauthenticate');
    expect(location.searchParams.get('outcome')).toBe('other_account');

    // Without a started re-sign-in nothing is forwarded either.
    const expired = await reauthenticationStep('return', jar);
    expect(new URL(expired.headers.get('location') ?? '').searchParams.get('outcome')).toBe('expired');
  });
});
