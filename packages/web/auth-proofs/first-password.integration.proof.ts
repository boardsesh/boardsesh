import './legacy-credential-fixture';
// @vitest-environment node
/**
 * #7596 B5e2: www's first-password routes under `AUTH_BROWSER_SESSION_MODE=better-auth`.
 * The real routes, the real backend first-password and web-session handlers
 * over HTTP, real PostgreSQL. Only the mail transport is replaced, to read the
 * link the climber would get; nothing scripts a backend reply, and one case
 * drops a reply the backend really sent.
 */
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { signBrowserSessionCookie } from '@boardsesh/auth-protocol/browser-session-cookie';
import { authFirstPasswordChallenges, userCredentials, users } from '@boardsesh/db/schema';
import { createEnvironment } from '../../backend/src/auth/authority/__tests__/environment';
import { createProviderSecurityDriver } from '../../backend/src/auth/authority/__tests__/provider-security-fixture';
import { readFirstPartySession } from '../../backend/src/auth/authority/session-reader';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../backend/src/auth/current-store/foundation-context';
import { CookieJar, ORIGIN, callRoute, patchNextRequestIo, setCookies } from './route-harness';
import {
  COOKIE_SECRET,
  DOMAIN,
  LOGIN,
  PROOF_PROJECTION_ID,
  browserSteps,
  canonicalStatus,
  randomClientAddress,
  reserveClimberEmail,
  startWebSessionBackend,
  stubBetterAuthEnvironment,
  type WebSessionBackend,
} from './web-session-harness';
import { addProviderSecurityTables, expectNoSessionCookie } from './provider-security-steps';

const holder = vi.hoisted(() => {
  process.env.NEXTAUTH_SECRET = 'first-password-proof-nextauth-secret-7596-b5e2';
  process.env.NEXTAUTH_URL = 'https://www.boardsesh.com';
  return { database: undefined as unknown, mail: [] as { recipient: string; token: string; operation: string }[] };
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
vi.mock('../app/lib/auth/browser-session-mode.server', async (original) => {
  const actual = await original<typeof import('../app/lib/auth/browser-session-mode.server')>();
  return { ...actual, browserSessionRouteMode: actual.browserSessionRouteModeResolver([]) };
});
// The mail transport only: what the climber would receive.
vi.mock('@boardsesh/email', async (original) => ({
  ...(await original<typeof import('@boardsesh/email')>()),
  sendFirstPasswordConfirmationEmail: async (recipient: string, token: string, operation: string, origin: string) => {
    if (origin !== 'https://www.boardsesh.com') throw new Error('Unexpected origin');
    holder.mail.push({ recipient, token, operation });
  },
}));

import * as authRoute from '../app/api/auth/[...nextauth]/route';
import * as firstPasswordRoute from '../app/api/auth/first-password/[...step]/route';
import * as providerSecurityRoute from '../app/api/auth/provider-security/[...step]/route';

const secret = 'first-password-proof-nextauth-secret-7596-b5e2';
const NEW_PASSWORD = 'a first password for Apple climbers';
const FLOW_COOKIE = '__Host-boardsesh.first-password-flow';
const FINALIZE_PATH = '/api/internal/auth/current-store/first-password/v1/finalize';
const { login } = browserSteps(authRoute);
let environment: Awaited<ReturnType<typeof createEnvironment>>;
let backend: WebSessionBackend;
let driver: Awaited<ReturnType<typeof createProviderSecurityDriver>>;
const realFetch = globalThis.fetch;
let dropFinalizeReply = false;

beforeAll(async () => {
  environment = await createEnvironment();
  await addProviderSecurityTables(environment.client);
  await environment.client.unsafe(
    readFileSync(new URL('../../db/drizzle/0314_first_password_challenges.sql', import.meta.url), 'utf8'),
  );
  holder.database = environment.database;
  backend = await startWebSessionBackend(environment.database);
  patchNextRequestIo();
  driver = await createProviderSecurityDriver({
    database: environment.database,
    runtime: {
      qualification: {
        expectedProjectionId: PROOF_PROJECTION_ID,
        expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
      },
      legacySecret: secret,
      methods: { configuredProviders: ['google', 'apple'], googleAudience: null, googleReauthenticationEnabled: false },
    },
  });
});
beforeEach(() => {
  holder.mail = [];
  dropFinalizeReply = false;
  stubBetterAuthEnvironment(backend.origin);
  vi.stubEnv('AUTH_BROWSER_ACCESS_TOKEN_SECRET', 'first-password-proof-access-secret-7596-b5e2-x');
  vi.stubEnv('CURRENT_STORE_FIRST_PASSWORD_MODE', 'backend-staging');
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (dropFinalizeReply && url.endsWith(FINALIZE_PATH)) {
      dropFinalizeReply = false;
      await (await realFetch(input, init)).text();
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
  await backend?.close();
  await environment?.close();
});

/** An Apple-only climber who owns their address, signed in on a browser with a first-party session. */
/** A climber with no password and one identity (Apple by default), signed in with a first-party session. */
async function appleOnlyClimber(provider: 'apple' | 'google' = 'apple') {
  const owner = await driver.actor('current-store', 'canonical-token', { password: false, provider });
  const [user] = await environment.database.select().from(users).where(eq(users.id, owner.userId));
  await reserveClimberEmail(environment.database, { id: user.id, email: user.email });
  const presented = owner.webActor.presented;
  if (presented.kind !== 'canonical-token') throw new Error('Expected a canonical session');
  return { owner, email: user.email, jar: jarFor(presented.token) };
}

function jarFor(token: string): CookieJar {
  const jar = new CookieJar();
  jar.set(LOGIN, signBrowserSessionCookie('login', token, COOKIE_SECRET), DOMAIN);
  return jar;
}

async function viewerOf(jar: CookieJar): Promise<string> {
  const response = await callRoute(authRoute, '/api/auth/session', {
    cookie: jar.header(),
    headers: { 'x-forwarded-for': randomClientAddress() },
  });
  const session = (await response.json()) as { user?: { id?: string }; authSessionId?: string };
  return `${session.user?.id}:${session.authSessionId}`;
}

async function post(
  step: string,
  jar: CookieJar,
  body: Record<string, unknown> = {},
  overrides: { origin?: string; viewer?: string | null; headers?: Record<string, string> } = {},
) {
  const viewer = overrides.viewer === undefined ? await viewerOf(jar) : overrides.viewer;
  const request = new NextRequest(new URL(`/api/auth/first-password/${step}`, ORIGIN), {
    method: 'POST',
    headers: {
      origin: overrides.origin ?? ORIGIN,
      cookie: jar.header(),
      'content-type': 'application/json',
      'x-forwarded-for': randomClientAddress(),
      ...(viewer === null ? {} : { 'X-Boardsesh-Expected-Viewer': viewer }),
      ...overrides.headers,
    },
    body: JSON.stringify(body),
  });
  const response = await firstPasswordRoute.POST(request, { params: Promise.resolve({ step: step.split('/') }) });
  expectNoSessionCookie(response);
  jar.apply(response);
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, response };
}

async function hasPassword(userId: string): Promise<boolean> {
  return (
    (await environment.database.select().from(userCredentials).where(eq(userCredentials.userId, userId))).length > 0
  );
}

async function sessionOf(token: string) {
  const read = await readFirstPartySession(environment.database, { kind: 'canonical-token', token });
  if (read.status !== 'admitted') throw new Error('Session not live');
  return read.session;
}

describe.each([undefined, '', 'legacy'])('with the mode %j (as on main)', (mode) => {
  it('answers 404', async () => {
    vi.stubEnv('AUTH_BROWSER_SESSION_MODE', mode);
    const { jar } = await appleOnlyClimber();
    expect((await post('request', jar)).status).toBe(404);
  });
});

describe('first password under better-auth', () => {
  it('answers 503 while www has no staged first password', async () => {
    const { jar } = await appleOnlyClimber();
    vi.stubEnv('CURRENT_STORE_FIRST_PASSWORD_MODE', 'legacy');
    expect((await post('request', jar)).status).toBe(503);
  });

  it('sets the password from the emailed link in the same session: token kept, generation moved, no session cookie', async () => {
    const { owner, email, jar } = await appleOnlyClimber();
    const token = owner.webActor.presented.kind === 'canonical-token' ? owner.webActor.presented.token : '';
    const other = await driver.secondSession(owner);
    const before = await sessionOf(token);

    const requested = await post('request', jar);
    expect(requested.body).toMatchObject({ status: 'sent' });
    const flowCookie = setCookies(requested.response).find((header) => header.startsWith(`${FLOW_COOKIE}=`)) ?? '';
    for (const attribute of [/HttpOnly/i, /Secure/i, /SameSite=Lax/i, /Path=\//i])
      expect(flowCookie).toMatch(attribute);
    expect(flowCookie).not.toMatch(/Domain=/i);
    expect(holder.mail).toHaveLength(1);
    const [{ recipient, token: confirmation, operation }] = holder.mail;
    expect(recipient).toBe(email);
    // The page's JSON never carries a backend token.
    expect(JSON.stringify(requested.body)).not.toContain(confirmation);

    expect((await post('status', jar, { operation })).body).toMatchObject({ status: 'pending' });
    const done = await post('confirm', jar, {
      operation,
      token: confirmation,
      password: NEW_PASSWORD,
      confirmPassword: NEW_PASSWORD,
    });
    expect(done.body).toMatchObject({ status: 'committed', refreshAccessToken: true });
    expect(jar.get(FLOW_COOKIE)).toBeUndefined();
    expect(await hasPassword(owner.userId)).toBe(true);
    const after = await sessionOf(token);
    expect(after.authSessionId).toBe(before.authSessionId);
    expect(after.generation).toBe(before.generation + 1);
    expect(await canonicalStatus(environment.database, other.credential.token)).not.toBe('admitted');
    // The new password signs in.
    const fresh = new CookieJar();
    await login(fresh, email, NEW_PASSWORD);
    expect(fresh.get(LOGIN, DOMAIN)).toBeDefined();
  });

  it('a link opened by another session, another account or another browser changes nothing', async () => {
    const { owner, jar } = await appleOnlyClimber();
    await post('request', jar);
    const [{ token: confirmation, operation }] = holder.mail;
    const flow = jar.get(FLOW_COOKIE) ?? '';
    const confirmBody = { operation, token: confirmation, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD };

    const sameAccount = jarFor((await driver.secondSession(owner)).credential.token);
    sameAccount.set(FLOW_COOKIE, flow);
    expect((await post('status', sameAccount, { operation })).body).toEqual({ status: 'other_account' });
    expect((await post('confirm', sameAccount, confirmBody)).body).toEqual({ status: 'other_account' });

    const another = await appleOnlyClimber();
    another.jar.set(FLOW_COOKIE, flow);
    expect((await post('confirm', another.jar, confirmBody)).body).toEqual({ status: 'other_account' });

    const otherBrowser = jarFor(
      owner.webActor.presented.kind === 'canonical-token' ? owner.webActor.presented.token : '',
    );
    expect((await post('confirm', otherBrowser, confirmBody)).body).toEqual({ status: 'other_browser' });
    expect(await hasPassword(owner.userId)).toBe(false);
    expect(await hasPassword(another.owner.userId)).toBe(false);
    // The browser that asked still can.
    expect((await post('confirm', jar, confirmBody)).body).toMatchObject({ status: 'committed' });
  });

  it('refuses a replayed confirmation, and recovers a lost finalize reply', async () => {
    const { owner, jar } = await appleOnlyClimber();
    await post('request', jar);
    const [{ token: confirmation, operation }] = holder.mail;
    const flow = jar.get(FLOW_COOKIE) ?? '';
    const confirmBody = { operation, token: confirmation, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD };
    dropFinalizeReply = true;
    expect((await post('confirm', jar, confirmBody)).body).toMatchObject({ status: 'committed' });
    expect(await hasPassword(owner.userId)).toBe(true);
    jar.set(FLOW_COOKIE, flow);
    const replayed = await post('confirm', jar, confirmBody);
    expect(replayed.status).not.toBe(200);
    expect(replayed.body).toMatchObject({ status: 'refused' });
  });

  it('refuses a legacy-only browser with canonical_session_required and writes nothing', async () => {
    const { owner, jar } = await appleOnlyClimber();
    const legacy = await driver.actor('current-store', 'legacy-jwe', { password: false, provider: 'apple' });
    const legacyJar = new CookieJar();
    legacyJar.set('__Secure-next-auth.session-token', legacy.actor.credential, DOMAIN);
    const refused = await post('request', legacyJar);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ outcome: 'canonical_session_required' });
    expect(holder.mail).toHaveLength(0);
    expect(await hasPassword(owner.userId)).toBe(false);
    expect(jar.get(FLOW_COOKIE)).toBeUndefined();
  });

  it('refuses a wrong Origin, a cross-site request and a missing viewer header, and sends no email', async () => {
    const { jar } = await appleOnlyClimber();
    expect((await post('request', jar, {}, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post('request', jar, {}, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect((await post('request', jar, {}, { viewer: null })).status).toBe(409);
    expect(holder.mail).toHaveLength(0);
  });

  it('an expired link is refused and sets nothing', async () => {
    const { owner, jar } = await appleOnlyClimber();
    await post('request', jar);
    const [{ token: confirmation, operation }] = holder.mail;
    await environment.database
      .update(authFirstPasswordChallenges)
      .set({ issuedAt: new Date(Date.now() - 10 * 60_000), expiresAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(authFirstPasswordChallenges.userId, owner.userId));
    expect((await post('status', jar, { operation })).body).toMatchObject({ status: 'refused', code: 'expired' });
    const confirmed = await post('confirm', jar, {
      operation,
      token: confirmation,
      password: NEW_PASSWORD,
      confirmPassword: NEW_PASSWORD,
    });
    // The expired flow was cleared by the refusal, so nothing of it can be finished.
    expect(confirmed.body.status).not.toBe('committed');
    expect(await hasPassword(owner.userId)).toBe(false);
  });

  it('a second request ends the first link', async () => {
    const { owner, jar } = await appleOnlyClimber();
    await post('request', jar);
    const firstFlow = jar.get(FLOW_COOKIE) ?? '';
    await post('request', jar);
    const [first, second] = holder.mail;
    const body = (link: { token: string; operation: string }) => ({
      operation: link.operation,
      token: link.token,
      password: NEW_PASSWORD,
      confirmPassword: NEW_PASSWORD,
    });
    // This browser's flow is the second one now.
    expect((await post('confirm', jar, body(first))).body).toEqual({ status: 'other_browser' });
    const stale = new CookieJar();
    for (const name of jar.names())
      stale.set(name, jar.get(name, DOMAIN) ?? jar.get(name) ?? '', jar.get(name, DOMAIN) ? DOMAIN : '');
    stale.set(FLOW_COOKIE, firstFlow);
    expect((await post('confirm', stale, body(first))).body).toMatchObject({ status: 'refused' });
    expect(await hasPassword(owner.userId)).toBe(false);
    expect((await post('confirm', jar, body(second))).body).toMatchObject({ status: 'committed' });
  });

  it('a Google-only climber sets a password, and methods then shows it (decision of 2026-11-18)', async () => {
    vi.stubEnv('CURRENT_STORE_PROVIDER_SECURITY_MODE', 'backend-staging');
    vi.stubEnv('GOOGLE_CLIENT_ID', 'first-password-proof.apps.googleusercontent.test');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'first-password-proof-google-secret');
    const { owner, jar } = await appleOnlyClimber('google');
    expect((await post('request', jar)).body).toMatchObject({ status: 'sent' });
    const [{ token: confirmation, operation }] = holder.mail;
    const done = await post('confirm', jar, {
      operation,
      token: confirmation,
      password: NEW_PASSWORD,
      confirmPassword: NEW_PASSWORD,
    });
    expect(done.body).toMatchObject({ status: 'committed', refreshAccessToken: true });
    expect(await hasPassword(owner.userId)).toBe(true);
    const methodsRequest = new NextRequest(new URL('/api/auth/provider-security/methods', ORIGIN), {
      headers: { cookie: jar.header(), 'x-forwarded-for': randomClientAddress() },
    });
    const methods = await providerSecurityRoute.GET(methodsRequest, { params: Promise.resolve({ step: ['methods'] }) });
    expect(methods.status).toBe(200);
    expect(await methods.json()).toMatchObject({
      passwordUsable: true,
      providers: [expect.objectContaining({ provider: 'google', canUnlink: true })],
    });
  });
});
