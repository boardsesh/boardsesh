// @vitest-environment node
import { describe, expect, it, vi } from 'vite-plus/test';
vi.mock('server-only', () => ({}));
import { loginSessionCookies } from '../browser-session.server';

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
