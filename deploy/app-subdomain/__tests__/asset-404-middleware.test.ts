import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assetMiddlewareInternals, onRequest } from '../functions/_middleware';
import { effectiveHeaderValues, headerBlocks } from './cloudflare-config';

// Guards ../functions/_middleware.ts, which turns the SPA fallback's answer to a
// missing asset URL back into a 404. See that file's header for why `_redirects`
// cannot do this itself.

const BASE = 'https://app.boardsesh.com';

/** A fake Pages context whose `next()` returns a canned upstream response. */
function contextFor(pathname: string, upstream: Response) {
  let nextCalls = 0;
  return {
    context: {
      request: new Request(`${BASE}${pathname}`),
      next: async () => {
        nextCalls += 1;
        return upstream;
      },
    },
    nextCalls: () => nextCalls,
  };
}

/** What Cloudflare returns today when `/* /index.html 200` answers an asset URL. */
function spaFallbackResponse(): Response {
  return new Response('<!doctype html><html><body>shell</body></html>', {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}

function realAsset(contentType: string, cacheControl: string): Response {
  return new Response('console.log(1)', {
    status: 200,
    headers: { 'content-type': contentType, 'cache-control': cacheControl },
  });
}

describe('asset 404 middleware', () => {
  it('404s a missing chunk instead of serving the HTML shell', async () => {
    const { context } = contextFor('/_expo/static/js/web/entry-missing.js', spaFallbackResponse());
    const response = await onRequest(context);

    expect(response.status).toBe(404);
    expect(await response.text()).toContain('/_expo/static/js/web/entry-missing.js');
  });

  it('never lets that 404 be cached', async () => {
    // A cached 404 is the same year-long poisoning as the cached HTML it replaces.
    const { context } = contextFor('/_expo/static/js/web/entry-missing.js', spaFallbackResponse());
    const response = await onRequest(context);

    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('cache-control')).not.toMatch(/immutable|max-age=[1-9]/i);
  });

  it.each([
    ['/_expo/static/js/web/entry-abc123.js', 'application/javascript'],
    ['/assets/fonts/inter.ttf', 'font/ttf'],
    ['/wasm/board_renderer_wasm_bg.wasm', 'application/wasm'],
  ])('passes a real asset through untouched (%s)', async (pathname, contentType) => {
    const upstream = realAsset(contentType, 'public, max-age=31536000, immutable');
    const { context } = contextFor(pathname, upstream);
    const response = await onRequest(context);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(contentType);
    // Identity, not just equivalence: the normal path must not rebuild the body.
    expect(response).toBe(upstream);
  });

  it('re-asserts immutable caching if it ever goes missing', async () => {
    // The regression this covers: routing a path through a Function stops
    // `_headers` applying, and a ~10MB bundle silently becomes uncacheable.
    const { context } = contextFor(
      '/_expo/static/js/web/entry-abc123.js',
      realAsset('application/javascript', 'public, max-age=0, must-revalidate'),
    );
    const response = await onRequest(context);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(assetMiddlewareInternals.IMMUTABLE_CACHE_CONTROL);
  });

  it('does not force immutable onto /wasm/, which must revalidate', async () => {
    // Fixed filename: an immutable wasm binary would mask the next deploy.
    const upstream = realAsset('application/wasm', 'public, max-age=0, must-revalidate');
    const { context } = contextFor('/wasm/board_renderer_wasm_bg.wasm', upstream);
    const response = await onRequest(context);

    expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(response).toBe(upstream);
  });

  it('leaves non-asset paths entirely alone', async () => {
    // The shell legitimately is HTML; 404ing it would take the site down.
    const shell = spaFallbackResponse();
    const { context, nextCalls } = contextFor('/climbs', shell);
    const response = await onRequest(context);

    expect(response).toBe(shell);
    expect(response.status).toBe(200);
    expect(nextCalls()).toBe(1);
  });
});

describe('_routes.json', () => {
  const routes: { version: number; include: string[]; exclude: string[] } = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '..', '_routes.json'), 'utf8'),
  );

  it('routes exactly the asset prefixes the middleware handles', () => {
    // A prefix the middleware guards but _routes.json omits is an unprotected
    // path; the reverse is a Worker invocation on a path nothing inspects.
    const guarded = assetMiddlewareInternals.ASSET_PREFIXES.map((prefix) => `${prefix}*`);
    expect([...routes.include].sort()).toEqual([...guarded].sort());
  });

  it('does not route the shell or SPA deep links through the Function', () => {
    for (const staticPath of ['/', '/index.html', '/manifest.json', '/climbs']) {
      const routed = routes.include.some((pattern) =>
        pattern.endsWith('*') ? staticPath.startsWith(pattern.slice(0, -1)) : pattern === staticPath,
      );
      expect(routed, `${staticPath} must stay a static asset, with no Worker in the path`).toBe(false);
    }
  });

  it('stays inside Cloudflare limits', () => {
    expect(routes.version).toBe(1);
    expect(routes.include.length).toBeGreaterThan(0);
    expect(routes.include.length + routes.exclude.length).toBeLessThanOrEqual(100);
    for (const rule of [...routes.include, ...routes.exclude]) {
      expect(rule.length, `"${rule}" exceeds Cloudflare's 100-character rule limit`).toBeLessThanOrEqual(100);
    }
  });
});

describe('immutable prefix parity with _headers', () => {
  it('matches the prefixes _headers actually marks immutable', () => {
    // The middleware's fallback cache policy is a copy of `_headers`. Pin them
    // together so editing one alone fails here rather than in production.
    const immutableFromHeaders = headerBlocks
      .filter((block) => block.headers.get('Cache-Control')?.some((value) => /immutable/i.test(value)))
      .map((block) => block.path.replace(/\*$/, ''));

    expect([...immutableFromHeaders].sort()).toEqual([...assetMiddlewareInternals.IMMUTABLE_PREFIXES].sort());
  });

  it('agrees with _headers on the value it would re-assert', () => {
    const fromHeaders = effectiveHeaderValues('/_expo/static/js/web/entry-abc123.js', 'Cache-Control');
    expect(fromHeaders).toContain(assetMiddlewareInternals.IMMUTABLE_CACHE_CONTROL);
  });
});
