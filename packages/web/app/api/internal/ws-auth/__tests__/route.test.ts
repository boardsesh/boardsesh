import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getTokenMock = vi.fn();
const decodeMock = vi.fn();
vi.mock('next-auth/jwt', () => ({
  getToken: (...args: unknown[]) => getTokenMock(...args),
  decode: (...args: unknown[]) => decodeMock(...args),
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
  const originalSecret = process.env.NEXTAUTH_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXTAUTH_SECRET = 'test-secret';
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.NEXTAUTH_SECRET;
    else process.env.NEXTAUTH_SECRET = originalSecret;
  });

  it('reads the raw JWE once and decrypts it once, without allowing it to be cached', async () => {
    getTokenMock.mockResolvedValue('encrypted-session-token');
    decodeMock.mockResolvedValue({ sub: 'user-1', authSessionId: 'login-1' });

    const response = await GET(request());

    await expect(response.json()).resolves.toEqual({
      token: 'encrypted-session-token',
      authenticated: true,
      userId: 'user-1',
      authSessionId: 'login-1',
    });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    // A single raw cookie read (no decrypt) and a single decode (one decrypt).
    expect(getTokenMock).toHaveBeenCalledTimes(1);
    expect(getTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({ raw: true, secureCookie: true, cookieName: '__Secure-next-auth.session-token' }),
    );
    expect(decodeMock).toHaveBeenCalledTimes(1);
    expect(decodeMock).toHaveBeenCalledWith(expect.objectContaining({ token: 'encrypted-session-token' }));
  });

  it('returns a no-store anonymous result when the cookie is absent', async () => {
    getTokenMock.mockResolvedValue(null);

    const response = await GET(request());

    await expect(response.json()).resolves.toEqual({ token: null, authenticated: false });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(getTokenMock).toHaveBeenCalledTimes(1);
    expect(decodeMock).not.toHaveBeenCalled();
  });

  it('does not expose a raw cookie whose decoded token has no subject', async () => {
    getTokenMock.mockResolvedValue('encrypted-session-token');
    decodeMock.mockResolvedValue({ name: 'No Subject' });

    const response = await GET(request());

    await expect(response.json()).resolves.toEqual({ token: null, authenticated: false });
    expect(decodeMock).toHaveBeenCalledTimes(1);
  });

  it('treats a malformed or expired cookie as anonymous instead of erroring', async () => {
    getTokenMock.mockResolvedValue('expired-session-token');
    decodeMock.mockRejectedValue(new Error('"exp" claim timestamp check failed'));

    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ token: null, authenticated: false });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('fails closed to anonymous and warns when NEXTAUTH_SECRET is missing', async () => {
    delete process.env.NEXTAUTH_SECRET;
    getTokenMock.mockResolvedValue('encrypted-session-token');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const response = await GET(request());

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ token: null, authenticated: false });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('NEXTAUTH_SECRET'));
      // Never attempt to decode without the secret.
      expect(decodeMock).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('keeps a valid pre-deploy cookie usable while its login identity is backfilled', async () => {
    getTokenMock.mockResolvedValue('legacy-encrypted-session-token');
    decodeMock.mockResolvedValue({ sub: 'user-1' });

    const response = await GET(request());

    await expect(response.json()).resolves.toEqual({
      token: 'legacy-encrypted-session-token',
      authenticated: true,
      userId: 'user-1',
    });
  });

  it('keeps failures private and non-cacheable', async () => {
    getTokenMock.mockRejectedValue(new Error('cookie read failed'));
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
