import { describe, expect, it, vi } from 'vitest';
import { MARKETING_WARM_PATHS, warmMarketingPages } from './warm-marketing-pages';

const RELEASE = 'a'.repeat(40);
const DOCUMENT = `<meta name="boardsesh-release" content="${RELEASE}"/><h1>Boardsesh</h1>`;
const requestUrl = (request: string | URL | Request): string =>
  request instanceof Request ? request.url : request.toString();

describe('marketing deployment warm-up', () => {
  it('refuses to warm documents before the public origin serves the expected release', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ release: 'b'.repeat(40) }));
    await expect(warmMarketingPages(RELEASE, fetchImpl)).rejects.toThrow(/not serving/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reads each exact anonymous document twice without credentials or query strings', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
      requestUrl(url).endsWith('/api/health')
        ? Response.json({ release: RELEASE })
        : new Response(DOCUMENT, {
            headers: { 'content-type': 'text/html', 'cache-control': 'public, s-maxage=300' },
          }),
    );
    await warmMarketingPages(RELEASE, fetchImpl);
    expect(fetchImpl.mock.calls.map(([url]) => new URL(requestUrl(url)).pathname)).toEqual([
      '/api/health',
      ...MARKETING_WARM_PATHS.flatMap((pathname) => [pathname, pathname]),
    ]);
    for (const [request, init] of fetchImpl.mock.calls) {
      const url = new URL(requestUrl(request));
      expect(url.origin).toBe('https://www.boardsesh.com');
      expect(url.search).toBe('');
      expect(init?.redirect).toBe('error');
      const headers = new Headers(init?.headers);
      for (const header of ['cookie', 'authorization', 'rsc', 'next-router-state-tree', 'next-router-prefetch']) {
        expect(headers.has(header)).toBe(false);
      }
    }
  });

  it('reports stale cached documents as skipped even when origin health is current', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      requestUrl(url).endsWith('/api/health')
        ? Response.json({ release: RELEASE })
        : new Response(DOCUMENT.replace(RELEASE, 'b'.repeat(40)), {
            headers: { 'content-type': 'text/html', 'cache-control': 'public, s-maxage=300', 'cf-cache-status': 'HIT' },
          }),
    );
    try {
      await warmMarketingPages(RELEASE, fetchImpl);
      expect(warning).toHaveBeenCalledTimes(MARKETING_WARM_PATHS.length);
      expect(fetchImpl).toHaveBeenCalledTimes(1 + MARKETING_WARM_PATHS.length);
    } finally {
      warning.mockRestore();
    }
  });

  it.each<Record<string, string>>([
    { 'set-cookie': 'session=private' },
    { 'cache-control': 'private, no-store' },
    { 'content-type': 'text/x-component' },
    { 'cdn-cache-control': 'no-store' },
    { 'cloudflare-cdn-cache-control': 's-maxage=0' },
  ])('refuses unsafe document responses: %j', async (headers) => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      requestUrl(url).endsWith('/api/health')
        ? Response.json({ release: RELEASE })
        : new Response('<h1>Boardsesh</h1>', {
            headers: { 'content-type': 'text/html', 'cache-control': 'public, s-maxage=300', ...headers },
          }),
    );
    await expect(warmMarketingPages(RELEASE, fetchImpl)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects a partial document even if its start contains the expected metadata', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      requestUrl(url).endsWith('/api/health')
        ? Response.json({ release: RELEASE })
        : new Response(DOCUMENT, {
            status: 206,
            headers: { 'content-type': 'text/html', 'cache-control': 'public, s-maxage=300' },
          }),
    );
    await expect(warmMarketingPages(RELEASE, fetchImpl)).rejects.toThrow(/Unexpected document/);
  });
});
