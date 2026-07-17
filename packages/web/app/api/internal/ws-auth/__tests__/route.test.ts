import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getTokenMock = vi.fn();
vi.mock('next-auth/jwt', () => ({
  getToken: (...args: unknown[]) => getTokenMock(...args),
}));

vi.mock('@/app/lib/auth/secure-cookies', () => ({
  isSecureCookieContext: () => true,
  sessionCookieName: () => '__Secure-next-auth.session-token',
}));

import { GET } from '../route';

function request(): NextRequest {
  return new NextRequest('https://www.boardsesh.com/api/internal/ws-auth');
}

describe('GET /api/internal/ws-auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the raw NextAuth JWE without allowing it to be cached', async () => {
    getTokenMock
      .mockResolvedValueOnce({ sub: 'user-1', authSessionId: 'login-1' })
      .mockResolvedValueOnce('encrypted-session-token');

    const response = await GET(request());

    await expect(response.json()).resolves.toEqual({
      token: 'encrypted-session-token',
      authenticated: true,
      userId: 'user-1',
      authSessionId: 'login-1',
    });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(getTokenMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        raw: false,
        secureCookie: true,
        cookieName: '__Secure-next-auth.session-token',
      }),
    );
    expect(getTokenMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        raw: true,
        secureCookie: true,
        cookieName: '__Secure-next-auth.session-token',
      }),
    );
  });

  it('returns a no-store anonymous result when the cookie is absent', async () => {
    getTokenMock.mockResolvedValue(null);

    const response = await GET(request());

    await expect(response.json()).resolves.toEqual({ token: null, authenticated: false });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(getTokenMock).toHaveBeenCalledTimes(1);
  });

  it('does not expose a raw cookie whose decoded token has no subject', async () => {
    getTokenMock.mockResolvedValue({ name: 'No Subject' });

    const response = await GET(request());

    await expect(response.json()).resolves.toEqual({ token: null, authenticated: false });
    expect(getTokenMock).toHaveBeenCalledTimes(1);
  });

  it('returns anonymous when a validated cookie cannot be read in raw form', async () => {
    getTokenMock.mockResolvedValueOnce({ sub: 'user-1', authSessionId: 'login-1' }).mockResolvedValueOnce(null);

    const response = await GET(request());

    await expect(response.json()).resolves.toEqual({ token: null, authenticated: false });
    expect(getTokenMock).toHaveBeenCalledTimes(2);
  });

  it('keeps a valid pre-deploy cookie usable while its login identity is backfilled', async () => {
    getTokenMock.mockResolvedValueOnce({ sub: 'user-1' }).mockResolvedValueOnce('legacy-encrypted-session-token');

    const response = await GET(request());

    await expect(response.json()).resolves.toEqual({
      token: 'legacy-encrypted-session-token',
      authenticated: true,
      userId: 'user-1',
    });
    expect(getTokenMock).toHaveBeenCalledTimes(2);
  });

  it('keeps failures private and non-cacheable', async () => {
    getTokenMock.mockRejectedValue(new Error('decode failed'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await GET(request());

      expect(response.status).toBe(500);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      await expect(response.json()).resolves.toEqual({
        token: null,
        authenticated: false,
        error: 'Failed to get token',
      });
    } finally {
      errorSpy.mockRestore();
    }
  });
});
