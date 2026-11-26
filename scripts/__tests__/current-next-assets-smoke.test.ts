import { describe, expect, it, vi } from 'vitest';
import { checkCurrentNextAssets } from '../current-next-assets-smoke';

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn().mockResolvedValue(undefined) }));

const origin = 'https://web.fixture.test';
const release = 'ef'.repeat(20);
const chunk = '/_next/static/chunks/';
const sharedScript = chunk + 'shared.js';
const cache = 'public, max-age=31536000, immutable';

function document(route: string, extraHead = '') {
  const name = route === '/' ? 'home' : 'guide';
  return `<html><head><meta content='${release}' name="boardsesh-release">
    <!-- <script src="https://bad.test${chunk}comment.js"></script> -->
    <link rel="preconnect" href="https://assets.boardsesh.com">
    <link rel="preload" as="image" href="https://assets.boardsesh.com/static/v1/poster.webp">
    <script async src="https://static.cloudflareinsights.com/beacon.min.js"></script>
    <link rel="stylesheet" href="${chunk}${name}.css">
    <script>self.__next_f.push([1, '<link href="https://bad.test${chunk}flight.css">']);</script>
    <script src="${chunk}${name}.js?v=1&amp;x=2" async></script>
    <script src="${chunk}legacy.js" noModule></script>
    <script src="${sharedScript}" async></script>${extraHead}</head></html>`;
}

function html(body: string) {
  return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}
function asset(mime: string, cacheControl = cache, body: BodyInit = 'body') {
  return new Response(body, { headers: { 'content-type': mime, 'cache-control': cacheControl } });
}

function fixture(override?: (url: URL) => Response | undefined) {
  return vi.fn((url: URL, _init: RequestInit): Promise<Response> => {
    expect(url.origin).toBe(origin);
    const replacement = override?.(url);
    if (replacement) return Promise.resolve(replacement);
    if (url.pathname.startsWith(chunk)) {
      return Promise.resolve(
        asset(url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript; charset=utf-8'),
      );
    }
    return Promise.resolve(html(document(url.pathname)));
  });
}

describe('current Next assets deployment smoke', () => {
  it('checks both release markers and fetches distinct current scripts and styles without credentials', async () => {
    const fetchImpl = fixture();
    await checkCurrentNextAssets(origin, release, fetchImpl);
    expect(fetchImpl.mock.calls.map(([url]) => url.pathname + url.search)).toEqual([
      '/',
      sharedScript,
      chunk + 'home.css',
      '/apps/kilter',
      chunk + 'guide.js?v=1&x=2',
      chunk + 'guide.css',
    ]);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init).toEqual({
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        signal: expect.any(AbortSignal),
      });
    }
  });

  it.each([
    ['stale build', (page: string) => page.replace(release, '0'.repeat(40))],
    [
      'client-only release marker',
      (page: string) => page.replace(/<meta[^>]+>/, (tag) => '<script>html=' + JSON.stringify(tag) + '</script>'),
    ],
    [
      'off-origin legacy script',
      (page: string) => page.replace(chunk + 'legacy.js', '//assets.boardsesh.com' + chunk + 'legacy.js'),
    ],
    ['off-origin parser script', (page: string) => page.replace(sharedScript, '//assets.boardsesh.com' + sharedScript)],
    [
      'off-origin preload',
      (page: string) =>
        page.replace(
          '</head>',
          '<link rel="preload" as="script" href="https://assets.boardsesh.com' + sharedScript + '"></head>',
        ),
    ],
    ['off-origin base', (page: string) => page.replace('<head>', '<head><base href="https://assets.boardsesh.com">')],
    [
      'URL credentials',
      (page: string) => page.replace(sharedScript, 'https://fixture-user@web.fixture.test' + sharedScript),
    ],
    ['missing Next script', (page: string) => page.replace(/<script src="\/_next\/static[^"]*" async><\/script>/g, '')],
  ])('rejects %s on Kilter before fetching its assets', async (_name, change) => {
    const fetchImpl = fixture((url) =>
      url.pathname === '/apps/kilter' ? html(change(document(url.pathname))) : undefined,
    );
    await expect(checkCurrentNextAssets(origin, release, fetchImpl)).rejects.toThrow();
    expect(fetchImpl.mock.calls.at(-1)?.[0].pathname).toBe('/apps/kilter');
  });

  it.each([
    [
      'redirected current script',
      () => new Response(null, { status: 307, headers: { location: origin + sharedScript } }),
    ],
    [
      '200 with Location',
      () =>
        new Response('body', {
          headers: { location: origin + sharedScript, 'content-type': 'text/javascript', 'cache-control': cache },
        }),
    ],
    ['HTML in place of script', () => asset('text/html')],
    ['short TTL', () => asset('text/javascript', 'public, max-age=60, immutable')],
    ['private response', () => asset('text/javascript', cache + ', private')],
    ['empty script', () => asset('text/javascript', cache, '')],
    ['oversized decoded body', () => asset('text/javascript', cache, new Uint8Array(4 * 1024 * 1024 + 1))],
  ])('rejects %s', async (_name, response) => {
    const fetchImpl = fixture((url) => (url.pathname === sharedScript ? response() : undefined));
    await expect(checkCurrentNextAssets(origin, release, fetchImpl)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('checks the CSS response type and skips CSS fetches when the document has none', async () => {
    const fetchImpl = fixture((url) => {
      if (url.pathname === '/') return html(document('/').replace(/<link rel="stylesheet"[^>]+>/, ''));
      if (url.pathname.endsWith('.css')) return asset('text/javascript');
    });
    await expect(checkCurrentNextAssets(origin, release, fetchImpl)).rejects.toThrow(
      'stylesheet has an unexpected MIME',
    );
    expect(fetchImpl.mock.calls.map(([url]) => url.pathname)).not.toContain(chunk + 'home.css');
  });

  it('rejects oversized HTML before parsing any asset URL', async () => {
    const fetchImpl = fixture(() => html(document('/') + ' '.repeat(2 * 1024 * 1024)));
    await expect(checkCurrentNextAssets(origin, release, fetchImpl)).rejects.toThrow('size');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a 502 and a connection reset within the same resource deadline', async () => {
    const fetchImpl = fixture()
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockRejectedValueOnce(new TypeError('fetch failed'));
    await checkCurrentNextAssets(origin, release, fetchImpl);
    const attempts = fetchImpl.mock.calls.slice(0, 3);
    expect(attempts.map(([url]) => url.pathname)).toEqual(['/', '/', '/']);
    expect(new Set(attempts.map(([, init]) => init.signal)).size).toBe(1);
  });

  it('retries when the response stream breaks after its headers arrive', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError('interrupted'));
      },
    });
    const fetchImpl = fixture().mockResolvedValueOnce(
      new Response(stream, { headers: { 'content-type': 'text/html' } }),
    );
    await checkCurrentNextAssets(origin, release, fetchImpl);
    expect(fetchImpl.mock.calls.slice(0, 2).map(([url]) => url.pathname)).toEqual(['/', '/']);
  });

  it('stops after three transient failures', async () => {
    const fetchImpl = fixture(() => new Response(null, { status: 429 }));
    await expect(checkCurrentNextAssets(origin, release, fetchImpl)).rejects.toThrow('direct 200');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('validates the full release SHA and credential-free origin before a request', async () => {
    const fetchImpl = fixture();
    await expect(checkCurrentNextAssets(origin, 'ef', fetchImpl)).rejects.toThrow('full release SHA');
    await expect(checkCurrentNextAssets('https://private@web.fixture.test', release, fetchImpl)).rejects.toThrow(
      'web origin',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
