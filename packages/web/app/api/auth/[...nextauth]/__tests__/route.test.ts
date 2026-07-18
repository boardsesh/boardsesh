import { beforeEach, describe, expect, it, vi } from 'vitest';
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
vi.mock('@/app/lib/auth/secure-cookies', () => ({
  isSecureCookieContext: () => true,
  sessionCookieName: () => '__Secure-next-auth.session-token',
  appendLegacyHostOnlySessionCookieClear: (response: Response) => {
    response.headers.append(
      'Set-Cookie',
      '__Secure-next-auth.session-token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure',
    );
  },
  responseSetsSessionCookie: (response: Response) => {
    const setCookies =
      typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : response.headers.get('set-cookie')
          ? [response.headers.get('set-cookie') as string]
          : [];
    return setCookies.some((setCookie) => {
      const [nameValuePair] = setCookie.split(';', 1);
      const separatorIndex = nameValuePair.indexOf('=');
      if (separatorIndex === -1) return false;
      return (
        nameValuePair.slice(0, separatorIndex).trim() === '__Secure-next-auth.session-token' &&
        nameValuePair.slice(separatorIndex + 1).trim().length > 0
      );
    });
  },
}));

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
    nextAuthHandlerMock.mockResolvedValue(new Response(null, { status: 200 }));
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
});
