// @vitest-environment node
/**
 * #7596 B4c-web: `/api/auth/native/callback`, where the native app's browser
 * sign-in ends and the app's transfer token is minted. Live for every app
 * sign-in, so with `AUTH_BROWSER_SESSION_MODE` unset its answer is pinned.
 * Under `better-auth` the account, its session id, generation and credential
 * proof come from the request's canonical session resolution; the legacy
 * cookie is read only for its account-creation receipt, and only when it
 * names that same login. The NextAuth `native-oauth` provider is refused.
 * Real route exports, real backend web-session handlers over HTTP, real
 * PostgreSQL; nothing scripts a backend reply.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { decode, encode, type JWT } from './legacy-credential-fixture';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { users } from '@boardsesh/db/schema';
import { createEnvironment } from '../../backend/src/auth/authority/__tests__/environment';
import { readFirstPartySession } from '../../backend/src/auth/authority/session-reader';
import { CookieJar, ORIGIN, callRoute, patchNextRequestIo, servedRequests } from './route-harness';
import { signBrowserSessionCookie } from '@boardsesh/auth-protocol/browser-session-cookie';
import { captureIdentityAuthority } from '../../backend/src/auth/authority/router';
import { issueWebSession } from '../../backend/src/auth/authority/web-session';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../backend/src/auth/current-store/foundation-context';
import {
  COOKIE_SECRET,
  DOMAIN,
  LEGACY,
  LOGIN,
  PROJECTION_ID,
  browserSteps,
  createClimber,
  randomClientAddress,
  sessionCookieNamesIn,
  startWebSessionBackend,
  stubBetterAuthEnvironment,
  type WebSessionBackend,
} from './web-session-harness';

const holder = vi.hoisted(() => {
  // auth-options reads both when it loads: production www, shared Domain cookie.
  process.env.NEXTAUTH_SECRET = 'native-callback-proof-nextauth-secret-7596-b4c';
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
import * as nativeCallbackRoute from '../app/api/auth/native/callback/route';
import { BRIDGES_PER_CLIENT } from '../app/lib/auth/browser-session-bridge.server';
import {
  NATIVE_OAUTH_ATTEMPT_COOKIE,
  issueNativeOAuthAttempt,
  issueNativeOAuthTransferToken,
} from '../app/lib/auth/native-oauth-transfer';

const secret = 'native-callback-proof-nextauth-secret-7596-b4c';
const ACCESS_SECRET = 'native-callback-proof-access-secret-7596-b4c-web';
const { csrf, login, readSession } = browserSteps(authRoute);
let environment: Awaited<ReturnType<typeof createEnvironment>>;
let backend: WebSessionBackend;

beforeAll(async () => {
  environment = await createEnvironment();
  holder.database = environment.database;
  backend = await startWebSessionBackend(environment.database);
  patchNextRequestIo();
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

/** The app's browser lands on the callback carrying `cookie`, as Next serves it. */
async function nativeCallback(cookie: string, query = 'next=%2Fafter', clientAddress = randomClientAddress()) {
  const request = new NextRequest(new URL(`/api/auth/native/callback?${query}`, ORIGIN), {
    headers: { cookie, 'x-forwarded-for': clientAddress },
  });
  return servedRequests.run(request, () => nativeCallbackRoute.GET(request));
}

/** The deep link the page sends the app to, and the transfer token's signed claims. */
async function deepLink(response: Response) {
  const body = await response.text();
  const target = /window\.location\.href=("[^"]*")/.exec(body)?.[1];
  if (!target) throw new Error('No deep link');
  const url = new URL(JSON.parse(target) as string);
  const transferToken = url.searchParams.get('transferToken');
  const claims = transferToken
    ? (JSON.parse(Buffer.from(transferToken.split('.')[0], 'base64url').toString('utf8')) as Record<string, unknown>)
    : null;
  return { url, error: url.searchParams.get('error'), claims };
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

const NORMALIZED = (claims: Record<string, unknown> | null) =>
  JSON.parse(
    JSON.stringify(claims, (key, field: unknown) =>
      ['userId', 'authSessionId'].includes(key)
        ? '<id>'
        : ['iat', 'exp', 'auth_time'].includes(key)
          ? '<seconds>'
          : field,
    ),
  ) as unknown;

/** What the app's browser gets from the callback after a password login, as comparable data. */
async function unsetModeAnswer() {
  const climber = await createClimber(environment.database);
  const jar = new CookieJar();
  await login(jar, climber.email);
  const response = await nativeCallback(jar.header());
  const { url, claims } = await deepLink(response.clone());
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    cacheControl: response.headers.get('cache-control'),
    setCookie: response.headers.getSetCookie(),
    deepLink: `${url.protocol}//${url.host}${url.pathname}?next=${url.searchParams.get('next')}`,
    claims: NORMALIZED(claims),
    userIsTheClimber: claims?.userId === climber.id,
  };
}

describe('the native callback with the mode unset (live today)', () => {
  it('answers and mints exactly as on main', async () => {
    expect(await unsetModeAnswer()).toMatchInlineSnapshot(`
      {
        "cacheControl": "no-store",
        "claims": {
          "authSessionId": "<id>",
          "exp": "<seconds>",
          "gen": 0,
          "iat": "<seconds>",
          "nextPath": "/after",
          "userId": "<id>",
        },
        "contentType": "text/html; charset=utf-8",
        "deepLink": "com.boardsesh.app://auth/callback?next=/after",
        "setCookie": [],
        "status": 200,
        "userIsTheClimber": true,
      }
    `);
    expect((await deepLink(await nativeCallback(''))).error).toBe('session_missing');
  });

  it.each(['', 'legacy'])('answers with the mode %j exactly as unset', async (mode) => {
    const unset = await unsetModeAnswer();
    vi.stubEnv('AUTH_BROWSER_SESSION_MODE', mode);
    expect(await unsetModeAnswer()).toEqual(unset);
  });

  it("mints from the legacy cookie's proof claims with staged sign-in and proofs required, as on main", async () => {
    stubBetterAuthEnvironment(backend.origin);
    vi.stubEnv('AUTH_BROWSER_SESSION_MODE', undefined);
    expect(await unsetModeAnswer()).toMatchInlineSnapshot(`
      {
        "cacheControl": "no-store",
        "claims": {
          "authSessionId": "<id>",
          "auth_time": "<seconds>",
          "exp": "<seconds>",
          "gen": 0,
          "iat": "<seconds>",
          "link_guarded": true,
          "nextPath": "/after",
          "userId": "<id>",
        },
        "contentType": "text/html; charset=utf-8",
        "deepLink": "com.boardsesh.app://auth/callback?next=/after",
        "setCookie": [],
        "status": 200,
        "userIsTheClimber": true,
      }
    `);
  });
});

describe('the native callback under better-auth', () => {
  beforeEach(betterAuth);

  it("mints the app's transfer token from the canonical session after a password login", async () => {
    const climber = await createClimber(environment.database);
    const jar = new CookieJar();
    await login(jar, climber.email);
    const session = (await (await readSession(jar.header())).json()) as { authSessionId: string };
    const response = await nativeCallback(jar.header());
    expect(sessionCookieNamesIn(response)).toEqual([]);
    const { claims, error } = await deepLink(response);
    expect(error).toBeNull();
    // The proof is folded into the signed payload: its session id, generation, sign-in time and link guard.
    expect(claims).toMatchObject({
      userId: climber.id,
      authSessionId: session.authSessionId,
      gen: 0,
      auth_time: expect.any(Number),
      link_guarded: true,
    });
  });

  it('refuses when the legacy cookie names another login than the live first-party session', async () => {
    const climber = await createClimber(environment.database);
    const jar = new CookieJar();
    await login(jar, climber.email);
    // An older login of another account: the login cookie outranks it, so the two disagree.
    const other = await legacyLogin({ auth_time: Math.floor(Date.now() / 1000) - 7200 });
    const response = await nativeCallback(`${LOGIN}=${jar.get(LOGIN, DOMAIN)}; ${LEGACY}=${other.credential}`);
    const { error, claims } = await deepLink(response);
    expect(claims).toBeNull();
    expect(error).toBe('token_issue_failed');
  });

  it('bridges a browser signed in before the switch and mints from that session, with no sign-in time, writing no cookie', async () => {
    // A guarded legacy sign-in: the bridged row keeps its time, but a bridge is never a real login.
    const { climber, authSessionId, credential } = await legacyLogin({ link_guarded: true });
    const response = await nativeCallback(`${LEGACY}=${credential}`);
    expect(sessionCookieNamesIn(response)).toEqual([]);
    const { claims } = await deepLink(response);
    expect(claims).toMatchObject({ userId: climber.id, authSessionId, gen: 0 });
    expect(claims).not.toHaveProperty('auth_time');
    expect(claims).not.toHaveProperty('link_guarded');
  });

  it('mints a carried session (a silent Google or an Apple sign-in) with no sign-in time and no link guard', async () => {
    const climber = await createClimber(environment.database);
    const authority = await environment.database.transaction((transaction) =>
      captureIdentityAuthority(transaction, {
        expectedProjectionId: PROJECTION_ID,
        expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
      }),
    );
    const issued = await environment.database.transaction((transaction) =>
      issueWebSession(transaction, {
        userId: climber.id,
        authority,
        now: new Date(),
        authenticatedAt: new Date(),
        freshness: 'carried',
      }),
    );
    const response = await nativeCallback(`${LOGIN}=${signBrowserSessionCookie('login', issued.token, COOKIE_SECRET)}`);
    const { claims } = await deepLink(response);
    expect(claims).toMatchObject({ userId: climber.id, authSessionId: issued.sessionId });
    expect(claims).not.toHaveProperty('auth_time');
    expect(claims).not.toHaveProperty('link_guarded');
  });

  it('answers session_unavailable when the session is known only by its legacy cookie (bridge over budget)', async () => {
    const { credential } = await legacyLogin();
    const clientAddress = randomClientAddress();
    let last = await nativeCallback(`${LEGACY}=${credential}`, 'next=%2Fafter', clientAddress);
    for (let count = 0; count < BRIDGES_PER_CLIENT && (await deepLink(last.clone())).error === null; count += 1)
      last = await nativeCallback(`${LEGACY}=${credential}`, 'next=%2Fafter', clientAddress);
    expect((await deepLink(last)).error).toBe('session_unavailable');
  });

  it.each([
    ['does not decode', async () => 'not-a-legacy-cookie'],
    [
      'names the same account but another session',
      async (userId: string) =>
        (await legacyLogin({ sub: userId, auth_time: Math.floor(Date.now() / 1000) - 7200 })).credential,
    ],
  ])('refuses when the legacy cookie beside the session %s', async (_case, legacyFor) => {
    const climber = await createClimber(environment.database);
    const jar = new CookieJar();
    await login(jar, climber.email);
    const legacy = await legacyFor(climber.id);
    const response = await nativeCallback(`${LOGIN}=${jar.get(LOGIN, DOMAIN)}; ${LEGACY}=${legacy}`);
    const { error, claims } = await deepLink(response);
    expect(claims).toBeNull();
    expect(error).toBe('token_issue_failed');
  });

  it('answers session_missing when nobody is signed in', async () => {
    expect((await deepLink(await nativeCallback(''))).error).toBe('session_missing');
  });

  it("carries the account-creation receipt from the legacy twin of that same login, bound to the app's attempt", async () => {
    const climber = await createClimber(environment.database);
    const jar = new CookieJar();
    await login(jar, climber.email);
    const twin = await decode({ token: jar.get(LEGACY, DOMAIN) ?? '', secret });
    if (!twin?.authSessionId) throw new Error('No legacy twin');
    const attemptId = randomBytes(16).toString('hex');
    const attempt = issueNativeOAuthAttempt({ attemptId, provider: 'google' });
    // The sign-in completes after the app's attempt started, as in a real flow.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const [created] = await environment.database.select({ createdAt: users.createdAt }).from(users).limit(1);
    const accountCreation = {
      userId: climber.id,
      accountCreated: true,
      provider: 'google' as const,
      createdAt: (created?.createdAt ?? new Date()).toISOString(),
    };
    const twinWithReceipt = await encode({
      token: {
        ...twin,
        nativeOAuthCreationProof: {
          authSessionId: twin.authSessionId,
          provider: 'google',
          signedInAt: Date.now(),
          accountCreation,
        },
      },
      secret,
      maxAge: 3600,
    });
    const response = await nativeCallback(
      `${LOGIN}=${jar.get(LOGIN, DOMAIN)}; ${LEGACY}=${twinWithReceipt}; ${NATIVE_OAUTH_ATTEMPT_COOKIE}=${attempt}`,
      `next=%2Fafter&attemptId=${attemptId}&provider=google`,
    );
    const { claims } = await deepLink(response);
    expect(claims).toMatchObject({ userId: climber.id, accountCreation, attemptId, provider: 'google' });
  });
});

describe('the native-oauth credentials provider under better-auth', () => {
  beforeEach(betterAuth);

  it('is refused: the existing failure, no session cookie, whatever the transfer token', async () => {
    const climber = await createClimber(environment.database);
    const transferToken = issueNativeOAuthTransferToken({
      userId: climber.id,
      nextPath: '/',
      credentialProof: {
        version: 1,
        userId: climber.id,
        authSessionId: randomUUID(),
        generation: 0,
        authenticatedAt: null,
        linkGuarded: false,
      },
    });
    const jar = new CookieJar();
    const csrfToken = await csrf(jar);
    const response = await callRoute(authRoute, '/api/auth/callback/native-oauth', {
      cookie: jar.header(),
      form: { csrfToken, transferToken, json: 'true', callbackUrl: 'https://www.boardsesh.com/' },
    });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { url: string }).url).toContain('error=CredentialsSignin');
    expect(sessionCookieNamesIn(response)).toEqual([]);
  });
});
