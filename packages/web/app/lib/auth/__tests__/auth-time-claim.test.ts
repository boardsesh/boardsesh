// @vitest-environment node
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { hashSync } from 'bcryptjs';
import { NextRequest } from 'next/server';
import { decode, encode, type JWT } from 'next-auth/jwt';

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
const SIGN_IN_AT_MS = Date.UTC(2026, 10, 9, 12, 0, 0);
const SIGN_IN_AT_SECONDS = SIGN_IN_AT_MS / 1000;
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

  it.each([undefined, 'update'] as const)('never adds it on a %s token read', async (trigger) => {
    const claims = await runJwtCallback({ token: { sub: climber.id, authSessionId: 'old-login' }, trigger });

    expect(claims).not.toHaveProperty('auth_time');
  });

  it.each([undefined, 'update'] as const)('never moves an existing value on a %s token read', async (trigger) => {
    const earlierSignIn = SIGN_IN_AT_SECONDS - ONE_DAY_MS / 1000;
    const claims = await runJwtCallback({
      token: { sub: climber.id, authSessionId: 'login-1', auth_time: earlierSignIn },
      trigger,
    });

    expect(claims.auth_time).toBe(earlierSignIn);
  });
});
