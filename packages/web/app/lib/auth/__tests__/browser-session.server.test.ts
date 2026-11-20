// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { NextRequest } from 'next/server';
vi.mock('server-only', () => ({}));
import { viewerMarkerValue } from '@boardsesh/auth-protocol/browser-session-cookie';
import {
  bridgedSessionCookies,
  loginSessionCookies,
  signOutBrowserSessionCookieClears,
  withLegacyModeFirstPartyClears,
  withoutSessionSetCookies,
} from '../browser-session.server';

const secret = 'browser-session-unit-test-cookie-secret-00000001';
const sessionId = 'login-session-id-1';
const written = (name: string) => expect.stringMatching(new RegExp(`^${name}=[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{43};`));
const marker = viewerMarkerValue(sessionId);

describe('loginSessionCookies', () => {
  it('on a Domain deployment clears the host-only login and marker copies and the bridged name, then writes both', () => {
    expect(loginSessionCookies({ secret, secure: true, domain: '.boardsesh.com' }, 'token', sessionId, [])).toEqual([
      '__Secure-boardsesh.session_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure',
      '__Secure-boardsesh.bridged_session_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure',
      '__Secure-boardsesh.bridged_session_token=; Path=/; Domain=.boardsesh.com; Max-Age=0; HttpOnly; SameSite=Lax; Secure',
      '__Secure-boardsesh.viewer=; Path=/; Max-Age=0; SameSite=Lax; Secure',
      written('__Secure-boardsesh\\.session_token'),
      `__Secure-boardsesh.viewer=${marker}; Path=/; Domain=.boardsesh.com; Max-Age=34560000; SameSite=Lax; Secure`,
    ]);
  });

  it('on a host-only https deployment never clears the login cookie or the marker it writes', () => {
    const cookies = loginSessionCookies({ secret, secure: true, domain: undefined }, 'token', sessionId, []);
    expect(cookies).toEqual([
      '__Secure-boardsesh.bridged_session_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure',
      written('__Secure-boardsesh\\.session_token'),
      `__Secure-boardsesh.viewer=${marker}; Path=/; Max-Age=34560000; SameSite=Lax; Secure`,
    ]);
    expect(cookies.at(-2)).not.toContain('Domain=');
  });

  it('on local http writes the plain names and never clears them, while clearing a carried plain bridged copy', () => {
    const cookies = loginSessionCookies({ secret, secure: false, domain: undefined }, 'token', sessionId, [
      'boardsesh.session_token',
      'boardsesh.bridged_session_token',
      'boardsesh.viewer',
    ]);
    expect(cookies.filter((cookie) => cookie.startsWith('boardsesh.session_token=;'))).toEqual([]);
    expect(cookies.filter((cookie) => cookie.startsWith('boardsesh.viewer=;'))).toEqual([]);
    expect(cookies).toContain('boardsesh.bridged_session_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
    expect(cookies.at(-2)).toEqual(written('boardsesh\\.session_token'));
    expect(cookies.at(-1)).toBe(`boardsesh.viewer=${marker}; Path=/; Max-Age=34560000; SameSite=Lax`);
  });
});

describe('bridgedSessionCookies', () => {
  it('clears a host-only marker copy, then writes the bridged cookie and the marker in its scope', () => {
    expect(
      bridgedSessionCookies({ secret, secure: true, domain: '.boardsesh.com' }, 'token', sessionId, {
        replacesLoginCookie: false,
      }),
    ).toEqual([
      // A marker left in the other scope would read as two differing copies (review of #7810, L6).
      '__Secure-boardsesh.viewer=; Path=/; Max-Age=0; SameSite=Lax; Secure',
      written('__Secure-boardsesh\\.bridged_session_token'),
      `__Secure-boardsesh.viewer=${marker}; Path=/; Domain=.boardsesh.com; Max-Age=34560000; SameSite=Lax; Secure`,
    ]);
  });

  it('on a host-only deployment never clears the marker it writes', () => {
    const cookies = bridgedSessionCookies({ secret, secure: true, domain: undefined }, 'token', sessionId, {
      replacesLoginCookie: false,
    });
    expect(cookies).toEqual([
      written('__Secure-boardsesh\\.bridged_session_token'),
      `__Secure-boardsesh.viewer=${marker}; Path=/; Max-Age=34560000; SameSite=Lax; Secure`,
    ]);
  });

  it('clears the login name it replaces and writes the marker last', () => {
    const cookies = bridgedSessionCookies({ secret, secure: true, domain: '.boardsesh.com' }, 'token', sessionId, {
      replacesLoginCookie: true,
    });
    expect(cookies.slice(0, 2)).toEqual([
      '__Secure-boardsesh.session_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure',
      '__Secure-boardsesh.session_token=; Path=/; Domain=.boardsesh.com; Max-Age=0; HttpOnly; SameSite=Lax; Secure',
    ]);
    expect(cookies.at(-1)).toBe(
      `__Secure-boardsesh.viewer=${marker}; Path=/; Domain=.boardsesh.com; Max-Age=34560000; SameSite=Lax; Secure`,
    );
  });
});

describe('signOutBrowserSessionCookieClears', () => {
  it('clears the marker in both scopes with the session cookies', () => {
    const clears = signOutBrowserSessionCookieClears({ secret, secure: true, domain: '.boardsesh.com' }, []);
    expect(clears.slice(-2)).toEqual([
      '__Secure-boardsesh.viewer=; Path=/; Max-Age=0; SameSite=Lax; Secure',
      '__Secure-boardsesh.viewer=; Path=/; Domain=.boardsesh.com; Max-Age=0; SameSite=Lax; Secure',
    ]);
  });
});

describe('withoutSessionSetCookies', () => {
  it('strips the marker in either spelling like a session cookie, and keeps the rest in order', () => {
    const response = new Response(null);
    for (const header of [
      'next-auth.csrf-token=csrf; Path=/',
      `__Secure-boardsesh.viewer=${marker}; Path=/; Max-Age=34560000; SameSite=Lax; Secure`,
      'boardsesh.viewer=; Path=/; Max-Age=0; SameSite=Lax',
      'next-auth.callback-url=x; Path=/',
    ])
      response.headers.append('Set-Cookie', header);
    expect(withoutSessionSetCookies(response).headers.getSetCookie()).toEqual([
      'next-auth.csrf-token=csrf; Path=/',
      'next-auth.callback-url=x; Path=/',
    ]);
  });
});

describe('withLegacyModeFirstPartyClears', () => {
  afterEach(() => vi.unstubAllEnvs());
  const loginReply = () =>
    new Response(null, { headers: { 'Set-Cookie': 'next-auth.session-token=jwe; Path=/; HttpOnly' } });
  const requestWith = (cookie: string) =>
    new NextRequest('http://localhost:3000/api/auth/callback/credentials', { headers: { cookie } });

  it('never throws, and leaves the reply alone, when the codec refuses the cookie domain', () => {
    vi.stubEnv('NEXTAUTH_URL', 'http://localhost:3000');
    vi.stubEnv('AUTH_COOKIE_DOMAIN', '.boardsesh.com');
    const reply = withLegacyModeFirstPartyClears(
      requestWith('boardsesh.session_token=stale'),
      'callback',
      loginReply(),
    );
    expect(reply.headers.getSetCookie()).toEqual(['next-auth.session-token=jwe; Path=/; HttpOnly']);
  });

  it('clears the plain first-party names it carried on local http', () => {
    vi.stubEnv('NEXTAUTH_URL', 'http://localhost:3000');
    vi.stubEnv('AUTH_COOKIE_DOMAIN', '');
    vi.stubEnv('VERCEL_ENV', '');
    vi.stubEnv('VERCEL_URL', '');
    const reply = withLegacyModeFirstPartyClears(
      requestWith('boardsesh.session_token=stale'),
      'callback',
      loginReply(),
    );
    expect(reply.headers.getSetCookie()).toContain(
      'boardsesh.session_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
    );
    // The marker is cleared with them, and never written in legacy mode.
    expect(reply.headers.getSetCookie()).toContain(
      '__Secure-boardsesh.viewer=; Path=/; Max-Age=0; SameSite=Lax; Secure',
    );
    expect(reply.headers.getSetCookie().filter((header) => /viewer=[^;]/.test(header))).toEqual([]);
  });

  it('touches neither a session read nor a request without a first-party cookie', () => {
    expect(
      withLegacyModeFirstPartyClears(
        requestWith('boardsesh.session_token=stale'),
        'session',
        loginReply(),
      ).headers.getSetCookie(),
    ).toHaveLength(1);
    expect(
      withLegacyModeFirstPartyClears(requestWith('other=1'), 'callback', loginReply()).headers.getSetCookie(),
    ).toHaveLength(1);
  });
});
