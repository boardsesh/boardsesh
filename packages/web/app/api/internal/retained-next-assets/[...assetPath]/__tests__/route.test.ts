import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { STATIC_ASSET_ORIGIN } from '@boardsesh/static-assets';
import { GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS } from '../route';

const context = (assetPath: string[]) => ({ params: Promise.resolve({ assetPath }) });

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_RETAINED_NEXT_ASSETS', '1');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('missing retained Next asset redirect', () => {
  it.each([
    ['development', '1'],
    ['test', '1'],
    ['production', undefined],
    ['production', '0'],
  ])('does not enable direct redirects for an unopted build: %s/%s', async (runtime, optIn) => {
    vi.stubEnv('NODE_ENV', runtime);
    vi.stubEnv('NEXT_PUBLIC_RETAINED_NEXT_ASSETS', optIn);
    const response = await GET(new Request('https://preview.example/'), context(['chunks', 'old.js']));
    expect(response.status).toBe(404);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('does not forward private headers, a query or an upstream request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const request = new Request('https://direct.up.railway.app/_next/static/chunks/old.js?invite=private', {
      headers: {
        cookie: 'session=private',
        authorization: 'Bearer private',
        referer: 'https://www.boardsesh.com/?invite=private',
      },
    });
    const response = await GET(request, context(['chunks', 'old.js']));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(`${STATIC_ASSET_ORIGIN}/_next/static/chunks/old.js`);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('cdn-cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-robots-tag')).toBe('noindex, follow');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.text()).toBe('');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves decoded spaces and route brackets as path bytes', async () => {
    const response = await GET(
      new Request('https://www.boardsesh.com/'),
      context(['chunks', 'app', '[slug]', 'page file.js']),
    );
    expect(response.headers.get('location')).toBe(
      `${STATIC_ASSET_ORIGIN}/_next/static/chunks/app/%5Bslug%5D/page%20file.js`,
    );
  });

  it.each([
    [],
    ['chunks', '..', 'private.js'],
    ['chunks', '.'],
    ['chunks', ''],
    ['chunks', 'nested/file.js'],
    ['chunks', 'nested\\file.js'],
    ['chunks', '%2e%2e'],
    ['chunks', 'source.js.map'],
    ['chunks', 'source.js.MAP'],
    ['chunks', String.fromCharCode(0)],
    ['chunks', String.fromCharCode(31)],
    ['chunks', 'a'.repeat(2049)],
    Array.from({ length: 65 }, () => 'part'),
  ])('rejects unsafe or unpublished segments %j without caching', async (...segments: string[]) => {
    const response = await GET(new Request('https://www.boardsesh.com/'), context(segments));
    expect(response.status).toBe(404);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('keeps URL punctuation inside the fixed asset namespace', async () => {
    const response = await GET(
      new Request('https://www.boardsesh.com/'),
      context(['https:', 'other.example', 'file.js?secret=1#part']),
    );
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.origin).toBe(STATIC_ASSET_ORIGIN);
    expect(location.search).toBe('');
    expect(location.hash).toBe('');
    expect(location.pathname).toContain('/_next/static/https%3A/other.example/');
  });

  it('answers HEAD with the same empty, non-cacheable redirect', async () => {
    const response = await HEAD(
      new Request('https://www.boardsesh.com/', { method: 'HEAD' }),
      context(['media', 'old.woff2']),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(`${STATIC_ASSET_ORIGIN}/_next/static/media/old.woff2`);
    expect(await response.text()).toBe('');
  });

  it.each([
    ['content-length', '1'],
    ['content-length', 'invalid'],
    ['transfer-encoding', 'chunked'],
  ])('does not redirect a GET carrying a request body: %s/%s', async (headerName, headerValue) => {
    const response = await GET(
      new Request('https://www.boardsesh.com/', { headers: { [headerName]: headerValue } }),
      context(['chunks', 'old.js']),
    );
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it.each([POST, PUT, PATCH, DELETE, OPTIONS])('does not redirect unsupported methods', async (handler) => {
    const response = handler();
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
});
