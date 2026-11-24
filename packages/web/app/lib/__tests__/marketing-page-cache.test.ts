import { describe, expect, it } from 'vite-plus/test';
import { isCacheableMarketingRequest, MARKETING_CACHE_PATHS, MARKETING_ROUTER_HEADERS } from '../marketing-page-cache';

const request = (pathname = '/', headers: Record<string, string> = {}, method = 'GET', search = '') => ({
  pathname,
  headers: new Headers(headers),
  method,
  search,
});

describe('marketing document eligibility', () => {
  it.each(MARKETING_CACHE_PATHS)('admits anonymous documents at %s', (pathname) => {
    expect(isCacheableMarketingRequest(request(pathname))).toBe(true);
    expect(isCacheableMarketingRequest(request(pathname, {}, 'HEAD'))).toBe(true);
  });
  it.each(['/es/', '/apps/unknown', '/apps/kilter/', '/auth/login', '/you', '/api/auth/session'])(
    'excludes %s',
    (pathname) => {
      expect(isCacheableMarketingRequest(request(pathname))).toBe(false);
    },
  );
  it.each(['?utm_source=search', '?_rsc=abc', '?invite=secret', '?session=abc'])('bypasses query %s', (search) => {
    expect(isCacheableMarketingRequest(request('/', {}, 'GET', search))).toBe(false);
  });
  it.each(['POST', 'OPTIONS', 'PUT'])('bypasses %s', (method) => {
    expect(isCacheableMarketingRequest(request('/', {}, method))).toBe(false);
  });
  it.each([
    'next-auth.session-token=secret',
    '__Secure-next-auth.session-token.0=secret',
    'boardsesh.session_token=secret',
    '__Secure-boardsesh.session_token.0=secret',
    'boardsesh.bridged_session_token=secret',
    '__Secure-boardsesh.bridged_session_token.0=secret',
  ])('bypasses session cookie %s', (cookie) => {
    expect(isCacheableMarketingRequest(request('/apps/kilter', { cookie }))).toBe(false);
  });
  it.each(['authorization', ...MARKETING_ROUTER_HEADERS])('bypasses %s even when empty', (header) => {
    expect(isCacheableMarketingRequest(request('/', { [header]: '' }))).toBe(false);
    expect(isCacheableMarketingRequest(request('/', { [header]: '1' }))).toBe(false);
  });
  it('preserves homepage language redirects but caches English-only guides', () => {
    expect(isCacheableMarketingRequest(request('/', { cookie: 'boardsesh-locale=es' }))).toBe(false);
    expect(isCacheableMarketingRequest(request('/apps/kilter', { cookie: 'boardsesh-locale=es' }))).toBe(true);
    expect(isCacheableMarketingRequest(request('/', { cookie: 'boardsesh-consent=yes' }))).toBe(true);
  });
});
