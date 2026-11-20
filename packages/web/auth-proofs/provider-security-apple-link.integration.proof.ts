import './legacy-credential-fixture';
// @vitest-environment node
/**
 * #7596 B5e1, Apple: www's provider link under
 * `AUTH_BROWSER_SESSION_MODE=better-auth`, through Apple's `form_post` round
 * trip against a loopback stand-in that signs real RS256 ID tokens. Real
 * routes, the real backend provider-security and web-session handlers over
 * HTTP, real PostgreSQL. Nothing scripts a backend reply.
 *
 * Apple answers with a cross-site POST, which carries the SameSite=None flow
 * cookie and never the Lax session cookie. www holds the POST inside the
 * sealed flow cookie (after its state matched) and finishes on the same-site
 * GET that carries the session. The link keeps the session token and writes
 * no session cookie (HARD RULE 2).
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createEnvironment } from '../../backend/src/auth/authority/__tests__/environment';
import { readFirstPartySession } from '../../backend/src/auth/authority/session-reader';
import { CookieJar, ORIGIN, callRoute, patchNextRequestIo, setCookies } from './route-harness';
import {
  BRIDGED,
  LEGACY,
  LOGIN,
  MARKER,
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
import { startAppleOidcFixture, type AppleIdentity } from './apple-oidc-fixture';
import {
  FLOW_COOKIE,
  addProviderSecurityTables,
  expectNoSessionCookie,
  flowCookieOf,
  providerSecuritySteps,
} from './provider-security-steps';

const holder = vi.hoisted(() => {
  process.env.NEXTAUTH_SECRET = 'provider-security-apple-link-proof-nextauth-secret-7596';
  process.env.NEXTAUTH_URL = 'https://www.boardsesh.com';
  process.env.APPLE_ID = 'com.boardsesh.provider-security-apple-link-proof';
  process.env.APPLE_SECRET = 'provider-security-apple-link-proof-client-secret-jwt';
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
import { authOptions } from '../app/lib/auth/auth-options';

const secret = 'provider-security-apple-link-proof-nextauth-secret-7596';
const CALLBACK_PATH = '/api/auth/provider-security/callback/apple';
const { login } = browserSteps(authRoute);
let environment: Awaited<ReturnType<typeof createEnvironment>>;
let backend: WebSessionBackend;
let apple: Awaited<ReturnType<typeof startAppleOidcFixture>>;
let steps: ReturnType<typeof providerSecuritySteps>;

beforeAll(async () => {
  environment = await createEnvironment();
  await addProviderSecurityTables(environment.client);
  holder.database = environment.database;
  backend = await startWebSessionBackend(environment.database);
  apple = await startAppleOidcFixture({
    clientId: process.env.APPLE_ID ?? '',
    clientSecret: process.env.APPLE_SECRET ?? '',
  });
  patchNextRequestIo();
  const provider = authOptions.providers.find((configured) => configured.id === 'apple');
  if (!provider || provider.type !== 'oauth' || !provider.options) throw new Error('No Apple provider configured');
  Object.assign(provider.options, { wellKnown: apple.discoveryUrl });
  // This proof never takes a Google round trip.
  steps = providerSecuritySteps(providerSecurityRoute, authRoute, {
    authorize: async () => {
      throw new Error('No Google round trip in the Apple link proof');
    },
  });
});
beforeEach(() => {
  stubBetterAuthEnvironment(backend.origin);
  vi.stubEnv('AUTH_BROWSER_ACCESS_TOKEN_SECRET', 'provider-security-apple-link-proof-access-secret-7596');
  vi.stubEnv('CURRENT_STORE_PROVIDER_SECURITY_MODE', 'backend-staging');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(console.warn).mockRestore();
});
afterAll(async () => {
  vi.restoreAllMocks();
  await apple?.close();
  await backend?.close();
  await environment?.close();
});

const newAppleIdentity = (): AppleIdentity => {
  const id = randomUUID();
  return { subject: `apple-${id}`, email: `apple-${id}@privaterelay.example.test`, firstSignIn: true };
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

/** Apple's form, posted cross-site to the callback with only the cookies such a POST carries. */
async function postAppleForm(jar: CookieJar, fields: Record<string, string>) {
  const cookie = jar.crossSiteHeader(CALLBACK_PATH);
  const request = new NextRequest(new URL(CALLBACK_PATH, ORIGIN), {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://appleid.apple.com',
      'sec-fetch-site': 'cross-site',
      'x-forwarded-for': randomClientAddress(),
    },
    body: new URLSearchParams(fields).toString(),
  });
  const response = await providerSecurityRoute.POST(request, {
    params: Promise.resolve({ step: ['callback', 'apple'] }),
  });
  expectNoSessionCookie(response);
  jar.apply(response);
  return { cookie, response };
}

/** Start an Apple link and reauthenticate with the password: Apple's authorization URL. */
async function linkUpToApple(jar: CookieJar): Promise<URL> {
  const started = await steps.post('start', jar, { action: 'link', provider: 'apple', returnTo: '/settings' });
  expect(started.status).toBe(200);
  const flowCookie = flowCookieOf(started) ?? '';
  // Apple answers cross-site, so the flow cookie is SameSite=None, still host-only, Secure and HttpOnly.
  for (const attribute of [/HttpOnly/i, /Secure/i, /SameSite=None/i, /Path=\//i]) expect(flowCookie).toMatch(attribute);
  expect(flowCookie).not.toMatch(/Domain=/i);
  const proved = await steps.post('reauthenticate/password', jar, { password: PASSWORD });
  expect(proved.status).toBe(200);
  const body = (await proved.json()) as { status: string; url: string };
  expect(body.status).toBe('redirect');
  return new URL(body.url);
}

async function appleLinked(jar: CookieJar): Promise<boolean> {
  return (await steps.methodsOf(jar)).providers.some((method) => method.provider === 'apple');
}

describe('Apple link under better-auth', () => {
  it('reports Apple as linkable in methods, and still cannot reauthenticate with it', async () => {
    const { jar } = await signedInClimber();
    const methods = await steps.methodsOf(jar);
    expect(methods.linking.apple).toEqual({ available: true });
    expect(methods.reauthentication.apple).toBe(false);
    // Apple can be linked, but Apple itself never proves a fresh sign-in (no backend verifier, #7655).
    expect((await steps.post('start', jar, { action: 'link', provider: 'apple' })).status).toBe(200);
    const refused = await steps.post('reauthenticate/apple', jar);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ outcome: 'reauthentication_unavailable' });
  });

  it('holds the cross-site form_post in the flow cookie, resumes on the same-site GET and links: same token, no session cookie', async () => {
    const { climber, jar } = await signedInClimber();
    const second = new CookieJar();
    await login(second, climber.email);
    const before = await liveSession(jar);
    const token = loginToken(jar);

    const authorization = await linkUpToApple(jar);
    expect(authorization.searchParams.get('response_mode')).toBe('form_post');
    expect(authorization.searchParams.get('scope')).toBe('name email');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const formPost = apple.authorize(authorization.href, newAppleIdentity());
    expect(new URL(formPost.action).pathname).toBe(CALLBACK_PATH);

    // The POST carries the SameSite=None flow cookie and no session cookie of any name.
    const sealedBefore = jar.get(FLOW_COOKIE);
    const { cookie, response: held } = await postAppleForm(jar, formPost.fields);
    expect(cookie).toContain(`${FLOW_COOKIE}=`);
    for (const name of [LOGIN, BRIDGED, LEGACY, MARKER]) expect(cookie).not.toContain(`${name}=`);
    expect(held.status).toBe(303);
    const resume = new URL(held.headers.get('location') ?? '');
    expect(`${resume.pathname}${resume.search}`).toBe(`${CALLBACK_PATH}?resume=1`);
    // The hold rewrote the sealed flow cookie (the code and state are inside it now); nothing is linked yet.
    expect(jar.get(FLOW_COOKIE)).toBeTruthy();
    expect(jar.get(FLOW_COOKIE)).not.toBe(sealedBefore);
    expect(await appleLinked(jar)).toBe(false);

    const finished = await steps.call('GET', 'callback/apple?resume=1', jar);
    jar.apply(finished);
    expect(steps.resultOf(finished)).toBe('linked');
    expect(new URL(finished.headers.get('location') ?? '').searchParams.get('provider')).toBe('apple');
    expect(jar.get(FLOW_COOKIE)).toBeUndefined();
    expect(await appleLinked(jar)).toBe(true);
    // The session kept its token, id and sign-in time; only its generation moved; the other session ended.
    const after = await liveSession(jar);
    expect(loginToken(jar)).toBe(token);
    expect(after.authSessionId).toBe(before.authSessionId);
    expect(after.generation).toBe(before.generation + 1);
    expect(await canonicalStatus(environment.database, loginToken(second))).not.toBe('admitted');
    const read = await callRoute(authRoute, '/api/auth/session', {
      cookie: jar.header(),
      headers: { 'x-forwarded-for': randomClientAddress() },
    });
    expect(setCookies(read)).toEqual([]);
    expect(await read.json()).toMatchObject({ user: { id: climber.id }, authSessionId: before.authSessionId });
  });

  it('refuses a form_post whose state matches no round trip of the flow, and a resume with nothing held', async () => {
    const { jar } = await signedInClimber();
    const authorization = await linkUpToApple(jar);
    const formPost = apple.authorize(authorization.href, newAppleIdentity());
    const { response: mismatched } = await postAppleForm(jar, { ...formPost.fields, state: 'not-the-flow-state' });
    expect(steps.resultOf(mismatched)).toBe('state_mismatch');
    const unheld = await steps.call('GET', 'callback/apple?resume=1', jar);
    expect(steps.resultOf(unheld)).toBe('state_mismatch');
    expect(await appleLinked(jar)).toBe(false);
  });

  it('a resume from another account’s session finishes nothing', async () => {
    const a = await signedInClimber();
    const b = await signedInClimber();
    const authorization = await linkUpToApple(a.jar);
    const formPost = apple.authorize(authorization.href, newAppleIdentity());
    await postAppleForm(a.jar, formPost.fields);
    // B's browser somehow holds A's held flow cookie.
    b.jar.set(FLOW_COOKIE, a.jar.get(FLOW_COOKIE) ?? '', '', { sameSite: 'none' });
    const resumed = await steps.call('GET', 'callback/apple?resume=1', b.jar);
    expect(steps.resultOf(resumed)).toBe('identity_changed');
    expect(await appleLinked(a.jar)).toBe(false);
    expect(await appleLinked(b.jar)).toBe(false);
    expect(await canonicalStatus(environment.database, loginToken(a.jar))).toBe('admitted');
    expect(await canonicalStatus(environment.database, loginToken(b.jar))).toBe('admitted');
  });

  it('a cancelled Apple answer ends the flow and links nothing', async () => {
    const { jar } = await signedInClimber();
    const authorization = await linkUpToApple(jar);
    const formPost = apple.authorize(authorization.href, newAppleIdentity());
    const withoutCode = Object.fromEntries(Object.entries(formPost.fields).filter(([name]) => name !== 'code'));
    await postAppleForm(jar, { ...withoutCode, error: 'user_cancelled_authorize' });
    const finished = await steps.call('GET', 'callback/apple?resume=1', jar);
    expect(steps.resultOf(finished)).toBe('cancelled');
    expect(await appleLinked(jar)).toBe(false);
  });
});
