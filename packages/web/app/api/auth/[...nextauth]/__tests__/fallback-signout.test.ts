// @vitest-environment node
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { NextRequest } from 'next/server';
import { encode, decode } from 'next-auth/jwt';
vi.mock('server-only', () => ({}));

const controls = vi.hoisted(() => ({
  forwarded: [] as string[],
  unavailable: false,
  denyAcknowledged: false,
  ackGate: null as Promise<void> | null,
  enteredForward: null as (() => void) | null,
}));
const secret = 'fallback-signout-owned-fixture-key';
const preferred = '__Secure-next-auth.session-token';
const fallback = 'next-auth.session-token';
const origin = 'https://auth-fallback.example.test';
vi.mock('@/app/lib/auth/auth-options', () => ({
  authOptions: {
    secret: 'fallback-signout-owned-fixture-key',
    session: { strategy: 'jwt' },
    providers: [],
    useSecureCookies: true,
    cookies: {
      sessionToken: {
        name: '__Secure-next-auth.session-token',
        options: { httpOnly: true, secure: true, sameSite: 'lax', path: '/' },
      },
    },
    logger: { error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));
vi.mock('@/app/lib/auth/credential-admission.server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/lib/auth/credential-admission.server')>();
  return {
    ...actual,
    admitPresentedWebCredential: async (credential: string) => {
      const token = await decode({ token: credential, secret: 'fallback-signout-owned-fixture-key' });
      if (controls.denyAcknowledged && controls.forwarded.includes(credential)) return null;
      return token?.sub === 'fallback-fixture' ? token.sub : null;
    },
  };
});
vi.mock('@/app/lib/auth/web-signout-command.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/lib/auth/web-signout-command.server')>()),
  forwardWebSignOut: async (credential: string) => {
    if (controls.unavailable) throw new Error('Fixture authority unavailable');
    controls.enteredForward?.();
    await controls.ackGate;
    controls.forwarded.push(credential);
  },
}));
import { GET, POST } from '../route';
import { authOptions } from '@/app/lib/auth/auth-options';

const requests = new AsyncLocalStorage<NextRequest>();
const require = createRequire(import.meta.url);
const nextIo = require('next/headers') as {
  headers: () => Promise<Headers>;
  cookies: () => Promise<{ getAll: () => { name: string; value: string }[] }>;
};
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
async function invoke(action: string, form?: Record<string, string>): Promise<Response> {
  const request = new NextRequest(`${origin}/api/auth/${action}`, {
    method: form ? 'POST' : 'GET',
    headers: {
      cookie: [...cookies].map(([name, content]) => `${name}=${content}`).join('; '),
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(form ? { body: new URLSearchParams(form) } : {}),
  });
  const context = { params: Promise.resolve({ nextauth: [action] }) };
  return requests.run(request, () => (form ? POST(request, context) : GET(request, context)));
}
async function present(name: string, chunked = false): Promise<string> {
  const credential = await encode({
    secret,
    token: { sub: 'fallback-fixture', authSessionId: 'fallback-login-fixture', gen: 4 },
    maxAge: 3600,
  });
  if (chunked) {
    const boundary = Math.floor(credential.length / 2);
    cookies.set(`${name}.0`, credential.slice(0, boundary));
    cookies.set(`${name}.1`, credential.slice(boundary));
  } else cookies.set(name, credential);
  return credential;
}
function signOut(csrf = csrfToken): Promise<Response> {
  return invoke('signout', {
    csrfToken: csrf,
    expectedUserId: 'fallback-fixture',
    expectedAuthSessionId: 'fallback-login-fixture',
    callbackUrl: origin,
    json: 'true',
  });
}
function sessionClears(response: Response): string[] {
  return response.headers.getSetCookie().filter((header) => /next-auth\.session-token(?:\.\d+)?=;/.test(header));
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
  vi.stubEnv('VERCEL_URL', '');
  vi.stubEnv('AUTH_COOKIE_DOMAIN', '');
  vi.stubEnv('AUTH_LEGACY_BRIDGE_MODE', 'off');
  vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
  vi.stubEnv('CURRENT_STORE_WEB_OAUTH_MODE', 'legacy');
  vi.stubEnv('CURRENT_STORE_WEB_SIGNOUT_MODE', 'backend-staging');
  controls.forwarded = [];
  controls.unavailable = false;
  controls.denyAcknowledged = false;
  controls.ackGate = null;
  controls.enteredForward = null;
  cookies = new Map();
  const response = await invoke('csrf');
  remember(response);
  csrfToken = ((await response.json()) as { csrfToken: string }).csrfToken;
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => vi.restoreAllMocks());

describe('installed NextAuth sign-out with a fallback cookie name', () => {
  it.each([
    { name: preferred, chunked: false },
    { name: preferred, chunked: true },
    { name: fallback, chunked: false },
    { name: fallback, chunked: true },
  ])('denies before clearing $name, chunked=$chunked', async ({ name, chunked }) => {
    const credential = await present(name, chunked);
    const response = await signOut();
    expect(response.status).toBe(200);
    expect(controls.forwarded.length).toBe(1);
    expect(controls.forwarded[0] === credential).toBe(true);
    expect(sessionClears(response).some((header) => header.startsWith(`${name}=`))).toBe(true);
    expect(authOptions.cookies?.sessionToken?.name).toBe(preferred);
    remember(response);
    expect([...cookies.keys()].some((cookieName) => cookieName.includes('session-token'))).toBe(false);
  });

  it('does not deny or clear a fallback credential after actual CSRF refusal', async () => {
    await present(fallback, true);
    const response = await signOut('wrong-fixture-csrf');
    expect(controls.forwarded.length).toBe(0);
    expect(sessionClears(response).length).toBe(0);
  });

  it('withholds fallback clears when backend denial is unavailable', async () => {
    await present(fallback, true);
    controls.unavailable = true;
    const response = await signOut();
    expect(response.status).toBe(503);
    expect(sessionClears(response).length).toBe(0);
    expect([...cookies.keys()].some((cookieName) => cookieName.includes('session-token'))).toBe(true);
  });
  it('uses the fallback cookie rather than bearer fallback when selecting the public signout handler', async () => {
    const credential = await present(fallback, true);
    const request = new NextRequest(`${origin}/api/auth/signout`, {
      method: 'POST',
      headers: {
        cookie: [...cookies].map(([name, content]) => `${name}=${content}`).join('; '),
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        csrfToken,
        expectedUserId: 'fallback-fixture',
        expectedAuthSessionId: 'fallback-login-fixture',
        callbackUrl: origin,
        json: 'true',
      }),
    });
    const response = await requests.run(request, () =>
      POST(request, { params: Promise.resolve({ nextauth: ['signout'] }) }),
    );
    expect(response.status).toBe(200);
    expect(controls.forwarded.length).toBe(1);
    expect(controls.forwarded[0] === credential).toBe(true);
    expect(sessionClears(response).length).toBeGreaterThan(0);
  });

  it('publishes fallback clears after its own acknowledged SID denial becomes visible to admission', async () => {
    await present(fallback, true);
    controls.denyAcknowledged = true;
    const response = await signOut();
    expect(controls.forwarded.length).toBe(1);
    expect(response.status).toBe(200);
    expect(sessionClears(response).length).toBeGreaterThan(0);
  });

  it.each([
    { accepted: true, label: 'accepted' },
    { accepted: false, label: 'refused' },
  ])('waits for $label backend acknowledgement before publishing fallback clears', async ({ accepted }) => {
    const credential = await present(fallback, true);
    let entered = () => {};
    const arrived = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let settleAck = (_accepted: boolean) => {};
    controls.ackGate = new Promise<void>((resolve, reject) => {
      settleAck = (allow) => (allow ? resolve() : reject(new Error('Synthetic delayed refusal')));
    });
    controls.enteredForward = entered;
    const pending = signOut();
    try {
      await arrived;
      const publishedBeforeAck = await Promise.race([
        pending.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
      ]);
      expect(publishedBeforeAck).toBe(false);
      settleAck(accepted);
      const response = await pending;
      expect(response.status).toBe(accepted ? 200 : 503);
      expect(sessionClears(response).length > 0).toBe(accepted);
      expect(controls.forwarded.length).toBe(accepted ? 1 : 0);
      if (accepted) expect(controls.forwarded[0] === credential).toBe(true);
    } finally {
      settleAck(true);
      await pending.catch(() => {});
    }
  });

  it('keeps concurrent preferred and fallback NextAuth cookie options request-local', async () => {
    const optionsBefore = JSON.stringify(authOptions.cookies);
    const firstCredential = await present(preferred);
    const firstJar = new Map(cookies);
    cookies.delete(preferred);
    const secondCredential = await present(fallback, true);
    const secondJar = new Map(cookies);
    let opened = () => {};
    const both = new Promise<void>((resolve) => {
      opened = resolve;
    });
    let arrivals = 0;
    const heldHeaders = async () => {
      const current = requests.getStore();
      arrivals += 1;
      if (arrivals === 2) opened();
      await both;
      return current?.headers ?? new Headers();
    };
    vi.mocked(nextIo.headers).mockImplementationOnce(heldHeaders).mockImplementationOnce(heldHeaders);
    const invokeJar = (jar: ReadonlyMap<string, string>) => {
      const request = new NextRequest(`${origin}/api/auth/signout`, {
        method: 'POST',
        headers: {
          cookie: [...jar].map(([name, content]) => `${name}=${content}`).join('; '),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          csrfToken,
          expectedUserId: 'fallback-fixture',
          expectedAuthSessionId: 'fallback-login-fixture',
          callbackUrl: origin,
          json: 'true',
        }),
      });
      return requests.run(request, () => POST(request, { params: Promise.resolve({ nextauth: ['signout'] }) }));
    };
    try {
      const responses = await Promise.all([invokeJar(firstJar), invokeJar(secondJar)]);
      expect(arrivals).toBe(2);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect(responses.every((response) => sessionClears(response).length > 0)).toBe(true);
      expect(controls.forwarded.length).toBe(2);
      expect(controls.forwarded.includes(firstCredential) && controls.forwarded.includes(secondCredential)).toBe(true);
      expect(JSON.stringify(authOptions.cookies)).toBe(optionsBefore);
    } finally {
      opened();
    }
  });

  it('refuses a body-selected fallback SID when a different valid preferred SID is present', async () => {
    await present(preferred);
    const other = await encode({
      secret,
      token: { sub: 'fallback-fixture', authSessionId: 'other-fallback-login', gen: 4 },
      maxAge: 3600,
    });
    cookies.set(fallback, other);
    const response = await invoke('signout', {
      csrfToken,
      expectedUserId: 'fallback-fixture',
      expectedAuthSessionId: 'other-fallback-login',
      callbackUrl: origin,
      json: 'true',
    });
    expect(response.status).toBe(409);
    expect(controls.forwarded.length).toBe(0);
    expect(sessionClears(response).length).toBe(0);
  });

  it('does not clear a legacy-mode fallback cookie when actual NextAuth refuses CSRF', async () => {
    vi.stubEnv('CURRENT_STORE_WEB_SIGNOUT_MODE', 'legacy');
    await present(fallback, true);
    const response = await signOut('wrong-fixture-csrf');
    expect(controls.forwarded.length).toBe(0);
    expect(sessionClears(response).length).toBe(0);
  });
});
