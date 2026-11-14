import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
vi.mock('server-only', () => ({}));

const { nextAuthHandlerMock, getTokenMock } = vi.hoisted(() => ({
  nextAuthHandlerMock: vi.fn(),
  getTokenMock: vi.fn(),
}));

vi.mock('next-auth', () => ({
  default: () => nextAuthHandlerMock,
}));
vi.mock('next-auth/jwt', () => ({
  getToken: (...args: unknown[]) => getTokenMock(...args),
}));
vi.mock('@/app/lib/auth/auth-options', () => ({ authOptions: { providers: [] } }));
// Use the REAL secure-cookies helpers (no copy-pasted stub to drift against the
// production logic). VERCEL_ENV=production (set in beforeEach) puts them in the
// secure-context branch, so the cookie names carry the `__Secure-` prefix.

import { GET, POST } from '../route';

function routeContext(request: NextRequest) {
  return {
    params: Promise.resolve({ nextauth: request.nextUrl.pathname.split('/api/auth/')[1].split('/').filter(Boolean) }),
  };
}

function request(path: string, body: Record<string, string>): NextRequest {
  return new NextRequest(`https://www.boardsesh.com${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
}

async function expectForwardedRequest(original: NextRequest) {
  expect(nextAuthHandlerMock).toHaveBeenCalledWith(expect.any(NextRequest), routeContext(original));
  const forwarded: unknown = nextAuthHandlerMock.mock.calls[0]?.[0];
  if (!(forwarded instanceof NextRequest)) throw new Error('Expected the actual forwarded request');
  expect(forwarded.url).toBe(original.url);
  expect(forwarded.method).toBe(original.method);
  expect([...forwarded.headers]).toEqual([...original.headers]);
  expect(await forwarded.clone().text()).toBe(await original.clone().text());
}

function hostOnlySessionCookieCleared(response: Response): boolean {
  const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  return setCookies.some(
    (setCookie) =>
      setCookie.startsWith('__Secure-next-auth.session-token=;') &&
      !/;\s*Domain=/i.test(setCookie) &&
      /Max-Age=0/i.test(setCookie),
  );
}

describe('POST /api/auth/[...nextauth]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Production www host → the real secure-cookies helpers use the `__Secure-`
    // name AND resolve the shared `.boardsesh.com` cookie domain (which arms
    // the legacy host-only clear). Pin every env they read so shell values
    // can't steer the branch under test.
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('NEXTAUTH_URL', 'https://www.boardsesh.com');
    vi.stubEnv('AUTH_COOKIE_DOMAIN', '');
    vi.stubEnv('NEXTAUTH_SECRET', 'test-nextauth-secret');
    vi.stubEnv('CURRENT_STORE_WEB_AUTH_MODE', 'legacy');
    vi.stubEnv('CURRENT_STORE_WEB_OAUTH_MODE', 'legacy');
    nextAuthHandlerMock.mockImplementation(async (_request: NextRequest, context: ReturnType<typeof routeContext>) => {
      const [action] = (await context.params).nextauth;
      return new Response(null, {
        status: 200,
        headers: action === 'signout' ? { 'Set-Cookie': '__Secure-next-auth.session-token=; Path=/; Max-Age=0' } : {},
      });
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['GET', 'POST'] as const)(
    'refuses Facebook %s starts and callbacks without touching the handler or cookies',
    async (method) => {
      for (const action of ['signin', 'callback']) {
        for (const suffix of ['', '/', '/extra']) {
          const facebookRequest = new NextRequest(`https://www.boardsesh.com/api/auth/${action}/facebook${suffix}`, {
            method,
          });
          const response = await (method === 'GET' ? GET : POST)(facebookRequest, routeContext(facebookRequest));
          expect(response.status).toBe(404);
          expect(await response.json()).toEqual({ error: 'unsupported_provider' });
          expect(response.headers.get('Cache-Control')).toBe('private, no-store');
          expect(response.headers.get('Set-Cookie')).toBeNull();
        }
      }
      expect(nextAuthHandlerMock).not.toHaveBeenCalled();
      expect(getTokenMock).not.toHaveBeenCalled();
    },
  );

  it.each(['url', 'params'] as const)(
    'refuses Facebook when only the %s names the removed provider',
    async (authority) => {
      const facebookRequest = new NextRequest(
        `https://www.boardsesh.com/api/auth/callback/${authority === 'url' ? '%66acebook' : 'google'}`,
      );
      const context = {
        params: Promise.resolve({ nextauth: ['callback', authority === 'params' ? 'facebook' : 'google'] }),
      };
      const response = await GET(facebookRequest, context);
      expect(response.status).toBe(404);
      expect(response.headers.get('Set-Cookie')).toBeNull();
      expect(nextAuthHandlerMock).not.toHaveBeenCalled();
    },
  );

  it('rejects an unscoped legacy NextAuth sign-out', async () => {
    const signOutRequest = request('/api/auth/signout', { csrfToken: 'csrf-token' });

    const response = await POST(signOutRequest, routeContext(signOutRequest));

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ error: 'signout_identity_required' });
    expect(nextAuthHandlerMock).not.toHaveBeenCalled();
    expect(getTokenMock).not.toHaveBeenCalled();
  });

  it('returns a transient 503 when the sign-out body cannot be parsed as form data', async () => {
    // A body that can't be read as form data (wrong content-type / too large /
    // a stream error) is a server-side condition, not a permanent identity
    // mismatch — it must not be a 400 the caller could treat as fatal.
    const signOutRequest = new NextRequest('https://www.boardsesh.com/api/auth/signout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedUserId: 'user-1', expectedAuthSessionId: 'login-1' }),
    });

    const response = await POST(signOutRequest, routeContext(signOutRequest));

    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ error: 'signout_identity_unreadable' });
    expect(nextAuthHandlerMock).not.toHaveBeenCalled();
    expect(getTokenMock).not.toHaveBeenCalled();
  });

  it('does not bypass the identity requirement with a trailing slash', async () => {
    const signOutRequest = request('/api/auth/signout/', { csrfToken: 'csrf-token' });

    const response = await POST(signOutRequest, routeContext(signOutRequest));

    expect(response.status).toBe(400);
    expect(nextAuthHandlerMock).not.toHaveBeenCalled();
    expect(getTokenMock).not.toHaveBeenCalled();
  });

  it('allows an Expo sign-out only while the cookie has the captured owner', async () => {
    getTokenMock.mockResolvedValue({ sub: 'user-1', authSessionId: 'login-1' });
    const signOutRequest = request('/api/auth/signout', {
      csrfToken: 'csrf-token',
      expectedUserId: 'user-1',
      expectedAuthSessionId: 'login-1',
    });

    signOutRequest.headers.set('Cookie', '__Secure-next-auth.session-token=synthetic-cookie');
    signOutRequest.headers.set('Authorization', 'Bearer must-not-select-the-cookie');

    await expect(POST(signOutRequest, routeContext(signOutRequest))).resolves.toMatchObject({ status: 200 });

    const decodedRead = getTokenMock.mock.calls.find(([settings]) => settings.raw !== true)?.[0];
    expect(decodedRead).toMatchObject({
      secureCookie: true,
      cookieName: '__Secure-next-auth.session-token',
    });
    expect(decodedRead.req.url).toBe(signOutRequest.url);
    expect(decodedRead.req.headers.get('cookie')).toBe(signOutRequest.headers.get('cookie'));
    expect(decodedRead.req.headers.get('authorization')).toBeNull();
    expect(nextAuthHandlerMock).toHaveBeenCalledOnce();
  });

  it('refuses to delete a cookie that belongs to a newer login', async () => {
    getTokenMock.mockResolvedValue({ sub: 'user-2', authSessionId: 'login-2' });
    const signOutRequest = request('/api/auth/signout', {
      csrfToken: 'csrf-token',
      expectedUserId: 'user-1',
      expectedAuthSessionId: 'login-1',
    });

    const response = await POST(signOutRequest, routeContext(signOutRequest));

    expect(response.status).toBe(409);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ error: 'signout_identity_changed' });
    expect(nextAuthHandlerMock).not.toHaveBeenCalled();
  });

  it('rejects a partially scoped sign-out instead of dropping its guard', async () => {
    const signOutRequest = request('/api/auth/signout', {
      csrfToken: 'csrf-token',
      expectedUserId: 'user-1',
    });

    const response = await POST(signOutRequest, routeContext(signOutRequest));

    expect(response.status).toBe(400);
    expect(nextAuthHandlerMock).not.toHaveBeenCalled();
    expect(getTokenMock).not.toHaveBeenCalled();
  });

  it('does not apply the sign-out guard to other NextAuth actions', async () => {
    const callbackRequest = request('/api/auth/callback/credentials', {
      expectedUserId: 'user-1',
      expectedAuthSessionId: 'login-1',
    });

    await expect(POST(callbackRequest, routeContext(callbackRequest))).resolves.toMatchObject({ status: 200 });

    await expectForwardedRequest(callbackRequest);
    expect(getTokenMock).not.toHaveBeenCalled();
  });

  it('resolves the sign-out identity from a session stored under the other cookie name', async () => {
    // Without the fallback read, a session living under the name the predicate
    // did NOT pick fails the identity comparison and every sign-out 409s.
    getTokenMock.mockResolvedValueOnce(null).mockResolvedValueOnce({ sub: 'user-1', authSessionId: 'login-1' });
    const signOutRequest = request('/api/auth/signout', {
      csrfToken: 'csrf-token',
      expectedUserId: 'user-1',
      expectedAuthSessionId: 'login-1',
    });

    await expect(POST(signOutRequest, routeContext(signOutRequest))).resolves.toMatchObject({ status: 200 });

    expect(getTokenMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ cookieName: '__Secure-next-auth.session-token' }),
    );
    expect(getTokenMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ cookieName: 'next-auth.session-token' }));
  });

  it('clears BOTH session cookie names on sign-out, in both scopes', async () => {
    // The read paths accept either name (sessionCookieNameCandidates), so a
    // sign-out that cleared only one would leave a cookie that still
    // authenticates — a logout bypass. Delete a name from
    // appendSignOutSessionCookieClears and this goes red.
    getTokenMock.mockResolvedValue({ sub: 'user-1', authSessionId: 'login-1' });
    nextAuthHandlerMock.mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: {
          'Set-Cookie':
            '__Secure-next-auth.session-token=; Path=/; Domain=.boardsesh.com; Max-Age=0; HttpOnly; SameSite=Lax; Secure',
        },
      }),
    );
    const signOutRequest = request('/api/auth/signout', {
      csrfToken: 'csrf-token',
      expectedUserId: 'user-1',
      expectedAuthSessionId: 'login-1',
    });

    const response = await POST(signOutRequest, routeContext(signOutRequest));

    const setCookies = response.headers.getSetCookie();
    for (const name of ['__Secure-next-auth.session-token', 'next-auth.session-token']) {
      const deletions = setCookies.filter((setCookie) => setCookie.startsWith(`${name}=;`));
      expect(
        deletions.some((setCookie) => /;\s*Domain=\.boardsesh\.com/i.test(setCookie)),
        name,
      ).toBe(true);
      expect(
        deletions.some((setCookie) => !/;\s*Domain=/i.test(setCookie)),
        name,
      ).toBe(true);
      for (const deletion of deletions) expect(deletion, name).toMatch(/Max-Age=0/i);
    }
  });

  it('clears both names on sign-out even where no cookie domain applies', async () => {
    // A homelab preview / a mis-enved container is host-only. The legacy clear
    // skips those on purpose (it would delete a freshly written login cookie);
    // the sign-out clear must not inherit that, or the bypass reopens exactly
    // where the fallback read is most likely to be doing the resolving.
    vi.stubEnv('VERCEL_ENV', '');
    vi.stubEnv('VERCEL_URL', '');
    vi.stubEnv('NEXTAUTH_URL', 'https://42.preview.boardsesh.com');
    getTokenMock.mockResolvedValue({ sub: 'user-1', authSessionId: 'login-1' });
    const signOutRequest = request('/api/auth/signout', {
      csrfToken: 'csrf-token',
      expectedUserId: 'user-1',
      expectedAuthSessionId: 'login-1',
    });

    const response = await POST(signOutRequest, routeContext(signOutRequest));

    const clearedNames = response.headers.getSetCookie().map((setCookie) => setCookie.split('=', 1)[0]);
    expect(clearedNames).toContain('__Secure-next-auth.session-token');
    expect(clearedNames).toContain('next-auth.session-token');
  });

  it('clears the legacy host-only cookie when signing out', async () => {
    getTokenMock.mockResolvedValue({ sub: 'user-1', authSessionId: 'login-1' });
    nextAuthHandlerMock.mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: {
          'Set-Cookie':
            '__Secure-next-auth.session-token=; Path=/; Domain=.boardsesh.com; Max-Age=0; HttpOnly; SameSite=Lax; Secure',
        },
      }),
    );
    const signOutRequest = request('/api/auth/signout', {
      csrfToken: 'csrf-token',
      expectedUserId: 'user-1',
      expectedAuthSessionId: 'login-1',
    });

    const response = await POST(signOutRequest, routeContext(signOutRequest));

    expect(response.status).toBe(200);
    expect(hostOnlySessionCookieCleared(response)).toBe(true);
  });

  it('clears the legacy host-only cookie when a login writes a fresh session cookie', async () => {
    nextAuthHandlerMock.mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: {
          'Set-Cookie':
            '__Secure-next-auth.session-token=fresh-jwt; Path=/; Domain=.boardsesh.com; HttpOnly; SameSite=Lax; Secure',
        },
      }),
    );
    const callbackRequest = request('/api/auth/callback/credentials', {});

    const response = await POST(callbackRequest, routeContext(callbackRequest));

    expect(hostOnlySessionCookieCleared(response)).toBe(true);
  });

  it('does not clear the legacy cookie on a bare read that writes no session cookie', async () => {
    nextAuthHandlerMock.mockResolvedValue(new Response(null, { status: 200 }));
    const sessionRequest = new NextRequest('https://www.boardsesh.com/api/auth/session', { method: 'GET' });

    const response = await GET(sessionRequest, routeContext(sessionRequest));

    expect(hostOnlySessionCookieCleared(response)).toBe(false);
  });

  it('does not delete the just-written host-only cookie in a dev (non-secure) context', async () => {
    // On localhost the fresh session cookie NextAuth writes is itself host-only
    // with the same name and path — appending the "legacy" clear would expire
    // the login in the same response, breaking every local login.
    vi.stubEnv('VERCEL_ENV', '');
    vi.stubEnv('VERCEL_URL', '');
    vi.stubEnv('NEXTAUTH_URL', 'http://localhost:3000');
    nextAuthHandlerMock.mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: { 'Set-Cookie': 'next-auth.session-token=fresh-jwt; Path=/; HttpOnly; SameSite=Lax' },
      }),
    );
    const callbackRequest = request('/api/auth/callback/credentials', {});

    const response = await POST(callbackRequest, routeContext(callbackRequest));

    const setCookies = response.headers.getSetCookie();
    expect(setCookies).toEqual(['next-auth.session-token=fresh-jwt; Path=/; HttpOnly; SameSite=Lax']);
  });

  it('binds an Expo Google return to OAuth state and returns callback errors to the app', async () => {
    const returnUrl =
      'https://app.boardsesh.com/auth/login?boardseshOAuthProvider=google&boardseshOAuthAttempt=attempt-google-1';
    nextAuthHandlerMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: 'https://accounts.google.com/o/oauth2/v2/auth?state=google-state-1' },
      }),
    );
    const signInRequest = request('/api/auth/signin/google', {
      csrfToken: 'csrf-token',
      callbackUrl: returnUrl,
    });

    const signInResponse = await POST(signInRequest, routeContext(signInRequest));
    const returnCookie = signInResponse.headers
      .getSetCookie()
      .find((setCookie) => setCookie.startsWith('boardsesh.oauth-return.'));
    expect(returnCookie).toContain('HttpOnly');
    expect(returnCookie).toContain('SameSite=None');
    expect(returnCookie).toContain('Secure');

    nextAuthHandlerMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: 'https://www.boardsesh.com/auth/error?error=AccessDenied' },
      }),
    );
    const callbackRequest = new NextRequest(
      'https://www.boardsesh.com/api/auth/callback/google?state=google-state-1&code=provider-code',
      {
        headers: { Cookie: returnCookie!.split(';', 1)[0]! },
      },
    );

    const callbackResponse = await GET(callbackRequest, routeContext(callbackRequest));
    const destination = new URL(callbackResponse.headers.get('Location')!);
    expect(destination.origin + destination.pathname).toBe('https://app.boardsesh.com/auth/login');
    expect(destination.searchParams.get('boardseshOAuthProvider')).toBe('google');
    expect(destination.searchParams.get('boardseshOAuthAttempt')).toBe('attempt-google-1');
    expect(destination.searchParams.get('boardseshOAuthError')).toBe('AccessDenied');
    expect(callbackResponse.headers.getSetCookie()).toContainEqual(
      expect.stringMatching(/^boardsesh\.oauth-return\..*=; .*Max-Age=0/),
    );
  });

  describe('a social sign-in started on the partner sign-in page', () => {
    const partnerReturn =
      'https://www.boardsesh.com/oauth/sign-in?client_id=bsk_sequence&state=app-state&sig=signed&boardsesh_signed_in=1';
    const callbackCookie = `__Secure-next-auth.callback-url=${encodeURIComponent(partnerReturn)}`;

    it('sends a failed Google callback back to that page, not to /auth/login', async () => {
      nextAuthHandlerMock.mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { Location: 'https://www.boardsesh.com/api/auth/error?error=OAuthAccountNotLinked' },
        }),
      );
      const callbackRequest = new NextRequest(
        'https://www.boardsesh.com/api/auth/callback/google?state=google-state&code=provider-code',
        { headers: { Cookie: callbackCookie } },
      );

      const response = await GET(callbackRequest, routeContext(callbackRequest));
      const location = response.headers.get('Location') ?? '';
      expect(location.startsWith('/oauth/sign-in?')).toBe(true);
      const query = new URLSearchParams(location.split('?')[1]);
      expect(query.get('error')).toBe('OAuthAccountNotLinked');
      expect(query.get('state')).toBe('app-state');
      expect(query.has('boardsesh_signed_in')).toBe(false);
    });

    it('sends a failed Apple form-post callback back to that page as well', async () => {
      nextAuthHandlerMock.mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { Location: 'https://www.boardsesh.com/api/auth/error?error=Callback' },
        }),
      );
      const callbackRequest = new NextRequest('https://www.boardsesh.com/api/auth/callback/apple', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: callbackCookie },
        body: new URLSearchParams({ state: 'apple-state', code: 'provider-code' }),
      });

      const response = await POST(callbackRequest, routeContext(callbackRequest));
      expect(response.headers.get('Location')).toMatch(/^\/oauth\/sign-in\?.*error=Callback/);
    });

    it('leaves a failed phone fallback start alone despite a stale partner cookie', async () => {
      const nativeCallback =
        'https://www.boardsesh.com/api/auth/native/callback?attemptId=0123456789abcdef0123456789abcdef';
      const headers = new Headers({ Location: 'https://www.boardsesh.com/api/auth/error?error=OAuthSignin' });
      headers.append('Set-Cookie', `__Secure-next-auth.callback-url=${encodeURIComponent(nativeCallback)}; Path=/`);
      nextAuthHandlerMock.mockResolvedValueOnce(new Response(null, { status: 302, headers }));
      // The /auth/native-start form POST, from a browser still holding an old partner callback.
      const startRequest = new NextRequest('https://www.boardsesh.com/api/auth/signin/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: callbackCookie },
        body: new URLSearchParams({ csrfToken: 'csrf-token', callbackUrl: nativeCallback }),
      });

      const response = await POST(startRequest, routeContext(startRequest));
      expect(response.headers.get('Location')).toBe('https://www.boardsesh.com/api/auth/error?error=OAuthSignin');
    });

    it('judges a refused sign-in start by the callbackUrl it posted, not the stale partner cookie', async () => {
      const refused = { url: 'https://www.boardsesh.com/auth/error?error=AuthBackendUnavailable' };
      nextAuthHandlerMock.mockResolvedValueOnce(Response.json(refused, { status: 503 }));
      const startRequest = new NextRequest('https://www.boardsesh.com/api/auth/signin/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: callbackCookie },
        body: new URLSearchParams({
          csrfToken: 'csrf-token',
          callbackUrl: 'https://www.boardsesh.com/auth/login',
          json: 'true',
        }),
      });

      const response = await POST(startRequest, routeContext(startRequest));
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual(refused);
    });

    it('lets a successful callback continue to the page as NextAuth sends it', async () => {
      nextAuthHandlerMock.mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { Location: partnerReturn } }),
      );
      const callbackRequest = new NextRequest(
        'https://www.boardsesh.com/api/auth/callback/google?state=google-state&code=provider-code',
        { headers: { Cookie: callbackCookie } },
      );

      const response = await GET(callbackRequest, routeContext(callbackRequest));
      expect(response.headers.get('Location')).toBe(partnerReturn);
    });
  });

  it('returns a successful Google callback to the exact Expo login attempt', async () => {
    const returnUrl =
      'https://app.boardsesh.com/auth/login?boardseshOAuthProvider=google&boardseshOAuthAttempt=attempt-google-2';
    nextAuthHandlerMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: 'https://accounts.google.com/o/oauth2/v2/auth?state=google-state-2' },
      }),
    );
    const signInResponse = await POST(
      request('/api/auth/signin/google', { csrfToken: 'csrf-token', callbackUrl: returnUrl }),
      { params: Promise.resolve({ nextauth: ['signin', 'google'] }) },
    );
    const returnCookie = signInResponse.headers
      .getSetCookie()
      .find((setCookie) => setCookie.startsWith('boardsesh.oauth-return.'));

    nextAuthHandlerMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: 'https://www.boardsesh.com/app' },
      }),
    );
    const callbackRequest = new NextRequest(
      'https://www.boardsesh.com/api/auth/callback/google?state=google-state-2&code=provider-code',
      { headers: { Cookie: returnCookie!.split(';', 1)[0]! } },
    );

    const callbackResponse = await GET(callbackRequest, routeContext(callbackRequest));

    expect(callbackResponse.status).toBe(302);
    expect(callbackResponse.headers.get('Location')).toBe(returnUrl);
  });

  it('turns a non-redirect callback failure into a return to the Expo app', async () => {
    const returnUrl =
      'https://app.boardsesh.com/auth/login?boardseshOAuthProvider=google&boardseshOAuthAttempt=attempt-google-3';
    nextAuthHandlerMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: 'https://accounts.google.com/o/oauth2/v2/auth?state=google-state-3' },
      }),
    );
    const signInResponse = await POST(
      request('/api/auth/signin/google', { csrfToken: 'csrf-token', callbackUrl: returnUrl }),
      { params: Promise.resolve({ nextauth: ['signin', 'google'] }) },
    );
    const returnCookie = signInResponse.headers
      .getSetCookie()
      .find((setCookie) => setCookie.startsWith('boardsesh.oauth-return.'));
    nextAuthHandlerMock.mockResolvedValueOnce(new Response('upstream failed', { status: 500 }));
    const callbackRequest = new NextRequest(
      'https://www.boardsesh.com/api/auth/callback/google?state=google-state-3&code=provider-code',
      { headers: { Cookie: returnCookie!.split(';', 1)[0]! } },
    );

    const callbackResponse = await GET(callbackRequest, routeContext(callbackRequest));

    expect(callbackResponse.status).toBe(302);
    const destination = new URL(callbackResponse.headers.get('Location')!);
    expect(destination.origin + destination.pathname).toBe('https://app.boardsesh.com/auth/login');
    expect(destination.searchParams.get('boardseshOAuthError')).toBe('OAuthCallback');
  });

  it('preserves a missing-email callback failure when returning to the Expo app', async () => {
    const returnUrl =
      'https://app.boardsesh.com/auth/login?boardseshOAuthProvider=google&boardseshOAuthAttempt=attempt-google-email';
    nextAuthHandlerMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: 'https://accounts.google.com/o/oauth2/v2/auth?state=google-state-email' },
      }),
    );
    const signInResponse = await POST(
      request('/api/auth/signin/google', { csrfToken: 'csrf-token', callbackUrl: returnUrl }),
      { params: Promise.resolve({ nextauth: ['signin', 'google'] }) },
    );
    const returnCookie = signInResponse.headers
      .getSetCookie()
      .find((setCookie) => setCookie.startsWith('boardsesh.oauth-return.'));
    nextAuthHandlerMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: 'https://www.boardsesh.com/auth/error?error=OAuthEmailRequired' },
      }),
    );
    const callbackRequest = new NextRequest(
      'https://www.boardsesh.com/api/auth/callback/google?state=google-state-email&code=provider-code',
      { headers: { Cookie: returnCookie!.split(';', 1)[0]! } },
    );

    const callbackResponse = await GET(callbackRequest, routeContext(callbackRequest));

    const destination = new URL(callbackResponse.headers.get('Location')!);
    expect(destination.origin + destination.pathname).toBe('https://app.boardsesh.com/auth/login');
    expect(destination.searchParams.get('boardseshOAuthError')).toBe('OAuthEmailRequired');
  });

  it('returns an Apple form-post callback to the exact Expo registration attempt', async () => {
    const returnUrl =
      'https://www.boardsesh.com/app/auth/register?boardseshOAuthProvider=apple&boardseshOAuthAttempt=attempt-apple-1';
    nextAuthHandlerMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: 'https://appleid.apple.com/auth/authorize?state=apple-state-1' },
      }),
    );
    const signInResponse = await POST(
      request('/api/auth/signin/apple', { csrfToken: 'csrf-token', callbackUrl: returnUrl }),
      { params: Promise.resolve({ nextauth: ['signin', 'apple'] }) },
    );
    const returnCookie = signInResponse.headers
      .getSetCookie()
      .find((setCookie) => setCookie.startsWith('boardsesh.oauth-return.'));

    nextAuthHandlerMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: {
          Location: 'https://www.boardsesh.com/app',
          'Set-Cookie': '__Secure-next-auth.session-token=fresh; Path=/; Secure; HttpOnly',
        },
      }),
    );
    const callbackRequest = new NextRequest('https://www.boardsesh.com/api/auth/callback/apple', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: returnCookie!.split(';', 1)[0]!,
      },
      body: new URLSearchParams({ state: 'apple-state-1', code: 'provider-code' }),
    });

    const callbackResponse = await POST(callbackRequest, routeContext(callbackRequest));
    expect(callbackResponse.headers.get('Location')).toBe(returnUrl);
    expect(callbackResponse.headers.getSetCookie()).toContainEqual(
      expect.stringContaining('__Secure-next-auth.session-token=fresh'),
    );
  });

  describe('an Expo return carrying a next path', () => {
    const nextPath = '/b/the-gym/40/view/crimpy-thing-0A1B2C3D4E5F60718293A4B5C6D7E8F9';

    function returnUrlWithNext(attemptId: string, nextValue = nextPath): string {
      const returnUrl = new URL('https://app.boardsesh.com/auth/login');
      returnUrl.searchParams.set('boardseshOAuthProvider', 'google');
      returnUrl.searchParams.set('boardseshOAuthAttempt', attemptId);
      returnUrl.searchParams.set('next', nextValue);
      return returnUrl.toString();
    }

    async function startSignIn(callbackUrl: string, state: string): Promise<string | undefined> {
      nextAuthHandlerMock.mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { Location: `https://accounts.google.com/o/oauth2/v2/auth?state=${state}` },
        }),
      );
      const signInRequest = request('/api/auth/signin/google', { csrfToken: 'csrf-token', callbackUrl });
      const signInResponse = await POST(signInRequest, routeContext(signInRequest));
      return signInResponse.headers.getSetCookie().find((setCookie) => setCookie.startsWith('boardsesh.oauth-return.'));
    }

    async function finishSignIn(cookiePair: string, state: string, outcome: Response): Promise<Response> {
      nextAuthHandlerMock.mockResolvedValueOnce(outcome);
      const callbackRequest = new NextRequest(
        `https://www.boardsesh.com/api/auth/callback/google?state=${state}&code=provider-code`,
        { headers: { Cookie: cookiePair } },
      );
      return GET(callbackRequest, routeContext(callbackRequest));
    }

    const failedSignIn = () =>
      new Response(null, {
        status: 302,
        headers: { Location: 'https://www.boardsesh.com/auth/login?error=OAuthCallback' },
      });

    it('returns a failed sign-in to the app with the climb still on the URL', async () => {
      const returnCookie = await startSignIn(returnUrlWithNext('attempt-next-1'), 'next-state-1');
      expect(returnCookie).toBeDefined();

      const callbackResponse = await finishSignIn(returnCookie!.split(';', 1)[0]!, 'next-state-1', failedSignIn());

      const destination = new URL(callbackResponse.headers.get('Location')!);
      expect(destination.origin + destination.pathname).toBe('https://app.boardsesh.com/auth/login');
      expect(destination.searchParams.get('next')).toBe(nextPath);
      expect(destination.searchParams.get('boardseshOAuthError')).toBe('OAuthCallback');
    });

    it('returns a successful sign-in to the exact URL it started from', async () => {
      const returnUrl = returnUrlWithNext('attempt-next-2');
      const returnCookie = await startSignIn(returnUrl, 'next-state-2');

      const callbackResponse = await finishSignIn(
        returnCookie!.split(';', 1)[0]!,
        'next-state-2',
        new Response(null, { status: 302, headers: { Location: 'https://www.boardsesh.com/app' } }),
      );

      expect(callbackResponse.headers.get('Location')).toBe(returnUrl);
    });

    it('refuses a return cookie whose next was changed after signing', async () => {
      const returnCookie = await startSignIn(returnUrlWithNext('attempt-next-3'), 'next-state-3');
      const [cookieName, cookieValue] = returnCookie!.split(';', 1)[0]!.split('=') as [string, string];
      const [payload, signature] = cookieValue.split('.') as [string, string];
      const descriptor = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { returnUrl: string };
      const swappedNext = descriptor.returnUrl.replace(
        encodeURIComponent(nextPath),
        encodeURIComponent('/b/other-gym'),
      );
      expect(swappedNext).not.toBe(descriptor.returnUrl);
      const tamperedPayload = Buffer.from(JSON.stringify({ ...descriptor, returnUrl: swappedNext })).toString(
        'base64url',
      );

      const callbackResponse = await finishSignIn(
        `${cookieName}=${tamperedPayload}.${signature}`,
        'next-state-3',
        failedSignIn(),
      );

      // Unbound, so NextAuth's own redirect stands and nothing reaches the app.
      expect(callbackResponse.headers.get('Location')).toBe('https://www.boardsesh.com/auth/login?error=OAuthCallback');
    });

    it.each([
      ['a look-alike host', (url: URL) => (url.hostname = 'app.boardsesh.com.evil.example')],
      ['an app path other than login or register', (url: URL) => (url.pathname = '/settings')],
      ['a param that is not allowed', (url: URL) => url.searchParams.set('redirect', 'https://evil.example')],
    ])('still refuses to bind %s, next or no next', async (_label, widen) => {
      const widenedUrl = new URL(returnUrlWithNext('attempt-next-4'));
      widen(widenedUrl);

      expect(await startSignIn(widenedUrl.toString(), 'next-state-4')).toBeUndefined();
    });

    it('keeps a hostile next as a value on the app URL, where the app refuses it', async () => {
      const returnCookie = await startSignIn(
        returnUrlWithNext('attempt-next-5', 'https://evil.example'),
        'next-state-5',
      );

      const callbackResponse = await finishSignIn(returnCookie!.split(';', 1)[0]!, 'next-state-5', failedSignIn());

      const destination = new URL(callbackResponse.headers.get('Location')!);
      expect(destination.origin + destination.pathname).toBe('https://app.boardsesh.com/auth/login');
    });

    describe('the return URL length limit', () => {
      function returnUrlOfLength(attemptId: string, length: number): string {
        const nextPrefix = '/b/';
        const paddingLength = length - returnUrlWithNext(attemptId, nextPrefix).length;
        const returnUrl = returnUrlWithNext(attemptId, `${nextPrefix}${'a'.repeat(paddingLength)}`);
        expect(returnUrl).toHaveLength(length);
        return returnUrl;
      }

      it('binds a return URL exactly at 1024 characters', async () => {
        expect(await startSignIn(returnUrlOfLength('attempt-next-6', 1024), 'next-state-6')).toBeDefined();
      });

      it('leaves a return URL over 1024 characters on the unbound path', async () => {
        expect(await startSignIn(returnUrlOfLength('attempt-next-7', 1025), 'next-state-7')).toBeUndefined();
        expect(nextAuthHandlerMock).toHaveBeenCalledOnce();
      });

      it('leaves room for the longest board path the app will carry', async () => {
        // The app refuses a next over 512 characters (MAX_RETURN_HREF_LENGTH), and
        // canonical board URLs are ASCII, so only their slashes grow when encoded.
        const boardPathPrefix = '/tension/original-layout/12x12-rubber/mainline_bolt-ons_screw-ons/40/view/';
        const longestBoardPath = `${boardPathPrefix}${'a'.repeat(512 - boardPathPrefix.length)}`;
        const returnUrl = returnUrlWithNext('a'.repeat(128), longestBoardPath);

        expect(returnUrl.length).toBeLessThan(800);
        expect(await startSignIn(returnUrl, 'next-state-8')).toBeDefined();
      });
    });
  });

  it('does not bind an untrusted or malformed Expo callback URL', async () => {
    nextAuthHandlerMock.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: 'https://accounts.google.com/o/oauth2/v2/auth?state=google-state-1' },
      }),
    );
    const lookalikeRequest = request('/api/auth/signin/google', {
      csrfToken: 'csrf-token',
      callbackUrl:
        'https://app.boardsesh.com.evil.example/auth/login?boardseshOAuthProvider=google&boardseshOAuthAttempt=attempt-google-1',
    });

    const response = await POST(lookalikeRequest, routeContext(lookalikeRequest));

    expect(response.headers.getSetCookie().some((setCookie) => setCookie.startsWith('boardsesh.oauth-return.'))).toBe(
      false,
    );
    await expectForwardedRequest(lookalikeRequest);
  });

  it('fails explicitly when Expo return binding has no signing secret', async () => {
    vi.stubEnv('NEXTAUTH_SECRET', '');
    nextAuthHandlerMock.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: 'https://accounts.google.com/o/oauth2/v2/auth?state=google-state-4' },
      }),
    );
    const signInRequest = request('/api/auth/signin/google', {
      csrfToken: 'csrf-token',
      callbackUrl:
        'https://app.boardsesh.com/auth/login?boardseshOAuthProvider=google&boardseshOAuthAttempt=attempt-google-4',
    });

    await expect(POST(signInRequest, routeContext(signInRequest))).rejects.toThrow(
      'NEXTAUTH_SECRET is required to bind Expo web OAuth returns',
    );
  });
});

// These tests isolate the existing dispatch/password contract; admission has
// its own public-codec and mounted-handler publication coverage.
vi.mock('@/app/lib/auth/auth-response-admission.server', () => ({
  withAuthResponseAdmission: (_request: unknown, _context: unknown, invoke: () => Promise<Response>) => invoke(),
}));
