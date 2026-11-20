import './legacy-credential-fixture';
// @vitest-environment node
/**
 * #7596 B5e1: www's provider link routes under `AUTH_BROWSER_SESSION_MODE=better-auth`.
 * Real routes, the real backend provider-security and web-session handlers
 * over HTTP, real PostgreSQL, real Google round trips against a loopback
 * stand-in that signs real ID tokens. Nothing scripts a backend reply; one
 * case drops a reply the backend really sent.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { authProviderSecurityIntents } from '@boardsesh/db/schema/auth';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createEnvironment } from '../../backend/src/auth/authority/__tests__/environment';
import { readFirstPartySession } from '../../backend/src/auth/authority/session-reader';
import { CookieJar, ORIGIN, callRoute, patchNextRequestIo, setCookies } from './route-harness';
import {
  LEGACY,
  LOGIN,
  PASSWORD,
  browserSteps,
  canonicalStatus,
  createClimber,
  loginToken,
  randomClientAddress,
  startWebSessionBackend,
  stubBetterAuthEnvironment,
  type WebSessionBackend,
} from './web-session-harness';
import { GOOGLE_CERTS_URL, startGoogleOidcFixture, type GoogleIdentity } from './google-oidc-fixture';
import {
  FLOW_COOKIE,
  addProviderSecurityTables,
  expectNoSessionCookie,
  flowCookieOf,
  providerSecuritySteps,
} from './provider-security-steps';

const holder = vi.hoisted(() => {
  process.env.NEXTAUTH_SECRET = 'provider-security-link-proof-nextauth-secret-7596';
  process.env.NEXTAUTH_URL = 'https://www.boardsesh.com';
  process.env.GOOGLE_CLIENT_ID = 'provider-security-link-proof.apps.googleusercontent.test';
  process.env.GOOGLE_CLIENT_SECRET = 'provider-security-link-proof-google-secret';
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
import * as providerSecurityRoute from '../app/api/auth/provider-security/[...step]/route';
import { GET as wsAuthRoute } from '../app/api/internal/ws-auth/route';
import { authOptions } from '../app/lib/auth/auth-options';

const secret = 'provider-security-link-proof-nextauth-secret-7596';
const FINALIZE_PATH = '/api/internal/auth/current-store/provider-security/v1/finalize';
const RECOVER_PATH = '/api/internal/auth/current-store/provider-security/v1/recover';
const { csrf, login } = browserSteps(authRoute);
let environment: Awaited<ReturnType<typeof createEnvironment>>;
let backend: WebSessionBackend;
let google: Awaited<ReturnType<typeof startGoogleOidcFixture>>;
let graphqlFetch: (request: Request) => Promise<Response>;
let steps: ReturnType<typeof providerSecuritySteps>;
const realFetch = globalThis.fetch;
/** Drop the next finalize reply after the backend sent it (a lost reply). */
let dropFinalizeReply = false;
let recoverCalls = 0;

beforeAll(async () => {
  environment = await createEnvironment();
  await addProviderSecurityTables(environment.client);
  holder.database = environment.database;
  backend = await startWebSessionBackend(environment.database);
  google = await startGoogleOidcFixture(process.env.GOOGLE_CLIENT_ID ?? '');
  patchNextRequestIo();
  const provider = authOptions.providers.find((configured) => configured.id === 'google');
  if (!provider || provider.type !== 'oauth' || !provider.options) throw new Error('No Google provider configured');
  Object.assign(provider.options, { wellKnown: google.discoveryUrl });
  const { createYogaInstance } = await import('../../backend/src/graphql/yoga');
  const yoga = createYogaInstance();
  graphqlFetch = async (request) => yoga.fetch(request);
  steps = providerSecuritySteps(providerSecurityRoute, authRoute, google);
});
beforeEach(() => {
  dropFinalizeReply = false;
  recoverCalls = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === GOOGLE_CERTS_URL) return Response.json(google.certificates());
    if (url.endsWith(RECOVER_PATH)) recoverCalls += 1;
    if (dropFinalizeReply && url.endsWith(FINALIZE_PATH)) {
      dropFinalizeReply = false;
      const delivered = await realFetch(input, init);
      await delivered.text();
      throw new TypeError('The finalize reply was lost on the way back');
    }
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
  vi.stubEnv('AUTH_BROWSER_ACCESS_TOKEN_SECRET', 'provider-security-link-proof-access-secret-7596-b5e1');
  vi.stubEnv('CURRENT_STORE_PROVIDER_GOOGLE_AUTH_TIME_MODE', 'auth-time-staging');
  vi.stubEnv('CURRENT_STORE_PROVIDER_SECURITY_MODE', 'backend-staging');
}

const newGoogleIdentity = (authAgoSeconds = 30): GoogleIdentity => {
  const id = randomUUID();
  return {
    subject: `google-${id}`,
    email: `google-${id}@example.test`,
    authTimeSeconds: Math.floor(Date.now() / 1000) - authAgoSeconds,
  };
};

async function signedInClimber() {
  const climber = await createClimber(environment.database);
  const jar = new CookieJar();
  await login(jar, climber.email);
  return { climber, jar };
}

async function liveSession(jar: CookieJar) {
  const read = await readFirstPartySession(environment.database, { kind: 'canonical-token', token: loginToken(jar) });
  if (read.status !== 'admitted') throw new Error('The login cookie does not read as live');
  return read.session;
}

async function accessToken(jar: CookieJar): Promise<string> {
  const response = await wsAuthRoute(
    new NextRequest(new URL('/api/internal/ws-auth', ORIGIN), {
      headers: { cookie: jar.header(), 'x-forwarded-for': randomClientAddress() },
    }),
  );
  const { token } = (await response.json()) as { token: string | null };
  if (!token) throw new Error('No access token');
  return token;
}

async function graphqlViewer(bearer: string): Promise<string | null> {
  const response = await graphqlFetch(
    new Request('http://backend.invalid/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ query: '{ authenticatedUserId }' }),
    }),
  );
  const body = (await response.json()) as { data?: { authenticatedUserId?: string | null } };
  return body.data?.authenticatedUserId ?? null;
}

/** Start a link and reauthenticate with the password: the provider authorization URL. */
async function linkUpToProvider(jar: CookieJar): Promise<string> {
  expect((await steps.post('start', jar, { action: 'link', provider: 'google' })).status).toBe(200);
  const proved = await steps.post('reauthenticate/password', jar, { password: PASSWORD });
  expect(proved.status).toBe(200);
  const body = (await proved.json()) as { status: string; url: string };
  expect(body.status).toBe('redirect');
  return body.url;
}

async function googleLinked(jar: CookieJar): Promise<boolean> {
  return (await steps.methodsOf(jar)).providers.some((method) => method.provider === 'google');
}

describe.each([undefined, '', 'legacy'])('with the mode %j (as on main)', (mode) => {
  it('answers 404 on every provider-security route', async () => {
    betterAuth();
    vi.stubEnv('AUTH_BROWSER_SESSION_MODE', mode);
    const { jar } = await signedInClimber();
    expect((await steps.call('GET', 'methods', jar)).status).toBe(404);
    expect((await steps.call('POST', 'start', jar, { body: { action: 'link', provider: 'google' } })).status).toBe(404);
    expect((await steps.call('GET', 'callback/google?state=x&code=y', jar)).status).toBe(404);
  });
});

describe('provider link under better-auth', () => {
  beforeEach(betterAuth);

  it('answers 503 while www has no staged provider security', async () => {
    const { jar } = await signedInClimber();
    vi.stubEnv('CURRENT_STORE_PROVIDER_SECURITY_MODE', 'legacy');
    expect((await steps.call('GET', 'methods', jar)).status).toBe(503);
  });

  it('refuses a start from another origin or without one, and a legacy-only browser until it bridges', async () => {
    const { jar } = await signedInClimber();
    const viewer = await steps.viewerOf(jar);
    const body = { action: 'link', provider: 'google' };
    expect((await steps.call('POST', 'start', jar, { body, viewer, origin: 'https://evil.example' })).status).toBe(403);
    expect((await steps.call('POST', 'start', jar, { body, viewer, origin: null })).status).toBe(403);
    // The right Origin, but the browser says the request came from another site.
    const crossSite = { body, viewer, headers: { 'sec-fetch-site': 'cross-site' } };
    expect((await steps.call('POST', 'start', jar, crossSite)).status).toBe(403);
    expect((await steps.call('POST', 'start', jar, { body })).status).toBe(409);
    // A browser signed in before the cutover holds only the legacy cookie.
    const climber = await createClimber(environment.database);
    const legacyOnly = new CookieJar();
    vi.stubEnv('AUTH_BROWSER_SESSION_MODE', '');
    await login(legacyOnly, climber.email);
    betterAuth();
    expect(legacyOnly.names()).toContain(LEGACY);
    expect(legacyOnly.names()).not.toContain(LOGIN);
    const legacyViewer = await steps.viewerOf(legacyOnly);
    const refused = await steps.call('POST', 'start', legacyOnly, { body, viewer: legacyViewer });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ outcome: 'canonical_session_required' });
    // The client re-reads the session (which bridges the legacy cookie) and retries once.
    legacyOnly.apply(
      await callRoute(authRoute, '/api/auth/session', {
        cookie: legacyOnly.header(),
        headers: { 'x-forwarded-for': randomClientAddress() },
      }),
    );
    expect((await steps.call('POST', 'start', legacyOnly, { body, viewer: legacyViewer })).status).toBe(200);
  });

  it('links Google: same token, moved generation, other session ended, no session cookie, old access token refused', async () => {
    const { climber, jar } = await signedInClimber();
    const second = new CookieJar();
    await login(second, climber.email);
    const before = await liveSession(jar);
    const token = loginToken(jar);
    const oldAccess = await accessToken(jar);
    expect(await graphqlViewer(oldAccess)).toBe(climber.id);

    const started = await steps.post('start', jar, { action: 'link', provider: 'google', returnTo: '/settings' });
    expect(await started.json()).toMatchObject({ status: 'reauthentication_required', action: 'link' });
    const flowCookie = flowCookieOf(started) ?? '';
    for (const attribute of [/HttpOnly/i, /Secure/i, /SameSite=Lax/i, /Path=\//i])
      expect(flowCookie).toMatch(attribute);
    expect(flowCookie).not.toMatch(/Domain=/i);

    const proved = await steps.post('reauthenticate/password', jar, { password: PASSWORD });
    const { url } = (await proved.json()) as { url: string };
    const authorization = new URL(url);
    expect(authorization.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorization.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('prompt')).toBe('select_account');

    const { response } = await steps.followGoogle(jar, url, newGoogleIdentity());
    expect(steps.resultOf(response)).toBe('linked');
    expect(jar.get(FLOW_COOKIE)).toBeUndefined();
    const after = await liveSession(jar);
    expect(loginToken(jar)).toBe(token);
    expect(after.authSessionId).toBe(before.authSessionId);
    expect(after.generation).toBe(before.generation + 1);
    expect(after.authenticatedAt?.getTime()).toBe(before.authenticatedAt?.getTime());
    expect(await canonicalStatus(environment.database, loginToken(second))).not.toBe('admitted');
    expect(await googleLinked(jar)).toBe(true);
    expect(await graphqlViewer(oldAccess)).not.toBe(climber.id);
    expect(await graphqlViewer(await accessToken(jar))).toBe(climber.id);
    // The live login cookie outranks the legacy twin, now dead on its old generation: same user, no cookie change.
    const read = await callRoute(authRoute, '/api/auth/session', {
      cookie: jar.header(),
      headers: { 'x-forwarded-for': randomClientAddress() },
    });
    expect(setCookies(read)).toEqual([]);
    expect(await read.json()).toMatchObject({ user: { id: climber.id }, authSessionId: before.authSessionId });
  });

  it('refuses to link an identity another account owns; a failed code exchange gives the intent back', async () => {
    const identity = newGoogleIdentity();
    const owner = new CookieJar();
    await steps.googleSignIn(owner, identity, await csrf(owner));
    const { climber, jar } = await signedInClimber();
    const url = await linkUpToProvider(jar);
    const { response } = await steps.followGoogle(jar, url, identity);
    expect(steps.resultOf(response)).toBe('ownership_conflict');
    expect(await googleLinked(jar)).toBe(false);

    const again = await linkUpToProvider(jar);
    const callback = new URL(await google.authorize(again, newGoogleIdentity()));
    callback.searchParams.set('code', randomBytes(24).toString('base64url'));
    const failed = await steps.call('GET', `callback/google${callback.search}`, jar);
    expect(steps.resultOf(failed)).toBe('provider_not_verified');
    const phases = await environment.database
      .select({ phase: authProviderSecurityIntents.phase })
      .from(authProviderSecurityIntents)
      .where(eq(authProviderSecurityIntents.userId, climber.id));
    expect(phases.map(({ phase }) => phase)).toEqual(['terminal', 'terminal']);
  });

  it('refuses an Apple link where Apple is not configured, and says why in methods', async () => {
    const { jar } = await signedInClimber();
    const refused = await steps.post('start', jar, { action: 'link', provider: 'apple' });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ outcome: 'denied', code: 'provider_unavailable' });
    expect(flowCookieOf(refused)).toBeUndefined();
    const { linking } = await steps.methodsOf(jar);
    expect(linking.google).toEqual({ available: true });
    // This proof configures no Apple client (provider-security-apple-link proof links Apple).
    expect(linking.apple).toEqual({ available: false, reason: 'not_configured' });
  });

  it("refuses another account's session holding A's flow cookie, at a step and at the callback", async () => {
    const a = await signedInClimber();
    const b = await signedInClimber();
    expect((await steps.post('start', a.jar, { action: 'link', provider: 'google' })).status).toBe(200);
    b.jar.set(FLOW_COOKIE, a.jar.get(FLOW_COOKIE) ?? '');
    const atStep = await steps.post('reauthenticate/password', b.jar, { password: PASSWORD });
    expect(atStep.status).toBe(409);
    expect(await atStep.json()).toMatchObject({ outcome: 'identity_changed' });

    const proved = await steps.post('reauthenticate/password', a.jar, { password: PASSWORD });
    const { url } = (await proved.json()) as { url: string };
    b.jar.set(FLOW_COOKIE, a.jar.get(FLOW_COOKIE) ?? '');
    const { response } = await steps.followGoogle(b.jar, url, newGoogleIdentity());
    expect(steps.resultOf(response)).toBe('identity_changed');
    expect(await googleLinked(a.jar)).toBe(false);
    expect(await googleLinked(b.jar)).toBe(false);
    expect(await canonicalStatus(environment.database, loginToken(a.jar))).toBe('admitted');
    expect(await canonicalStatus(environment.database, loginToken(b.jar))).toBe('admitted');
  });

  it('a sign-in round trip cannot finish a link, and a link round trip cannot finish a sign-in', async () => {
    const { jar } = await signedInClimber();
    const before = loginToken(jar);
    const linkUrl = await linkUpToProvider(jar);
    const csrfToken = await csrf(jar);
    const signIn = await callRoute(authRoute, '/api/auth/signin/google', {
      cookie: jar.header(),
      form: { csrfToken, callbackUrl: `${ORIGIN}/`, json: 'true' },
      headers: { 'x-forwarded-for': randomClientAddress() },
    });
    jar.apply(signIn);
    const { url: signInUrl } = (await signIn.clone().json()) as { url: string };
    const identity = newGoogleIdentity();
    const asLink = await steps.followGoogle(jar, signInUrl, identity, '/api/auth/provider-security/callback/google');
    expect(steps.resultOf(asLink.response)).toBe('state_mismatch');
    const asSignIn = await steps.followGoogle(jar, linkUrl, identity, '/api/auth/callback/google');
    expectNoSessionCookie(asSignIn.response);
    expect(loginToken(jar)).toBe(before);
    expect(await canonicalStatus(environment.database, before)).toBe('admitted');
    expect(await googleLinked(jar)).toBe(false);
  });

  it('refuses a callback whose state does not match, then a replayed callback', async () => {
    const { jar } = await signedInClimber();
    const url = await linkUpToProvider(jar);
    const callback = new URL(await google.authorize(url, newGoogleIdentity()));
    const tampered = new URL(callback);
    tampered.searchParams.set('state', randomBytes(32).toString('base64url'));
    const mismatched = await steps.call('GET', `callback/google${tampered.search}`, jar);
    expect(steps.resultOf(mismatched)).toBe('state_mismatch');
    expect(flowCookieOf(mismatched)).toBeUndefined();
    const sealed = jar.get(FLOW_COOKIE) ?? '';

    const genuine = await steps.call('GET', `callback/google${callback.search}`, jar);
    jar.apply(genuine);
    expect(steps.resultOf(genuine)).toBe('linked');
    const replayed = await steps.call('GET', `callback/google${callback.search}`, jar);
    expect(steps.resultOf(replayed)).toBe('expired');
    const withOldCookie = await steps.call('GET', `callback/google${callback.search}`, jar, {
      cookie: `${jar.header()}; ${FLOW_COOKIE}=${sealed}`,
    });
    expect(steps.resultOf(withOldCookie)).not.toBe('linked');
    expect((await steps.methodsOf(jar)).providers.filter((method) => method.provider === 'google')).toHaveLength(1);
  });

  it('a wrong password keeps the flow; a lost finalize reply is recovered with the same session', async () => {
    const { jar } = await signedInClimber();
    expect((await steps.post('start', jar, { action: 'link', provider: 'google' })).status).toBe(200);
    const wrong = await steps.post('reauthenticate/password', jar, { password: 'not the password' });
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toMatchObject({ outcome: 'reauthentication_required' });
    expect(setCookies(wrong)).toEqual([]);
    const proved = await steps.post('reauthenticate/password', jar, { password: PASSWORD });
    const { url } = (await proved.json()) as { url: string };
    dropFinalizeReply = true;
    const { response } = await steps.followGoogle(jar, url, newGoogleIdentity());
    expect(recoverCalls).toBe(1);
    expect(steps.resultOf(response)).toBe('linked');
    expect(await googleLinked(jar)).toBe(true);
  });
});
