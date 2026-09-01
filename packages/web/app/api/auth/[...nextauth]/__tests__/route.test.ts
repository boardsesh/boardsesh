import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

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
vi.mock('@/app/lib/auth/auth-options', () => ({ authOptions: {} }));
// Use the REAL secure-cookies helpers (no copy-pasted stub to drift against the
// production logic). VERCEL_ENV=production (set in beforeEach) puts them in the
// secure-context branch, so the cookie names carry the `__Secure-` prefix.

import { GET, POST } from '../route';

const context = { params: Promise.resolve({ nextauth: ['signout'] }) };

function request(path: string, body: Record<string, string>): NextRequest {
  return new NextRequest(`https://www.boardsesh.com${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
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
    nextAuthHandlerMock.mockResolvedValue(new Response(null, { status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects an unscoped legacy NextAuth sign-out', async () => {
    const signOutRequest = request('/api/auth/signout', { csrfToken: 'csrf-token' });

    const response = await POST(signOutRequest, context);

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

    const response = await POST(signOutRequest, context);

    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ error: 'signout_identity_unreadable' });
    expect(nextAuthHandlerMock).not.toHaveBeenCalled();
    expect(getTokenMock).not.toHaveBeenCalled();
  });

  it('does not bypass the identity requirement with a trailing slash', async () => {
    const signOutRequest = request('/api/auth/signout/', { csrfToken: 'csrf-token' });

    const response = await POST(signOutRequest, context);

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

    await expect(POST(signOutRequest, context)).resolves.toMatchObject({ status: 200 });

    expect(getTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        req: signOutRequest,
        secureCookie: true,
        cookieName: '__Secure-next-auth.session-token',
      }),
    );
    expect(nextAuthHandlerMock).toHaveBeenCalledOnce();
  });

  it('refuses to delete a cookie that belongs to a newer login', async () => {
    getTokenMock.mockResolvedValue({ sub: 'user-2', authSessionId: 'login-2' });
    const signOutRequest = request('/api/auth/signout', {
      csrfToken: 'csrf-token',
      expectedUserId: 'user-1',
      expectedAuthSessionId: 'login-1',
    });

    const response = await POST(signOutRequest, context);

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

    const response = await POST(signOutRequest, context);

    expect(response.status).toBe(400);
    expect(nextAuthHandlerMock).not.toHaveBeenCalled();
    expect(getTokenMock).not.toHaveBeenCalled();
  });

  it('does not apply the sign-out guard to other NextAuth actions', async () => {
    const callbackRequest = request('/api/auth/callback/credentials', {
      expectedUserId: 'user-1',
      expectedAuthSessionId: 'login-1',
    });

    await expect(POST(callbackRequest, context)).resolves.toMatchObject({ status: 200 });

    expect(nextAuthHandlerMock).toHaveBeenCalledWith(callbackRequest, context);
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

    await expect(POST(signOutRequest, context)).resolves.toMatchObject({ status: 200 });

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

    const response = await POST(signOutRequest, context);

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
    nextAuthHandlerMock.mockResolvedValue(new Response(null, { status: 200 }));
    const signOutRequest = request('/api/auth/signout', {
      csrfToken: 'csrf-token',
      expectedUserId: 'user-1',
      expectedAuthSessionId: 'login-1',
    });

    const response = await POST(signOutRequest, context);

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

    const response = await POST(signOutRequest, context);

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

    const response = await POST(callbackRequest, context);

    expect(hostOnlySessionCookieCleared(response)).toBe(true);
  });

  it('does not clear the legacy cookie on a bare read that writes no session cookie', async () => {
    nextAuthHandlerMock.mockResolvedValue(new Response(null, { status: 200 }));
    const sessionRequest = new NextRequest('https://www.boardsesh.com/api/auth/session', { method: 'GET' });

    const response = await GET(sessionRequest, context);

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

    const response = await POST(callbackRequest, context);

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

    const signInResponse = await POST(signInRequest, context);
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

    const callbackResponse = await GET(callbackRequest, context);
    const destination = new URL(callbackResponse.headers.get('Location')!);
    expect(destination.origin + destination.pathname).toBe('https://app.boardsesh.com/auth/login');
    expect(destination.searchParams.get('boardseshOAuthProvider')).toBe('google');
    expect(destination.searchParams.get('boardseshOAuthAttempt')).toBe('attempt-google-1');
    expect(destination.searchParams.get('boardseshOAuthError')).toBe('AccessDenied');
    expect(callbackResponse.headers.getSetCookie()).toContainEqual(
      expect.stringMatching(/^boardsesh\.oauth-return\..*=; .*Max-Age=0/),
    );
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
      context,
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

    const callbackResponse = await GET(callbackRequest, context);

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
      context,
    );
    const returnCookie = signInResponse.headers
      .getSetCookie()
      .find((setCookie) => setCookie.startsWith('boardsesh.oauth-return.'));
    nextAuthHandlerMock.mockResolvedValueOnce(new Response('upstream failed', { status: 500 }));
    const callbackRequest = new NextRequest(
      'https://www.boardsesh.com/api/auth/callback/google?state=google-state-3&code=provider-code',
      { headers: { Cookie: returnCookie!.split(';', 1)[0]! } },
    );

    const callbackResponse = await GET(callbackRequest, context);

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
      context,
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

    const callbackResponse = await GET(callbackRequest, context);

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
      context,
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

    const callbackResponse = await POST(callbackRequest, context);
    expect(callbackResponse.headers.get('Location')).toBe(returnUrl);
    expect(callbackResponse.headers.getSetCookie()).toContainEqual(
      expect.stringContaining('__Secure-next-auth.session-token=fresh'),
    );
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

    const response = await POST(lookalikeRequest, context);

    expect(response.headers.getSetCookie().some((setCookie) => setCookie.startsWith('boardsesh.oauth-return.'))).toBe(
      false,
    );
    expect(nextAuthHandlerMock).toHaveBeenCalledWith(lookalikeRequest, context);
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

    await expect(POST(signInRequest, context)).rejects.toThrow(
      'NEXTAUTH_SECRET is required to bind Expo web OAuth returns',
    );
  });
});
