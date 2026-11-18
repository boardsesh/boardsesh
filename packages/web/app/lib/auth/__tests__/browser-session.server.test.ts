// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { NextRequest } from 'next/server';
vi.mock('server-only', () => ({}));
import { loginSessionCookies, withLegacyModeFirstPartyClears } from '../browser-session.server';

const secret = 'browser-session-unit-test-cookie-secret-00000001';
const written = (name: string) => expect.stringMatching(new RegExp(`^${name}=[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{43};`));

describe('loginSessionCookies', () => {
  it('on a Domain deployment clears the host-only login copy and the bridged name in both scopes, then writes', () => {
    expect(loginSessionCookies({ secret, secure: true, domain: '.boardsesh.com' }, 'token', [])).toEqual([
      '__Secure-boardsesh.session_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure',
      '__Secure-boardsesh.bridged_session_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure',
      '__Secure-boardsesh.bridged_session_token=; Path=/; Domain=.boardsesh.com; Max-Age=0; HttpOnly; SameSite=Lax; Secure',
      written('__Secure-boardsesh\\.session_token'),
    ]);
  });

  it('on a host-only https deployment never clears the login cookie it writes', () => {
    const cookies = loginSessionCookies({ secret, secure: true, domain: undefined }, 'token', []);
    expect(cookies).toEqual([
      '__Secure-boardsesh.bridged_session_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure',
      written('__Secure-boardsesh\\.session_token'),
    ]);
    expect(cookies.at(-1)).not.toContain('Domain=');
  });

  it('on local http writes the plain name and never clears it, while clearing a carried plain bridged copy', () => {
    const cookies = loginSessionCookies({ secret, secure: false, domain: undefined }, 'token', [
      'boardsesh.session_token',
      'boardsesh.bridged_session_token',
    ]);
    expect(cookies.filter((cookie) => cookie.startsWith('boardsesh.session_token=;'))).toEqual([]);
    expect(cookies).toContain('boardsesh.bridged_session_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
    expect(cookies.at(-1)).toEqual(written('boardsesh\\.session_token'));
    expect(cookies.at(-1)).not.toContain('Secure');
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
