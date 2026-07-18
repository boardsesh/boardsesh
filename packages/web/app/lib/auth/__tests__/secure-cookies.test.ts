import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendLegacyHostOnlySessionCookieClear,
  isSecureCookieContext,
  responseSetsSessionCookie,
  sessionCookieDomain,
  sessionCookieName,
} from '../secure-cookies';

// Pin every env the helpers read so values leaking in from the shell can't
// steer the branch under test.
function stubAuthEnv(
  overrides: Partial<Record<'AUTH_COOKIE_DOMAIN' | 'NEXTAUTH_URL' | 'VERCEL_ENV' | 'VERCEL_URL', string>>,
) {
  vi.stubEnv('AUTH_COOKIE_DOMAIN', overrides.AUTH_COOKIE_DOMAIN ?? '');
  vi.stubEnv('NEXTAUTH_URL', overrides.NEXTAUTH_URL ?? '');
  vi.stubEnv('VERCEL_ENV', overrides.VERCEL_ENV ?? '');
  vi.stubEnv('VERCEL_URL', overrides.VERCEL_URL ?? '');
}

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

describe('sessionCookieDomain', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('scopes to .boardsesh.com when serving the production www host', () => {
    stubAuthEnv({ NEXTAUTH_URL: 'https://www.boardsesh.com' });
    expect(sessionCookieDomain()).toBe('.boardsesh.com');
  });

  it('scopes to .boardsesh.com when serving the apex host', () => {
    stubAuthEnv({ NEXTAUTH_URL: 'https://boardsesh.com' });
    expect(sessionCookieDomain()).toBe('.boardsesh.com');
  });

  it('honours an explicit AUTH_COOKIE_DOMAIN override', () => {
    stubAuthEnv({ AUTH_COOKIE_DOMAIN: '.staging.boardsesh.com', NEXTAUTH_URL: 'http://localhost:3000' });
    expect(sessionCookieDomain()).toBe('.staging.boardsesh.com');
  });

  it('is undefined on http localhost dev', () => {
    stubAuthEnv({ NEXTAUTH_URL: 'http://localhost:3000' });
    expect(sessionCookieDomain()).toBeUndefined();
  });

  it('is undefined on a Vercel preview (VERCEL_URL set, not production, no NEXTAUTH_URL)', () => {
    // A `.boardsesh.com` Domain from a *.vercel.app response would be rejected
    // by the browser's domain-match check — preview login must stay host-only.
    stubAuthEnv({ VERCEL_ENV: 'preview', VERCEL_URL: 'boardsesh-abc123-marcodejonghs-projects.vercel.app' });
    expect(sessionCookieDomain()).toBeUndefined();
  });

  it('is undefined on a homelab preview host, keeping the prod cookie identity untouchable', () => {
    stubAuthEnv({ NEXTAUTH_URL: 'https://42.preview.boardsesh.com', VERCEL_ENV: '', VERCEL_URL: '' });
    expect(sessionCookieDomain()).toBeUndefined();
  });

  it('falls back to .boardsesh.com in Vercel production when NEXTAUTH_URL is omitted', () => {
    stubAuthEnv({ VERCEL_ENV: 'production', VERCEL_URL: 'boardsesh.vercel.app' });
    expect(sessionCookieDomain()).toBe('.boardsesh.com');
  });

  it('is undefined when NEXTAUTH_URL is unparseable', () => {
    stubAuthEnv({ NEXTAUTH_URL: 'not a url', VERCEL_ENV: 'preview' });
    expect(sessionCookieDomain()).toBeUndefined();
  });
});

describe('appendLegacyHostOnlySessionCookieClear', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('appends a Domain-less, Max-Age=0 deletion when the live cookie is Domain-scoped (prod)', () => {
    stubAuthEnv({ NEXTAUTH_URL: 'https://www.boardsesh.com', VERCEL_ENV: 'production' });
    const response = new Response(null);
    appendLegacyHostOnlySessionCookieClear(response);

    const setCookies = response.headers.getSetCookie();
    const cleared = setCookies.find((cookie) => cookie.startsWith('__Secure-next-auth.session-token=;'));
    expect(cleared).toBeDefined();
    expect(cleared).not.toMatch(/;\s*Domain=/i);
    expect(cleared).toMatch(/Max-Age=0/i);
    expect(cleared).toMatch(/Secure/);
  });

  it('is a no-op in dev, where the fresh cookie is itself host-only (same identity)', () => {
    // Appending the clear here would delete the login NextAuth just wrote:
    // cookie identity is name+domain+path, and with no cookie domain in play
    // the deletion targets the SAME cookie as the fresh write.
    stubAuthEnv({ NEXTAUTH_URL: 'http://localhost:3000' });
    const response = new Response(null);
    appendLegacyHostOnlySessionCookieClear(response);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('is a no-op on a Vercel preview even though the context is secure', () => {
    stubAuthEnv({ VERCEL_ENV: 'preview', VERCEL_URL: 'boardsesh-abc123-marcodejonghs-projects.vercel.app' });
    const response = new Response(null);
    appendLegacyHostOnlySessionCookieClear(response);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});
