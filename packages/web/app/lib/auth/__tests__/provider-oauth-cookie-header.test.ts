// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { isAcceptableProviderOAuthCookieHeader, isProviderOAuthRequest } from '../provider-oauth-cookie-header.server';

describe('isProviderOAuthRequest', () => {
  it.each([
    ['/api/auth/signin/google', []],
    ['/api/auth/callback/apple', []],
    ['/api/auth/signin/apple/', []],
    ['/api/auth/callback/google/extra', []],
    ['/api/auth/signin/%67oogle', ['signin', 'google']],
    ['/api/auth/callback/%61pple', ['callback', 'apple', 'extra']],
  ])('matches %s (segments %j)', (pathname, route) => {
    expect(isProviderOAuthRequest(pathname, route)).toBe(true);
  });

  it.each([
    ['/api/auth/session', ['session']],
    ['/api/auth/callback/credentials', ['callback', 'credentials']],
    ['/api/auth/signin/facebook', ['signin', 'facebook']],
    ['/api/auth/signout', ['signout']],
    ['/api/auth/signin/googlex', ['signin', 'googlex']],
    ['/api/auth/providers/google', ['providers', 'google']],
  ])('leaves %s alone', (pathname, route) => {
    expect(isProviderOAuthRequest(pathname, route)).toBe(false);
  });
});

describe('isAcceptableProviderOAuthCookieHeader', () => {
  it.each([null, '', 'a=1', 'a=1; b=2', 'a=1;;b=2', 'a=1; ', 'a=\t1', 'a=', '  =x', 'name=é'])(
    'accepts %j',
    (header) => {
      expect(isAcceptableProviderOAuthCookieHeader(header)).toBe(true);
    },
  );

  it.each(['=x', 'a=1; flag', 'a=1;bare', 'a=1\u0001', 'a=1\u007f', 'a=1\u001f'])('refuses %j', (header) => {
    expect(isAcceptableProviderOAuthCookieHeader(header)).toBe(false);
  });

  it('measures the 32 KiB limit in UTF-8 bytes', () => {
    const atLimit = `a=${'x'.repeat(32_766)}`;
    expect(Buffer.byteLength(atLimit)).toBe(32_768);
    expect(isAcceptableProviderOAuthCookieHeader(atLimit)).toBe(true);
    expect(isAcceptableProviderOAuthCookieHeader(`${atLimit}x`)).toBe(false);
    // 16,384 two-byte characters plus the name are over 32,768 bytes, not characters.
    expect(isAcceptableProviderOAuthCookieHeader(`a=${'é'.repeat(16_384)}`)).toBe(false);
  });

  it('counts every segment, blank ones included, against the 128 limit', () => {
    const pairs = (count: number) => Array.from({ length: count }, (_, index) => `c${index}=1`);
    expect(isAcceptableProviderOAuthCookieHeader(pairs(128).join('; '))).toBe(true);
    expect(isAcceptableProviderOAuthCookieHeader(pairs(129).join('; '))).toBe(false);
    // A trailing separator adds a 129th, empty segment.
    expect(isAcceptableProviderOAuthCookieHeader(`${pairs(128).join('; ')};`)).toBe(false);
  });
});
