// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { GET, POST } from '../route';

const catalog = vi.hoisted(() => ({
  readDevEntries: vi.fn().mockResolvedValue([]),
  saveDevTranslation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/app/lib/i18n/dev-catalog-store', () => ({ ...catalog, CatalogEditError: class extends Error {} }));

function request(
  method: 'GET' | 'POST',
  headers: Record<string, string> = {},
  body = '{}',
  origin = 'http://localhost:3000',
) {
  return new Request(`${origin}/api/internal/dev-translations?locale=en-US`, {
    method,
    headers: {
      host: new URL(origin).host,
      ...(method === 'POST' ? { origin, 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(method === 'POST' ? { body } : {}),
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('dev translation endpoint access', () => {
  it.each(['production', 'test'])('returns 404 in %s without touching files', async (environment) => {
    vi.stubEnv('NODE_ENV', environment);
    expect((await GET(request('GET'))).status).toBe(404);
    expect((await POST(request('POST'))).status).toBe(404);
    expect(catalog.readDevEntries).not.toHaveBeenCalled();
    expect(catalog.saveDevTranslation).not.toHaveBeenCalled();
  });

  it('allows same-origin localhost reads and writes in development', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const response = await GET(request('GET'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await POST(request('POST'))).status).toBe(200);
  });

  it.each<Record<string, string>>([
    { origin: 'https://evil.test' },
    { origin: 'null' },
    { origin: '' },
    { host: 'evil.test' },
    { 'sec-fetch-site': 'cross-site' },
  ])('rejects foreign or missing origin and invalid host: %j', async (headers) => {
    vi.stubEnv('NODE_ENV', 'development');
    expect((await POST(request('POST', headers))).status).toBe(403);
    expect(catalog.saveDevTranslation).not.toHaveBeenCalled();
  });

  it('rejects remote hostnames even with a matching origin', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect((await POST(request('POST', {}, '{}', 'http://dev.example:3000'))).status).toBe(403);
    expect(catalog.saveDevTranslation).not.toHaveBeenCalled();
  });

  it('allows only an exact configured dev hostname, with matching origin', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('DEV_ALLOWED_ORIGINS', 'dev.example, *.example');
    expect((await POST(request('POST', {}, '{}', 'https://dev.example:3000'))).status).toBe(200);
    expect((await POST(request('POST', {}, '{}', 'https://other.example:3000'))).status).toBe(403);
    expect(
      (await POST(request('POST', { origin: 'https://evil.test' }, '{}', 'https://dev.example:3000'))).status,
    ).toBe(403);
  });

  it('supports a configured browser Host when Next uses its internal bind URL', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('DEV_ALLOWED_ORIGINS', 'dev.example');
    expect((await POST(request('POST', { host: 'dev.example:3000', origin: 'http://dev.example:3000' }))).status).toBe(
      200,
    );
    expect(
      (await POST(request('POST', { host: 'evil.test:3000', 'x-forwarded-host': 'dev.example:3000' }))).status,
    ).toBe(403);
  });

  it('rejects oversized and malformed input before invoking the writer', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect((await POST(request('POST', {}, 'a'.repeat(65537)))).status).toBe(413);
    expect((await POST(request('POST', {}, '{broken'))).status).toBe(400);
    expect((await POST(request('POST', { 'content-type': 'text/plain' }))).status).toBe(415);
    expect(catalog.saveDevTranslation).not.toHaveBeenCalled();
  });
});
