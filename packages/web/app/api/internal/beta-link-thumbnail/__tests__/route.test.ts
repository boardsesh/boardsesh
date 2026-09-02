import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const PROXY_FLAG = 'BETA_LINK_THUMBNAIL_DEV_PROXY';
const ORIGINAL_FLAG = process.env[PROXY_FLAG];

function makeRequest(target?: string): NextRequest {
  const url = new URL('http://localhost:3000/api/internal/beta-link-thumbnail');
  if (target !== undefined) {
    url.searchParams.set('url', target);
  }
  return new NextRequest(url);
}

async function loadRoute() {
  // Re-import after env mutation so the module-scope reads pick up the change.
  vi.resetModules();
  return await import('../route');
}

describe('GET /api/internal/beta-link-thumbnail', () => {
  beforeEach(() => {
    // The proxy is fail-closed, so every test below that expects it to WORK has
    // to opt in explicitly — same as a developer's .env.local does.
    process.env[PROXY_FLAG] = 'enabled';
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env[PROXY_FLAG];
    else process.env[PROXY_FLAG] = ORIGINAL_FLAG;
    vi.unstubAllGlobals();
  });

  it('returns 410 when the opt-in flag is absent (fail-closed by default)', async () => {
    delete process.env[PROXY_FLAG];
    const route = await loadRoute();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const res = await route.GET(makeRequest('https://scontent.cdninstagram.com/foo.jpg'));

    expect(res.status).toBe(410);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 410 when the flag is set to anything other than "enabled"', async () => {
    process.env[PROXY_FLAG] = 'true';
    const route = await loadRoute();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const res = await route.GET(makeRequest('https://scontent.cdninstagram.com/foo.jpg'));

    expect(res.status).toBe(410);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stays disabled when only a storage variable is set (no longer coupled)', async () => {
    delete process.env[PROXY_FLAG];
    process.env.AWS_S3_BUCKET_NAME = 'production-bucket';
    try {
      const route = await loadRoute();
      const res = await route.GET(makeRequest('https://scontent.cdninstagram.com/foo.jpg'));
      expect(res.status).toBe(410);
    } finally {
      delete process.env.AWS_S3_BUCKET_NAME;
    }
  });

  it('returns 400 when ?url= is missing', async () => {
    const route = await loadRoute();
    const res = await route.GET(makeRequest());
    expect(res.status).toBe(400);
  });

  it('returns 400 when ?url= is malformed', async () => {
    const route = await loadRoute();
    const res = await route.GET(makeRequest('not a url'));
    expect(res.status).toBe(400);
  });

  it('returns 400 when ?url= is http:// (non-https)', async () => {
    const route = await loadRoute();
    const res = await route.GET(makeRequest('http://scontent.cdninstagram.com/foo.jpg'));
    expect(res.status).toBe(400);
  });

  it('returns 400 when host is not on the allowlist', async () => {
    const route = await loadRoute();
    const res = await route.GET(makeRequest('https://evil.example.com/foo.jpg'));
    expect(res.status).toBe(400);
  });

  it('returns 400 when host masquerades as a CDN suffix (e.g. tiktokcdn.com.evil.com)', async () => {
    const route = await loadRoute();
    const res = await route.GET(makeRequest('https://tiktokcdn.com.evil.com/foo.jpg'));
    expect(res.status).toBe(400);
  });

  it('proxies a valid Instagram CDN URL and forwards content-type + cache headers', async () => {
    const route = await loadRoute();
    const fetchSpy = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: new ReadableStream(),
      headers: new Headers({ 'content-type': 'image/jpeg' }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const res = await route.GET(makeRequest('https://scontent.cdninstagram.com/foo.jpg'));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600, s-maxage=86400');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init).toMatchObject({ redirect: 'error' });
  });

  it('proxies a valid TikTok CDN URL', async () => {
    const route = await loadRoute();
    const fetchSpy = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: new ReadableStream(),
      headers: new Headers({ 'content-type': 'image/webp' }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const res = await route.GET(makeRequest('https://p16-common-sign.tiktokcdn.com/x.jpg'));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
  });

  it('returns the upstream status when upstream is non-OK', async () => {
    const route = await loadRoute();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce({ ok: false, status: 503, body: null, headers: new Headers() }),
    );

    const res = await route.GET(makeRequest('https://scontent.cdninstagram.com/foo.jpg'));
    expect(res.status).toBe(503);
  });

  it('returns 502 when fetch throws (network error)', async () => {
    const route = await loadRoute();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('network down')));

    const res = await route.GET(makeRequest('https://scontent.cdninstagram.com/foo.jpg'));
    expect(res.status).toBe(502);
  });

  it('returns 502 when upstream redirects (redirect: error rejects)', async () => {
    const route = await loadRoute();
    // undici throws a TypeError when redirect: 'error' encounters a 30x.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('unexpected redirect')));

    const res = await route.GET(makeRequest('https://scontent.cdninstagram.com/foo.jpg'));
    expect(res.status).toBe(502);
  });
});
