import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';
import { WEB_ORIGIN_HEADER } from '@/app/lib/web-origin';

const secret = 'a1'.repeat(32);
afterEach(() => vi.unstubAllEnvs());

function request(path: string, suppliedSecret?: string, method = 'GET') {
  return new NextRequest(`https://origin.up.railway.app${path}`, {
    method,
    headers: {
      cookie: 'boardsesh-locale=fr',
      ...(suppliedSecret ? { [WEB_ORIGIN_HEADER]: suppliedSecret } : {}),
    },
  });
}

function enableGuard() {
  vi.stubEnv('WEB_ORIGIN_VERIFY_ENABLED', '1');
  vi.stubEnv('WEB_ORIGIN_VERIFY_SECRET', secret);
}

describe('web origin protection', () => {
  it.each([
    '/',
    '/api/auth/session',
    '/api/internal/revalidate',
    '/_next/image?url=x',
    '/_next/static/app.js',
    '/robots.txt',
    '/foo/v1.5/bar',
    '/.well-known/assetlinks.json',
    '/monitoring',
    '/api/health/extra',
    '/fr/api/health',
  ])('rejects unauthenticated %s before routing', (path) => {
    enableGuard();
    const response = middleware(request(path));
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.has('location')).toBe(false);
  });
  it.each(['incorrect', `${secret}extra`, secret.slice(0, -1)])('rejects a mismatching secret', (suppliedSecret) => {
    enableGuard();
    expect(middleware(request('/', suppliedSecret)).status).toBe(403);
  });
  it.each(['a'.repeat(32), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64)])(
    'refuses a configured secret outside the shared lowercase-hex contract',
    (configuredSecret) => {
      enableGuard();
      vi.stubEnv('WEB_ORIGIN_VERIFY_SECRET', configuredSecret);
      expect(middleware(request('/', configuredSecret)).status).toBe(403);
    },
  );
  describe.each(['', '0', 'false'])('disabled flag %j', (flag) => {
    it.each(['/_next/static/app.js', '/_next/image?url=x', '/robots.txt'])(
      'forwards %s without rewriting headers when no secret header is present',
      (path) => {
        vi.stubEnv('WEB_ORIGIN_VERIFY_ENABLED', flag);
        const response = middleware(request(path));
        expect(response.status).toBe(200);
        expect(response.headers.get('x-middleware-next')).toBe('1');
        expect(response.headers.has('x-middleware-override-headers')).toBe(false);
        expect(response.headers.has('x-middleware-rewrite')).toBe(false);
        expect(response.headers.has('location')).toBe(false);
      },
    );
  });
  it('fails closed when enabled without a configured secret', () => {
    enableGuard();
    vi.stubEnv('WEB_ORIGIN_VERIFY_SECRET', '');
    expect(middleware(request('/')).status).toBe(403);
  });
  it.each(['GET', 'HEAD'])('allows the exact Railway health route for %s', (method) => {
    enableGuard();
    expect(middleware(request('/api/health', undefined, method)).status).toBe(200);
  });
  it('does not exempt POST health requests', () => {
    enableGuard();
    expect(middleware(request('/api/health', undefined, 'POST')).status).toBe(403);
  });
  it.each([
    '/fr/gyms',
    '/api/v1/grades/kilter',
    '/api/v1/angles/kilter/1',
    '/api/auth/session',
    '/api/internal/revalidate',
    '/_next/static/app.js',
    '/robots.txt',
    '/foo/v1.5/bar',
    '/.well-known/assetlinks.json',
  ])('strips the secret before forwarding %s', (path) => {
    enableGuard();
    const response = middleware(request(path, secret));
    expect(response.status).toBe(200);
    expect(JSON.stringify([...response.headers])).not.toContain(secret);
    // Next needs an explicit header override: a bare next() forwards the
    // original headers even though our routing Request was sanitized.
    expect(response.headers.get('x-middleware-override-headers')).toContain('cookie');
    expect(response.headers.get('x-middleware-override-headers')).not.toContain(WEB_ORIGIN_HEADER);
    if (path.includes('.')) expect(response.headers.has('x-middleware-rewrite')).toBe(false);
  });
  it('preserves request bodies and existing auth while stripping the header', async () => {
    enableGuard();
    const incoming = new NextRequest('https://origin.up.railway.app/api/internal/revalidate', {
      method: 'POST',
      body: 'payload',
      headers: { [WEB_ORIGIN_HEADER]: secret, authorization: 'Bearer user-token' },
    });
    const response = middleware(incoming);
    expect(response.headers.get('x-middleware-request-authorization')).toBe('Bearer user-token');
    expect(await incoming.text()).toBe('payload');
  });
  it.each(['', '0', 'false'])('keeps staging disabled for %j but still strips the secret', (flag) => {
    vi.stubEnv('WEB_ORIGIN_VERIFY_ENABLED', flag);
    const response = middleware(request('/robots.txt', secret));
    expect(response.status).toBe(200);
    expect(JSON.stringify([...response.headers])).not.toContain(secret);
  });
});
