// @vitest-environment node
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { decode, type JWT } from 'next-auth/jwt';
import type { Session } from 'next-auth';

// A browser that was handed a `__Host-boardsesh.browser-binding` cookie while
// the binding design was staged keeps it for up to 30 days. No www code reads
// that cookie or CURRENT_STORE_BROWSER_BINDING_MODE any more (#7596), so the
// climber keeps signing in through the legacy NextAuth cookie (#7594).

const secret = 'stale-browser-binding-fixture-secret';
const origin = 'http://localhost:3000';
const io = vi.hoisted(() => ({
  request: undefined as NextRequest | undefined,
  authorizeCalls: 0,
}));

vi.mock('server-only', () => ({}));
// admitted-session.server.ts reads the render's cookies through its own import.
vi.mock('next/headers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/headers')>()),
  cookies: async () => ({ getAll: () => io.request?.cookies.getAll() ?? [] }),
  headers: async () => io.request?.headers ?? new Headers(),
}));
vi.mock('@/app/lib/auth/auth-options', async () => {
  const { default: CredentialsProvider } = await import('next-auth/providers/credentials');
  return {
    authOptions: {
      secret: 'stale-browser-binding-fixture-secret',
      session: { strategy: 'jwt' },
      providers: [
        CredentialsProvider({
          credentials: { email: {}, password: {} },
          authorize: async () => {
            io.authorizeCalls += 1;
            return { id: 'climber-a', email: 'climber-a@example.invalid' };
          },
        }),
      ],
      callbacks: {
        jwt: async ({ token, user }: { token: JWT; user?: { id: string } }) => {
          if (user) token.authSessionId = `login-${user.id}`;
          return token;
        },
        session: async ({ session, token }: { session: Session; token: JWT }) => ({
          ...session,
          user: { ...session.user, id: token.sub },
          authSessionId: token.authSessionId,
        }),
      },
      logger: { error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    },
  };
});

import { GET as authGet, POST as authPost } from '@/app/api/auth/[...nextauth]/route';
import { GET as wsAuthGet } from '@/app/api/internal/ws-auth/route';
import { getAdmittedRawServerToken, getAdmittedServerSession } from '../admitted-session.server';

// NextAuth's own handler and getServerSession load next/headers with require().
const nextIo = createRequire(import.meta.url)('next/headers') as {
  headers: () => Promise<Headers>;
  cookies: () => Promise<{ getAll: () => { name: string; value: string }[] }>;
};

// The correlation cookie, a numbered variant of it and a proof cookie, as the staged design named them.
const STALE_BINDING_COOKIES = [
  ['__Host-boardsesh.browser-binding', 'A'.repeat(43)],
  ['__Host-boardsesh.browser-binding.0', 'held-pointer'],
  [`__Host-boardsesh.browser-proof.${'b'.repeat(64)}.3`, 'stale-proof'],
] as const;
const SESSION_COOKIE = 'next-auth.session-token';

/** The backend's admission read, over real HTTP: a JWE signed with the fixture secret is admitted. */
let backend: Server;
let admissionReads = 0;
let cookieJar: Map<string, string>;
let csrfToken: string;

beforeAll(async () => {
  vi.spyOn(nextIo, 'headers').mockImplementation(async () => io.request?.headers ?? new Headers());
  vi.spyOn(nextIo, 'cookies').mockImplementation(async () => ({ getAll: () => io.request?.cookies.getAll() ?? [] }));
  backend = createServer((incoming, outgoing) => {
    incoming.resume();
    incoming.on('end', async () => {
      admissionReads += 1;
      const bearer = (incoming.headers.authorization ?? '').replace(/^Bearer /, '');
      const token = await decode({ token: bearer, secret }).catch(() => null);
      outgoing.setHeader('Content-Type', 'application/json');
      if (!token?.sub) {
        outgoing.statusCode = 401;
        outgoing.end(JSON.stringify({ data: null, errors: [{ extensions: { code: 'UNAUTHENTICATED' } }] }));
        return;
      }
      outgoing.end(JSON.stringify({ data: { authenticatedUserId: token.sub } }));
    });
  });
  await new Promise<void>((listening) => backend.listen(0, '127.0.0.1', listening));
});
afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise((closed) => backend.close(closed));
});

function remember(response: Response): void {
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(';')[0];
    const separator = pair.indexOf('=');
    const content = pair.slice(separator + 1);
    if (content) cookieJar.set(pair.slice(0, separator), content);
    else cookieJar.delete(pair.slice(0, separator));
  }
}
function cookieHeader(): string {
  return [...cookieJar].map(([name, content]) => `${name}=${content}`).join('; ');
}
async function run<Result>(request: NextRequest, call: () => Promise<Result>): Promise<Result> {
  io.request = request;
  try {
    return await call();
  } finally {
    io.request = undefined;
  }
}
function invokeAuth(path: string, form?: Record<string, string>): Promise<Response> {
  const request = new NextRequest(`${origin}/api/auth/${path}`, {
    method: form ? 'POST' : 'GET',
    headers: {
      cookie: cookieHeader(),
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(form ? { body: new URLSearchParams(form) } : {}),
  });
  const context = { params: Promise.resolve({ nextauth: path.split('/') }) };
  return run(request, () => (form ? authPost(request, context) : authGet(request, context)));
}
/** A real sign-in: fetch the CSRF token with whatever cookies the browser holds, then post the credentials. */
async function credentialsLogin(): Promise<Response> {
  const csrf = await invokeAuth('csrf');
  expect(csrf.status).toBe(200);
  remember(csrf);
  csrfToken = ((await csrf.json()) as { csrfToken: string }).csrfToken;
  return invokeAuth('callback/credentials', {
    email: 'climber-a@example.invalid',
    password: 'fixture-only',
    csrfToken,
    json: 'true',
    callbackUrl: origin,
  });
}

beforeEach(() => {
  vi.stubEnv('NEXTAUTH_SECRET', secret);
  vi.stubEnv('NEXTAUTH_URL', origin);
  vi.stubEnv('AUTH_TRUST_HOST', '1');
  vi.stubEnv('VERCEL_ENV', '');
  vi.stubEnv('AUTH_COOKIE_DOMAIN', '');
  vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
  vi.stubEnv('CURRENT_STORE_WEB_OAUTH_MODE', 'legacy');
  vi.stubEnv('BACKEND_INTERNAL_URL', `ws://127.0.0.1:${(backend.address() as AddressInfo).port}/graphql`);
  io.authorizeCalls = 0;
  admissionReads = 0;
  cookieJar = new Map();
});
afterEach(() => vi.unstubAllEnvs());

describe.each([
  ['unset', undefined],
  ['an invalid value', 'not-a-binding-mode'],
  ['backend-staging', 'backend-staging'],
])('stale browser-binding cookies with CURRENT_STORE_BROWSER_BINDING_MODE %s', (_label, mode) => {
  beforeEach(() => {
    vi.stubEnv('CURRENT_STORE_BROWSER_BINDING_MODE', mode);
    for (const [name, content] of STALE_BINDING_COOKIES) cookieJar.set(name, content);
  });

  it('signs in through the credentials callback', async () => {
    const response = await credentialsLogin();
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Boardsesh-Credential-Authority')).toBeNull();
    expect(io.authorizeCalls).toBe(1);
    remember(response);
    expect((await decode({ token: cookieJar.get(SESSION_COOKIE), secret }))?.sub).toBe('climber-a');
  });

  it('reads the legacy session', async () => {
    remember(await credentialsLogin());
    admissionReads = 0;
    const response = await invokeAuth('session');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user: { id: 'climber-a' }, authSessionId: 'login-climber-a' });
    expect(admissionReads).toBeGreaterThan(0);
  });

  it('hands ws-auth the legacy token with the identity fields the client guard reads', async () => {
    remember(await credentialsLogin());
    const request = new NextRequest(`${origin}/api/internal/ws-auth`, { headers: { cookie: cookieHeader() } });
    const response = await wsAuthGet(request);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.json()).toEqual({
      token: cookieJar.get(SESSION_COOKIE),
      authenticated: true,
      userId: 'climber-a',
      authSessionId: 'login-climber-a',
    });
  });

  it('renders private server pages for the legacy viewer', async () => {
    remember(await credentialsLogin());
    const request = new NextRequest(`${origin}/profile/climber-a`, { headers: { cookie: cookieHeader() } });
    await expect(run(request, getAdmittedRawServerToken)).resolves.toBe(cookieJar.get(SESSION_COOKIE));
    await expect(run(request, getAdmittedServerSession)).resolves.toMatchObject({ user: { id: 'climber-a' } });
  });

  it('signs out through the guarded sign-out', async () => {
    remember(await credentialsLogin());
    const response = await invokeAuth('signout', {
      csrfToken,
      json: 'true',
      expectedUserId: 'climber-a',
      expectedAuthSessionId: 'login-climber-a',
    });
    expect(response.status).toBe(200);
    remember(response);
    expect(cookieJar.has(SESSION_COOKIE)).toBe(false);
  });
});
