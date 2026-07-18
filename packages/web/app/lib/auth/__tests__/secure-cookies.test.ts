import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendLegacyHostOnlySessionCookieClear,
  isSecureCookieContext,
  responseSetsSessionCookie,
  sessionCookieName,
} from '../secure-cookies';

describe('isSecureCookieContext', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is true in Vercel production', () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    expect(isSecureCookieContext()).toBe(true);
  });

  it('is true when NEXTAUTH_URL is https', () => {
    vi.stubEnv('VERCEL_ENV', '');
    vi.stubEnv('VERCEL_URL', '');
    vi.stubEnv('NEXTAUTH_URL', 'https://www.boardsesh.com');
    expect(isSecureCookieContext()).toBe(true);
  });

  it('is false on http localhost with no Vercel context', () => {
    vi.stubEnv('VERCEL_ENV', '');
    vi.stubEnv('VERCEL_URL', '');
    vi.stubEnv('NEXTAUTH_URL', 'http://localhost:3000');
    expect(isSecureCookieContext()).toBe(false);
  });
});

describe('sessionCookieName', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('uses the __Secure- prefix in a secure context', () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    expect(sessionCookieName()).toBe('__Secure-next-auth.session-token');
  });

  it('drops the prefix in a non-secure context', () => {
    vi.stubEnv('VERCEL_ENV', '');
    vi.stubEnv('VERCEL_URL', '');
    vi.stubEnv('NEXTAUTH_URL', 'http://localhost:3000');
    expect(sessionCookieName()).toBe('next-auth.session-token');
  });
});

describe('responseSetsSessionCookie', () => {
  beforeEach(() => vi.stubEnv('VERCEL_ENV', 'production'));
  afterEach(() => vi.unstubAllEnvs());

  it('is true when a fresh (non-empty) session cookie is written', () => {
    const response = new Response(null, {
      headers: {
        'Set-Cookie': '__Secure-next-auth.session-token=fresh-jwt; Path=/; Domain=.boardsesh.com; HttpOnly; Secure',
      },
    });
    expect(responseSetsSessionCookie(response)).toBe(true);
  });

  it('is false for the sign-out deletion (empty value)', () => {
    const response = new Response(null, {
      headers: {
        'Set-Cookie': '__Secure-next-auth.session-token=; Path=/; Domain=.boardsesh.com; Max-Age=0; HttpOnly; Secure',
      },
    });
    expect(responseSetsSessionCookie(response)).toBe(false);
  });

  it('is false when no Set-Cookie header is present (a bare read)', () => {
    expect(responseSetsSessionCookie(new Response(null))).toBe(false);
  });

  it('is false when only an unrelated cookie is written', () => {
    const response = new Response(null, {
      headers: { 'Set-Cookie': 'other-cookie=value; Path=/' },
    });
    expect(responseSetsSessionCookie(response)).toBe(false);
  });

  it('finds the session cookie among multiple Set-Cookie headers', () => {
    const response = new Response(null);
    response.headers.append('Set-Cookie', 'csrf=abc; Path=/');
    response.headers.append('Set-Cookie', '__Secure-next-auth.session-token=fresh-jwt; Path=/; HttpOnly; Secure');
    expect(responseSetsSessionCookie(response)).toBe(true);
  });

  it('uses the non-prefixed name in a non-secure context', () => {
    vi.stubEnv('VERCEL_ENV', '');
    vi.stubEnv('VERCEL_URL', '');
    vi.stubEnv('NEXTAUTH_URL', 'http://localhost:3000');
    const response = new Response(null, {
      headers: { 'Set-Cookie': 'next-auth.session-token=fresh-jwt; Path=/; HttpOnly' },
    });
    expect(responseSetsSessionCookie(response)).toBe(true);
  });
});

describe('appendLegacyHostOnlySessionCookieClear', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('appends a Domain-less, Max-Age=0 deletion for the secure-context cookie name', () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    const response = new Response(null);
    appendLegacyHostOnlySessionCookieClear(response);

    const setCookies = response.headers.getSetCookie();
    const cleared = setCookies.find((cookie) => cookie.startsWith('__Secure-next-auth.session-token=;'));
    expect(cleared).toBeDefined();
    expect(cleared).not.toMatch(/;\s*Domain=/i);
    expect(cleared).toMatch(/Max-Age=0/i);
    expect(cleared).toMatch(/Secure/);
  });
});
