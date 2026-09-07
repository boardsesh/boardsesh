import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';
import { WEB_ORIGIN_HEADER } from '@/app/lib/web-origin';

const secret = 'test-origin-secret-with-at-least-32-characters';
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
    '/api/auth/session',
    '/api/internal/revalidate',
    '/_next/static/app.js',
    '/robots.txt',
    '/.well-known/assetlinks.json',
  ])('strips the secret before forwarding %s', (path) => {
    enableGuard();
    const response = middleware(request(path, secret));
    expect(response.status).toBe(200);
    expect(JSON.stringify([...response.headers])).not.toContain(secret);
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
  it('keeps staging disabled by default but still strips the secret', () => {
    vi.stubEnv('WEB_ORIGIN_VERIFY_ENABLED', '');
    const response = middleware(request('/robots.txt', secret));
    expect(response.status).toBe(200);
    expect(JSON.stringify([...response.headers])).not.toContain(secret);
  });
});
