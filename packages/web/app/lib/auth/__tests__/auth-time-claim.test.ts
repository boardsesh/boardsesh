// @vitest-environment node
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { hashSync } from 'bcryptjs';
import { NextRequest } from 'next/server';
import { decode, encode, type JWT } from 'next-auth/jwt';
import type { WebOAuthResolveReply } from '@boardsesh/auth-protocol';

const { baseUrl, sessionSecret } = vi.hoisted(() => {
  const fixtureUrl = 'http://localhost:3000';
  const fixtureSecret = 'auth-time-claim-fixture-secret';
  // auth-options reads both while it is imported, before any test body runs.
  process.env.NEXTAUTH_URL = fixtureUrl;
  process.env.NEXTAUTH_SECRET = fixtureSecret;
  return { baseUrl: fixtureUrl, sessionSecret: fixtureSecret };
});
const databaseRows = vi.hoisted(() => new Map<unknown, unknown[]>());

vi.mock('server-only', () => ({}));
vi.mock('@auth/drizzle-adapter', () => ({ DrizzleAdapter: vi.fn(() => ({})) }));
vi.mock('@/app/lib/db/db', () => ({
  getDb: () => ({
    select: () => ({
      from: (table: unknown) => ({ where: () => ({ limit: async () => databaseRows.get(table) ?? [] }) }),
    }),
  }),
}));
// Admission is a backend round trip with its own coverage; it reads only `sub`.
vi.mock('@/app/lib/auth/auth-response-admission.server', () => ({
  withAuthResponseAdmission: (_request: unknown, _context: unknown, invoke: () => Promise<Response>) => invoke(),
}));

import * as schema from '@/app/lib/db/schema';
import { GET, POST } from '@/app/api/auth/[...nextauth]/route';
import { authOptions } from '../auth-options';
import { issueNativeOAuthTransferToken } from '../native-oauth-transfer';
import { createWebOAuthIdentityAuthRequest } from '../web-oauth-auth.server';

// Only the database, the backend admission call and Next's ambient request I/O are
// replaced. The App Router handler, CSRF check, password compare, callbacks and
// JWE encoder all run.
const requestStorage = new AsyncLocalStorage<NextRequest>();
const require = createRequire(import.meta.url);
const nextIo = require('next/headers') as {
  headers: () => Promise<Headers>;
  cookies: () => Promise<{ getAll: () => { name: string; value: string }[] }>;
};

const SESSION_COOKIE = 'next-auth.session-token';
// Half a second past the minute, so a claim that is not whole seconds cannot pass.
const SIGN_IN_AT_MS = Date.UTC(2026, 10, 9, 12, 0, 0, 500);
const SIGN_IN_AT_SECONDS = Math.floor(SIGN_IN_AT_MS / 1000);
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const PASSWORD = 'correct horse battery staple';
const climber = {
  id: '602c83bf-e090-4c90-9f7e-08ca0b6b5dad',
  email: 'climber@example.com',
  name: 'Climber',
  image: null,
  emailVerified: new Date('2026-01-01T00:00:00.000Z'),
};

let cookies: Map<string, string>;
let csrfToken: string;

function remember(response: Response) {
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(';');
    const separator = pair.indexOf('=');
    cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}

async function invoke(path: string, form?: Record<string, string>) {
  const request = new NextRequest(`${baseUrl}/api/auth/${path}`, {
    method: form ? 'POST' : 'GET',
    headers: {
      Cookie: [...cookies].map(([name, cookie]) => `${name}=${cookie}`).join('; '),
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(form ? { body: new URLSearchParams(form) } : {}),
  });
  const context = { params: Promise.resolve({ nextauth: path.split('/') }) };
  return requestStorage.run(request, () => (form ? POST(request, context) : GET(request, context)));
}

function signInWithPassword() {
  return invoke('callback/credentials', {
    email: climber.email,
    password: PASSWORD,
    csrfToken,
    json: 'true',
    callbackUrl: baseUrl,
  });
}

function currentSessionClaims() {
  return decode({ token: cookies.get(SESSION_COOKIE), secret: sessionSecret });
}

type JwtParameters = Parameters<NonNullable<NonNullable<typeof authOptions.callbacks>['jwt']>>[0];

function runJwtCallback(parameters: Partial<JwtParameters>) {
  const callback = authOptions.callbacks?.jwt;
  if (!callback) throw new Error('jwt callback not defined');
  return callback(parameters as JwtParameters);
}

function accountFor(provider: string): JwtParameters['account'] {
  return { provider, type: 'oauth', providerAccountId: 'provider-account' };
}

beforeAll(() => {
  vi.spyOn(nextIo, 'headers').mockImplementation(async () => requestStorage.getStore()?.headers ?? new Headers());
  vi.spyOn(nextIo, 'cookies').mockImplementation(async () => ({
    getAll: () => requestStorage.getStore()?.cookies.getAll() ?? [],
  }));
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: SIGN_IN_AT_MS });
  databaseRows.clear();
  databaseRows.set(schema.users, [climber]);
  databaseRows.set(schema.userCredentials, [{ passwordHash: hashSync(PASSWORD, 4) }]);
  cookies = new Map();
  const response = await invoke('csrf');
  remember(response);
  csrfToken = ((await response.json()) as { csrfToken: string }).csrfToken;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterAll(() => vi.restoreAllMocks());

describe('auth_time through the real NextAuth handler', () => {
  it('records the sign-in second on a password sign-in', async () => {
    const response = await signInWithPassword();
    expect(response.status).toBe(200);
    remember(response);

    const claims = await currentSessionClaims();
    expect(claims?.sub).toBe(climber.id);
    expect(claims?.auth_time).toBe(SIGN_IN_AT_SECONDS);
  });

  it('keeps the original sign-in time when the cookie later rotates', async () => {
    remember(await signInWithPassword());
    vi.setSystemTime(SIGN_IN_AT_MS + ONE_DAY_MS);

    const response = await invoke('session');
    expect(response.status).toBe(200);
    remember(response);

    const claims = await currentSessionClaims();
    expect(claims?.iat).toBe(SIGN_IN_AT_SECONDS + ONE_DAY_MS / 1000);
    expect(claims?.auth_time).toBe(SIGN_IN_AT_SECONDS);
  });

  it('leaves a cookie from before the claim valid and still without it', async () => {
    cookies.set(
      SESSION_COOKIE,
      await encode({
        token: { sub: climber.id, email: climber.email, authSessionId: 'old-login' },
        secret: sessionSecret,
      }),
    );

    const response = await invoke('session');
    expect(await response.clone().json()).toMatchObject({ user: { id: climber.id }, authSessionId: 'old-login' });
    remember(response);

    const claims = await currentSessionClaims();
    expect(claims?.sub).toBe(climber.id);
    expect(claims?.authSessionId).toBe('old-login');
    expect(claims).not.toHaveProperty('auth_time');
  });

  it('never records a native transfer sign-in', async () => {
    const response = await invoke('callback/native-oauth', {
      transferToken: issueNativeOAuthTransferToken({ userId: climber.id, nextPath: '/' }),
      csrfToken,
      json: 'true',
      callbackUrl: baseUrl,
    });
    expect(response.status).toBe(200);
    remember(response);

    const claims = await currentSessionClaims();
    expect(claims?.sub).toBe(climber.id);
    expect(claims).not.toHaveProperty('auth_time');
  });

  it('stays out of the session JSON the browser reads', async () => {
    remember(await signInWithPassword());

    const response = await invoke('session');
    expect(await response.text()).not.toContain('auth_time');
  });

  it('adds one small fixed-size claim to the cookie and nothing on rotation', async () => {
    remember(await signInWithPassword());
    const signedInCookie = cookies.get(SESSION_COOKIE) ?? '';
    const { auth_time: _authTime, ...claimsWithoutAuthTime } = (await currentSessionClaims()) as JWT;
    const cookieWithoutAuthTime = await encode({ token: claimsWithoutAuthTime, secret: sessionSecret });

    expect(_authTime).toBe(SIGN_IN_AT_SECONDS);
    expect(signedInCookie.length - cookieWithoutAuthTime.length).toBeGreaterThan(0);
    expect(signedInCookie.length - cookieWithoutAuthTime.length).toBeLessThanOrEqual(32);

    remember(await invoke('session'));
    expect(cookies.get(SESSION_COOKIE)?.length).toBe(signedInCookie.length);
  });
});

describe('auth_time on the backend-staged sign-in paths', () => {
  it('records a password sign-in delegated to the backend', async () => {
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'backend-staging');
    vi.stubEnv('CURRENT_STORE_AUTH_BACKEND_ORIGIN', 'http://127.0.0.1:54321');
    vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', 'dedicated-rpc-test-server-secret-at-least-32');
    const backend = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('Expected a serialized command');
      const { requestId } = JSON.parse(init.body) as { requestId: string };
      return Response.json({
        protocolVersion: 2,
        operation: 'password',
        requestId,
        outcome: 'authenticated',
        user: { id: climber.id, email: climber.email, name: climber.name, image: climber.image },
        verification: { userId: climber.id, required: true, verified: true },
      });
    });
    vi.stubGlobal('fetch', backend);

    const response = await signInWithPassword();
    expect(response.status).toBe(200);
    remember(response);

    expect(backend).toHaveBeenCalledOnce();
    expect((await currentSessionClaims())?.auth_time).toBe(SIGN_IN_AT_SECONDS);
  });

  // Runs the wrapper's own callbacks and encoder. Going through a provider redirect
  // here would need a local OIDC server and a provider registered at import time.
  it('records an OAuth sign-in resolved by the backend identity wrapper', async () => {
    const issuedAt = '2026-01-01T00:00:00.000Z';
    const account = { provider: 'google', type: 'oauth' as const, providerAccountId: 'google-subject' };
    const user = { id: climber.id, email: climber.email, name: climber.name };
    const resolved: WebOAuthResolveReply = {
      webOAuthProtocolVersion: 1,
      requestId: '8f14e45f-ceea-4e67-8b3a-2f1d0a9b7701',
      operation: 'resolve',
      outcome: 'resolved',
      user: { ...user, image: climber.image, emailVerified: issuedAt, createdAt: issuedAt },
      createdUser: false,
      account: { provider: 'google', providerAccountId: account.providerAccountId },
    };
    const { options } = createWebOAuthIdentityAuthRequest(
      authOptions,
      { provider: 'google', flow: 'a'.repeat(64), actorCookie: null },
      () => ({ intent: vi.fn(), resolve: vi.fn(async () => resolved) }),
    );
    const { callbacks, jwt } = options;
    if (!callbacks?.signIn || !callbacks.jwt || !jwt?.encode) throw new Error('wrapper is missing a callback');

    expect(await callbacks.signIn({ user, account })).toBe(true);
    const token = await callbacks.jwt({ token: { sub: climber.id }, user, account });
    const encoded = await jwt.encode({ token, secret: sessionSecret });

    expect((await decode({ token: encoded, secret: sessionSecret }))?.auth_time).toBe(SIGN_IN_AT_SECONDS);
  });
});

describe('auth_time in the jwt callback', () => {
  it.each(['google', 'apple', 'facebook', 'credentials'])('records a %s sign-in in whole seconds', async (provider) => {
    const claims = await runJwtCallback({
      token: { sub: climber.id },
      user: { id: climber.id },
      account: accountFor(provider),
    });

    expect(claims.auth_time).toBe(SIGN_IN_AT_SECONDS);
  });

  it('drops any earlier value when a native transfer signs in', async () => {
    const claims = await runJwtCallback({
      token: { sub: climber.id, auth_time: SIGN_IN_AT_SECONDS - 60 },
      user: { id: climber.id },
      account: accountFor('native-oauth'),
    });

    expect(claims).not.toHaveProperty('auth_time');
  });

  it('claims nothing when a user arrives without a sign-in method', async () => {
    const claims = await runJwtCallback({ token: { sub: climber.id }, user: { id: climber.id } });

    expect(claims).not.toHaveProperty('auth_time');
  });

  it.each([undefined, 'update'] as const)('never takes it from the client on a %s token read', async (trigger) => {
    const claims = await runJwtCallback({
      token: { sub: climber.id, authSessionId: 'old-login' },
      session: { auth_time: 1 },
      trigger,
    });

    expect(claims).not.toHaveProperty('auth_time');
  });

  it.each([undefined, 'update'] as const)('never moves an existing value on a %s token read', async (trigger) => {
    const earlierSignIn = SIGN_IN_AT_SECONDS - ONE_DAY_MS / 1000;
    const claims = await runJwtCallback({
      token: { sub: climber.id, authSessionId: 'login-1', auth_time: earlierSignIn },
      session: { auth_time: 1 },
      trigger,
    });

    expect(claims.auth_time).toBe(earlierSignIn);
  });
});

describe('link_guarded beside auth_time', () => {
  it('is written by a password sign-in only while partner OAuth is on', async () => {
    remember(await signInWithPassword());
    expect(await currentSessionClaims()).not.toHaveProperty('link_guarded');

    vi.stubEnv('PARTNER_OAUTH_MODE', 'allowlist');
    remember(await signInWithPassword());
    const claims = await currentSessionClaims();
    expect(claims?.auth_time).toBe(SIGN_IN_AT_SECONDS);
    expect(claims?.link_guarded).toBe(true);
  });

  it('survives a cookie rotation, and a rotation never adds it', async () => {
    vi.stubEnv('PARTNER_OAUTH_MODE', 'allowlist');
    remember(await signInWithPassword());
    vi.setSystemTime(SIGN_IN_AT_MS + ONE_DAY_MS);
    remember(await invoke('session'));
    expect((await currentSessionClaims())?.link_guarded).toBe(true);

    // A sign-in made while the mode was off stays unguarded after it turns on.
    vi.stubEnv('PARTNER_OAUTH_MODE', 'off');
    remember(await signInWithPassword());
    vi.stubEnv('PARTNER_OAUTH_MODE', 'allowlist');
    remember(await invoke('session'));
    const claims = await currentSessionClaims();
    expect(claims?.auth_time).toBeDefined();
    expect(claims).not.toHaveProperty('link_guarded');
  });

  it('is never written for a native transfer, which has no auth_time', async () => {
    vi.stubEnv('PARTNER_OAUTH_MODE', 'allowlist');
    const claims = await runJwtCallback({
      token: { sub: climber.id, auth_time: SIGN_IN_AT_SECONDS - 60, link_guarded: true },
      user: { id: climber.id },
      account: accountFor('native-oauth'),
    });

    expect(claims).not.toHaveProperty('auth_time');
    expect(claims).not.toHaveProperty('link_guarded');
  });

  it('is never taken from the client on an update', async () => {
    vi.stubEnv('PARTNER_OAUTH_MODE', 'allowlist');
    const claims = await runJwtCallback({
      token: { sub: climber.id, authSessionId: 'old-login', auth_time: SIGN_IN_AT_SECONDS },
      session: { link_guarded: true },
      trigger: 'update',
    });

    expect(claims).not.toHaveProperty('link_guarded');
  });
});
