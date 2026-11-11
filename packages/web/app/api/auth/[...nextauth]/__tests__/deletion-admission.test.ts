// @vitest-environment node
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { decode, type JWT } from 'next-auth/jwt';
import type { Session } from 'next-auth';
vi.mock('server-only', () => ({}));

const controls = vi.hoisted(() => ({
  userId: 'owner-a',
  deleted: new Set<string>(),
  unavailable: false,
  deleteDuringJwt: false,
  deleteDuringSignOut: false,
  presented: [] as string[],
  // auth_subject_cutoffs.generation per climber, and what a sign-in stamps (a
  // failed read in auth-options stamps 0).
  generations: new Map<string, number>(),
  signInStamp: 0,
}));
const secret = 'owned-mounted-deletion-fixture-secret';
vi.mock('@/app/lib/auth/auth-options', async () => {
  const { default: CredentialsProvider } = await import('next-auth/providers/credentials');
  return {
    authOptions: {
      secret: 'owned-mounted-deletion-fixture-secret',
      session: { strategy: 'jwt' },
      providers: [
        CredentialsProvider({
          credentials: { email: {}, password: {} },
          authorize: async () => ({ id: controls.userId, email: `${controls.userId}@example.invalid` }),
        }),
      ],
      callbacks: {
        jwt: async ({ token, user }: { token: JWT; user?: { id: string } }) => {
          if (user) {
            token.authSessionId = `login-${user.id}`;
            token.gen = controls.signInStamp;
          }
          if (controls.deleteDuringJwt && token.sub) controls.deleted.add(token.sub);
          return token;
        },
        session: async ({ session, token }: { session: Session; token: JWT }) => ({
          ...session,
          user: { ...session.user, id: token.sub },
          authSessionId: token.authSessionId,
        }),
      },
      events: {
        signOut: async () => {
          if (controls.deleteDuringSignOut) controls.deleted.add('owner-a');
        },
      },
      logger: { error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    },
  };
});
vi.mock('@/app/lib/auth/credential-admission.server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/lib/auth/credential-admission.server')>();
  const { decode: publicDecode } = await import('next-auth/jwt');
  return {
    ...actual,
    admitPresentedWebCredential: async (credential: string) => {
      controls.presented.push(credential);
      if (controls.unavailable) throw new actual.CredentialAuthorityUnavailable();
      const token = await publicDecode({ token: credential, secret: 'owned-mounted-deletion-fixture-secret' });
      if (!token?.sub || controls.deleted.has(token.sub)) return null;
      // The backend's generation rule (BA-04 PR 2): a missing stamp is 0.
      return (token.gen ?? 0) === (controls.generations.get(token.sub) ?? 0) ? token.sub : null;
    },
  };
});

import { GET, POST } from '../route';

const requests = new AsyncLocalStorage<NextRequest>();
const require = createRequire(import.meta.url);
const nextIo = require('next/headers') as {
  headers: () => Promise<Headers>;
  cookies: () => Promise<{ getAll: () => { name: string; value: string }[] }>;
};
const origin = 'http://localhost:3000';
let cookies: Map<string, string>;
let csrfToken: string;

function remember(response: Response): void {
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(';')[0];
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator);
    const content = pair.slice(separator + 1);
    if (content) cookies.set(name, content);
    else cookies.delete(name);
  }
}
async function invoke(path: string, form?: Record<string, string>): Promise<Response> {
  const request = new NextRequest(`${origin}/api/auth/${path}`, {
    method: form ? 'POST' : 'GET',
    headers: {
      cookie: [...cookies].map(([name, content]) => `${name}=${content}`).join('; '),
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(form ? { body: new URLSearchParams(form) } : {}),
  });
  const context = { params: Promise.resolve({ nextauth: path.split('/') }) };
  return requests.run(request, () => (form ? POST(request, context) : GET(request, context)));
}
async function login(): Promise<Response> {
  return invoke('callback/credentials', {
    email: 'fixture@example.invalid',
    password: 'fixture-only',
    csrfToken,
    json: 'true',
    callbackUrl: origin,
  });
}
beforeAll(() => {
  vi.spyOn(nextIo, 'headers').mockImplementation(async () => requests.getStore()?.headers ?? new Headers());
  vi.spyOn(nextIo, 'cookies').mockImplementation(async () => ({
    getAll: () => requests.getStore()?.cookies.getAll() ?? [],
  }));
});
beforeEach(async () => {
  vi.stubEnv('NEXTAUTH_SECRET', secret);
  vi.stubEnv('NEXTAUTH_URL', origin);
  vi.stubEnv('AUTH_TRUST_HOST', '1');
  vi.stubEnv('VERCEL_ENV', '');
  vi.stubEnv('AUTH_COOKIE_DOMAIN', '');
  vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
  vi.stubEnv('CURRENT_STORE_WEB_OAUTH_MODE', 'legacy');
  controls.userId = 'owner-a';
  controls.deleted.clear();
  controls.unavailable = controls.deleteDuringJwt = controls.deleteDuringSignOut = false;
  controls.presented = [];
  controls.generations.clear();
  controls.signInStamp = 0;
  cookies = new Map();
  const response = await invoke('csrf');
  remember(response);
  csrfToken = ((await response.json()) as { csrfToken: string }).csrfToken;
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => vi.restoreAllMocks());

describe('actual public NextAuth deletion publication', () => {
  it('admits the actual callback JWE and accepts legacy-format credentials', async () => {
    const response = await login();
    expect(response.status).toBe(200);
    remember(response);
    const credential = cookies.get('next-auth.session-token');
    expect(credential).toBeTruthy();
    expect((await decode({ token: credential, secret }))?.sub).toBe('owner-a');
    expect(controls.presented).toContain(credential);
  });

  it('withholds callback cookies when deletion wins before final publication', async () => {
    controls.deleteDuringJwt = true;
    const response = await login();
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it.each(['GET', 'POST'])('withholds %s session renewal when deletion wins inside the handler', async (method) => {
    remember(await login());
    controls.deleteDuringJwt = true;
    const response = await invoke('session', method === 'POST' ? { csrfToken, json: 'true' } : undefined);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('withholds actual guarded sign-out clears when A becomes deleted in the handler', async () => {
    remember(await login());
    controls.deleteDuringSignOut = true;
    const response = await invoke('signout', {
      csrfToken,
      json: 'true',
      expectedUserId: 'owner-a',
      expectedAuthSessionId: 'login-owner-a',
    });
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('allows a genuine B credentials login carrying a revoked A cookie', async () => {
    remember(await login());
    controls.deleted.add('owner-a');
    controls.userId = 'owner-b';
    const response = await login();
    expect(response.status).toBe(200);
    remember(response);
    expect((await decode({ token: cookies.get('next-auth.session-token'), secret }))?.sub).toBe('owner-b');
  });

  it('answers 401 with no cookie when a failed generation read stamped 0 after a reset', async () => {
    controls.generations.set('owner-a', 1);
    controls.signInStamp = 0;
    const refused = await login();
    expect(refused.status).toBe(401);
    expect(refused.headers.getSetCookie()).toEqual([]);
    // The next attempt reads the generation and signs in.
    controls.signInStamp = 1;
    const admitted = await login();
    expect(admitted.status).toBe(200);
    remember(admitted);
    expect((await decode({ token: cookies.get('next-auth.session-token'), secret }))?.gen).toBe(1);
  });

  it('preserves the old cookie on authority outage rather than clearing it', async () => {
    remember(await login());
    const previous = cookies.get('next-auth.session-token');
    controls.unavailable = true;
    const response = await invoke('session');
    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(cookies.get('next-auth.session-token')).toBe(previous);
  });
});
