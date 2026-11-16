// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
vi.mock('server-only', () => ({}));

const { nextAuthHandlerMock } = vi.hoisted(() => ({ nextAuthHandlerMock: vi.fn() }));
vi.mock('next-auth', () => ({ default: () => nextAuthHandlerMock }));
vi.mock('@/app/lib/auth/auth-options', () => ({ authOptions: { providers: [] } }));
// The real response admission runs: none of these requests carries a session
// cookie, so it reads no credential and only marks the response private.

import { GET, POST } from '../route';

const origin = 'https://www.boardsesh.com';

type ProviderCall = {
  label: string;
  method: 'GET' | 'POST';
  path: string;
  route: string[];
};

const providerCalls: ProviderCall[] = [
  { label: 'Google sign-in start', method: 'POST', path: '/api/auth/signin/google', route: ['signin', 'google'] },
  { label: 'Google callback', method: 'GET', path: '/api/auth/callback/google', route: ['callback', 'google'] },
  { label: 'Apple sign-in start', method: 'POST', path: '/api/auth/signin/apple', route: ['signin', 'apple'] },
  { label: 'Apple form-post callback', method: 'POST', path: '/api/auth/callback/apple', route: ['callback', 'apple'] },
  { label: 'Apple GET callback', method: 'GET', path: '/api/auth/callback/apple', route: ['callback', 'apple'] },
  {
    label: 'percent-encoded Google start',
    method: 'POST',
    path: '/api/auth/signin/%67oogle',
    route: ['signin', 'google'],
  },
];

function call({ method, path, route }: ProviderCall, cookie: string | null): Promise<Response> {
  const headers = new Headers();
  if (cookie !== null) headers.set('Cookie', cookie);
  const isCallback = route[0] === 'callback';
  let url = `${origin}${path}`;
  let body: URLSearchParams | undefined;
  if (method === 'POST') {
    headers.set('Content-Type', 'application/x-www-form-urlencoded');
    body = isCallback
      ? new URLSearchParams({ state: 'provider-state', code: 'provider-code' })
      : new URLSearchParams({ csrfToken: 'csrf-token', callbackUrl: `${origin}/` });
  } else if (isCallback) {
    url += '?state=provider-state&code=provider-code';
  }
  const request = new NextRequest(url, { method, headers, body });
  const context = { params: Promise.resolve({ nextauth: route }) };
  return method === 'GET' ? GET(request, context) : POST(request, context);
}

const pairs = (count: number) => Array.from({ length: count }, (_, index) => `c${index}=1`).join('; ');

const refusedHeaders: [string, string][] = [
  ['over 32 KiB', `a=${'x'.repeat(32_767)}`],
  ['over 128 pairs', pairs(129)],
  ['a control character', 'a=1\u0001'],
  ['a pair with no =', 'a=1; flag'],
  ['a pair with an empty name', '=orphan'],
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('VERCEL_ENV', 'production');
  vi.stubEnv('NEXTAUTH_URL', origin);
  vi.stubEnv('AUTH_COOKIE_DOMAIN', '');
  vi.stubEnv('NEXTAUTH_SECRET', 'provider-cookie-header-test-secret');
  vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
  vi.stubEnv('CURRENT_STORE_WEB_OAUTH_MODE', 'legacy');
  nextAuthHandlerMock.mockImplementation(
    async () =>
      new Response(null, {
        status: 302,
        headers: { Location: 'https://accounts.google.com/o/oauth2/v2/auth?state=provider-state' },
      }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Google and Apple Cookie header limits (kept from #7526)', () => {
  describe.each(refusedHeaders)('a Cookie header with %s', (_description, cookie) => {
    it.each(providerCalls)('answers 503 to the $label before the handler runs', async (providerCall) => {
      const response = await call(providerCall, cookie);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'Credential authority is temporarily unavailable' });
      expect(response.headers.get('X-Boardsesh-Credential-Authority')).toBe('unavailable');
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(nextAuthHandlerMock).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['session', 'GET'],
    ['csrf', 'GET'],
    ['providers', 'GET'],
  ] as const)('does not apply the limits to /api/auth/%s', async (action, method) => {
    nextAuthHandlerMock.mockResolvedValue(Response.json({}));
    for (const [, cookie] of refusedHeaders) {
      const request = new NextRequest(`${origin}/api/auth/${action}`, { method, headers: { Cookie: cookie } });
      const response = await GET(request, { params: Promise.resolve({ nextauth: [action] }) });
      expect(response.status).toBe(200);
    }
    expect(nextAuthHandlerMock).toHaveBeenCalledTimes(refusedHeaders.length);
  });

  it.each(providerCalls)('lets an ordinary Cookie header through to the $label', async (providerCall) => {
    const response = await call(providerCall, `${pairs(127)}; theme=dark`);
    expect(response.status).toBe(302);
    expect(nextAuthHandlerMock).toHaveBeenCalledTimes(1);
  });
});

// #7594: a leftover `__Host-boardsesh.*` cookie from the deleted provider
// publication no longer blocks Google or Apple sign-in.
describe('leftover __Host-boardsesh provider cookies', () => {
  const leftovers = [
    `__Host-boardsesh.anonymous-provider.${'a'.repeat(64)}=sealed-carrier`,
    `__Host-boardsesh.provider-signin.${'b'.repeat(64)}=sealed-carrier`,
    `__Host-boardsesh.provider-security.${'c'.repeat(64)}=sealed-flow`,
  ];

  it.each(providerCalls)('reach the legacy handler on the $label', async (providerCall) => {
    const response = await call(providerCall, leftovers.join('; '));
    expect(response.status).toBe(302);
    expect(nextAuthHandlerMock).toHaveBeenCalledTimes(1);
  });
});
