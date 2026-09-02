import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getTokenMock = vi.fn();
const decodeMock = vi.fn();
vi.mock('next-auth/jwt', () => ({
  getToken: (...args: unknown[]) => getTokenMock(...args),
  decode: (...args: unknown[]) => decodeMock(...args),
}));

// Real names, stubbed predicate: the route's job here is to try BOTH, and a
// stub that invented names would not prove that.
vi.mock('@/app/lib/auth/secure-cookies', () => ({
  isSecureCookieContext: () => true,
  sessionCookieNameCandidates: () => ['__Secure-next-auth.session-token', 'next-auth.session-token'],
}));

import { GET } from '../route';

function request(): NextRequest {
  return new NextRequest('https://www.boardsesh.com/api/internal/ws-auth');
}

/**
 * Captures what the route writes to stderr.
 *
 * The route logs through `createRequestLogger`, which writes straight to
 * `process.stderr` rather than through `console` — deliberately, because
 * Railway derives a line's severity from the stream it arrived on. Asserting on
 * the stream is therefore asserting the thing that matters; a `console.warn`
 * spy would pass even if the line went to stdout and showed up as info-level.
 */
function captureStderr() {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
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

  it('returns a no-store anonymous result when neither cookie name is present', async () => {
    getTokenMock.mockResolvedValue(null);

    const response = await GET(request());

    await expect(response.json()).resolves.toEqual({ token: null, authenticated: false });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    // Both names tried, and no decrypt on either — next-auth returns before
    // `decode` when the cookie is absent, so the fallback is free.
    expect(getTokenMock).toHaveBeenCalledTimes(2);
    expect(decodeMock).not.toHaveBeenCalled();
  });

  it('resolves a session stored under the other cookie name', async () => {
    // The #4651 safety net: a host change that flips isSecureCookieContext()
    // must not make a live session unreadable. Here the secure name misses and
    // the plain one hits.
    getTokenMock.mockResolvedValueOnce(null).mockResolvedValueOnce('plain-named-session-token');
    decodeMock.mockResolvedValue({ sub: 'user-1', authSessionId: 'login-1' });

    const response = await GET(request());

    await expect(response.json()).resolves.toEqual({
      token: 'plain-named-session-token',
      authenticated: true,
      userId: 'user-1',
      authSessionId: 'login-1',
    });
    expect(getTokenMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ cookieName: '__Secure-next-auth.session-token' }),
    );
    expect(getTokenMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ cookieName: 'next-auth.session-token' }));
    expect(decodeMock).toHaveBeenCalledTimes(1);
  });

  it('does not read the second name when the preferred one resolves', async () => {
    getTokenMock.mockResolvedValue('encrypted-session-token');
    decodeMock.mockResolvedValue({ sub: 'user-1' });

    await GET(request());

    expect(getTokenMock).toHaveBeenCalledTimes(1);
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
    const stderr = captureStderr();

    try {
      const response = await GET(request());

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ token: null, authenticated: false });
      // On stderr, at warn level, with the route bound as its own attribute.
      expect(stderr.lines.join('')).toContain('NEXTAUTH_SECRET');
      expect(stderr.lines.join('')).toContain('[warn]');
      expect(stderr.lines.join('')).toContain('/api/internal/ws-auth');
      // Never attempt to decode without the secret.
      expect(decodeMock).not.toHaveBeenCalled();
    } finally {
      stderr.restore();
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
    const stderr = captureStderr();

    try {
      const response = await GET(request());

      expect(response.status).toBe(500);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      await expect(response.json()).resolves.toEqual({
        token: null,
        authenticated: false,
        error: 'Failed to get token',
      });
      expect(stderr.lines.join('')).toContain('[error] Failed to read the WebSocket auth token');
      expect(stderr.lines.join('')).toContain('cookie read failed');
    } finally {
      stderr.restore();
    }
  });
});
