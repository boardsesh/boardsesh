import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendLegacyHostOnlyOAuthFlowCookieClears,
  appendLegacyHostOnlySessionCookieClear,
  domainScopedCookieNames,
  isSecureCookieContext,
  oauthFlowCookieNames,
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

describe('oauthFlowCookieNames', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('matches the NextAuth names for every Domain-scoped flow cookie in a secure context', () => {
    stubAuthEnv({ NEXTAUTH_URL: 'https://www.boardsesh.com', VERCEL_ENV: 'production' });
    expect(oauthFlowCookieNames()).toEqual([
      '__Secure-next-auth.callback-url',
      '__Secure-next-auth.state',
      '__Secure-next-auth.nonce',
      // NextAuth stores the PKCE verifier under `pkce.code_verifier`, NOT
      // `pkceCodeVerifier` (next-auth/core/lib/cookie.js).
      '__Secure-next-auth.pkce.code_verifier',
    ]);
  });

  it('drops the prefix in a non-secure context', () => {
    stubAuthEnv({ NEXTAUTH_URL: 'http://localhost:3000' });
    expect(oauthFlowCookieNames()).toEqual([
      'next-auth.callback-url',
      'next-auth.state',
      'next-auth.nonce',
      'next-auth.pkce.code_verifier',
    ]);
  });

  it('never targets the __Host- CSRF cookie, which cannot carry a Domain', () => {
    stubAuthEnv({ NEXTAUTH_URL: 'https://www.boardsesh.com', VERCEL_ENV: 'production' });
    expect(oauthFlowCookieNames().some((name) => name.includes('csrf'))).toBe(false);
    expect(oauthFlowCookieNames().some((name) => name.startsWith('__Host-'))).toBe(false);
  });

  it('never targets the session token, which has its own clear', () => {
    stubAuthEnv({ NEXTAUTH_URL: 'https://www.boardsesh.com', VERCEL_ENV: 'production' });
    expect(oauthFlowCookieNames()).not.toContain(sessionCookieName());
  });

  // The sweep and auth-options' `cookies` block both read
  // domainScopedCookieNames(), so a rename lands in both at once. This pins the
  // relationship: the flow names are exactly that set minus the session token.
  it('is exactly the Domain-scoped cookie set minus the session token', () => {
    stubAuthEnv({ NEXTAUTH_URL: 'https://www.boardsesh.com', VERCEL_ENV: 'production' });
    const { sessionToken, ...flowCookies } = domainScopedCookieNames();
    expect(sessionToken).toBe(sessionCookieName());
    expect([...oauthFlowCookieNames()].sort()).toEqual(Object.values(flowCookies).sort());
  });
});

describe('appendLegacyHostOnlyOAuthFlowCookieClears', () => {
  afterEach(() => vi.unstubAllEnvs());

  function clearedCookieNames(response: Response): string[] {
    return response.headers.getSetCookie().map((setCookie) => setCookie.split('=', 1)[0] ?? '');
  }

  it('emits one Domain-less, Max-Age=0 deletion per Domain-scoped flow cookie in prod', () => {
    stubAuthEnv({ NEXTAUTH_URL: 'https://www.boardsesh.com', VERCEL_ENV: 'production' });
    const response = new Response(null);
    appendLegacyHostOnlyOAuthFlowCookieClears(response);

    const setCookies = response.headers.getSetCookie();
    expect(setCookies).toHaveLength(4);
    expect(clearedCookieNames(response)).toEqual([
      '__Secure-next-auth.callback-url',
      '__Secure-next-auth.state',
      '__Secure-next-auth.nonce',
      '__Secure-next-auth.pkce.code_verifier',
    ]);
    for (const setCookie of setCookies) {
      // No Domain attribute is the whole mechanism: it targets the legacy
      // host-only entry and cannot touch the Domain-scoped cookie.
      expect(setCookie).not.toMatch(/;\s*Domain=/i);
      expect(setCookie).toMatch(/Max-Age=0/i);
      expect(setCookie).toMatch(/HttpOnly/);
      expect(setCookie).toMatch(/Secure/);
      // Empty value — a deletion, never a fresh write.
      expect(setCookie.split(';', 1)[0]).toMatch(/=$/);
    }
  });

  it('clears callback-url, the only flow cookie whose legacy copy can still be in the jar', () => {
    // state and pkce.code_verifier get a 15-minute `expires` from NextAuth's
    // signCookie (core/lib/oauth/checks.js) — auth-options drops the
    // defaultCookies maxAge, signCookie's STATE_MAX_AGE/PKCE_MAX_AGE fallback
    // supplies the bound — so any pre-#3775 host-only copy expired long ago.
    // nonce is never written by this deployment (no provider enables the nonce
    // check). callback-url gets neither, so it is the one leftover a sweep can
    // actually find.
    stubAuthEnv({ NEXTAUTH_URL: 'https://www.boardsesh.com', VERCEL_ENV: 'production' });
    const response = new Response(null);
    appendLegacyHostOnlyOAuthFlowCookieClears(response);
    expect(clearedCookieNames(response)).toContain('__Secure-next-auth.callback-url');
  });

  it('never touches the __Host- CSRF cookie', () => {
    stubAuthEnv({ NEXTAUTH_URL: 'https://www.boardsesh.com', VERCEL_ENV: 'production' });
    const response = new Response(null);
    appendLegacyHostOnlyOAuthFlowCookieClears(response);
    expect(response.headers.getSetCookie().some((setCookie) => setCookie.includes('csrf'))).toBe(false);
    expect(response.headers.getSetCookie().some((setCookie) => setCookie.startsWith('__Host-'))).toBe(false);
  });

  it('never touches the session cookie, whose clear is gated on a fresh write', () => {
    stubAuthEnv({ NEXTAUTH_URL: 'https://www.boardsesh.com', VERCEL_ENV: 'production' });
    const response = new Response(null);
    appendLegacyHostOnlyOAuthFlowCookieClears(response);
    expect(clearedCookieNames(response)).not.toContain('__Secure-next-auth.session-token');
  });

  it('is a no-op in dev, where the live flow cookies are themselves host-only', () => {
    // Same load-bearing guard as the session clear: with no cookie domain the
    // deletion would target the LIVE state/pkce/callback-url and break sign-in.
    stubAuthEnv({ NEXTAUTH_URL: 'http://localhost:3000' });
    const response = new Response(null);
    appendLegacyHostOnlyOAuthFlowCookieClears(response);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('is a no-op on a Vercel preview even though the context is secure', () => {
    stubAuthEnv({ VERCEL_ENV: 'preview', VERCEL_URL: 'boardsesh-abc123-marcodejonghs-projects.vercel.app' });
    const response = new Response(null);
    appendLegacyHostOnlyOAuthFlowCookieClears(response);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('is a no-op on a homelab preview host', () => {
    stubAuthEnv({ NEXTAUTH_URL: 'https://42.preview.boardsesh.com' });
    const response = new Response(null);
    appendLegacyHostOnlyOAuthFlowCookieClears(response);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('appends alongside an existing session-cookie clear without replacing it', () => {
    stubAuthEnv({ NEXTAUTH_URL: 'https://www.boardsesh.com', VERCEL_ENV: 'production' });
    const response = new Response(null);
    appendLegacyHostOnlySessionCookieClear(response);
    appendLegacyHostOnlyOAuthFlowCookieClears(response);
    expect(response.headers.getSetCookie()).toHaveLength(5);
    expect(clearedCookieNames(response)).toContain('__Secure-next-auth.session-token');
  });
});
