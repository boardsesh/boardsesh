// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * The unlisted wall's photo redirect: fresh signature every time, cached
 * nowhere, and the same "not found" for a private wall as for no wall at all.
 */

vi.mock('server-only', () => ({}));

vi.mock('@/app/lib/observability/request-logger', () => ({
  createRequestLogger: () => ({ info: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/app/lib/auth/rate-limiter', () => ({
  checkRateLimit: vi.fn(() => ({ limited: false, retryAfterSeconds: 0 })),
  getClientIp: vi.fn(() => '203.0.113.7'),
}));

const fetchSprayWallPageData = vi.fn();
vi.mock('@/app/lib/spray/spray-wall-render-data.server', () => ({
  fetchSprayWallPageData: (...args: unknown[]) => fetchSprayWallPageData(...args),
}));

const { GET } = await import('../route');

function request(wallUuid: string) {
  return GET(new Request(`https://boardsesh.com/api/v1/spray-walls/${wallUuid}/photo`), {
    params: Promise.resolve({ wall_uuid: wallUuid }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/v1/spray-walls/[wall_uuid]/photo', () => {
  it('redirects to the signature the backend just minted, uncached', async () => {
    fetchSprayWallPageData.mockResolvedValue({
      photo: { url: 'https://private.example/wall.jpg?sig=fresh' },
      wall: { uuid: 'wall-1' },
    });

    const response = await request('wall-1');

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://private.example/wall.jpg?sig=fresh');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('404s a wall this anonymous read may not see', async () => {
    // What the backend answers for a private wall, a soft-deleted one and a
    // uuid that was never a wall: all null, all the same 404 here.
    fetchSprayWallPageData.mockResolvedValue(null);

    const response = await request('wall-1');

    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('502s a failed read rather than pinning a cacheable 404', async () => {
    fetchSprayWallPageData.mockRejectedValue(new Error('backend is wedged'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await request('wall-1');

    expect(response.status).toBe(502);
    expect(response.headers.get('cache-control')).toBe('no-store');

    consoleError.mockRestore();
  });
});
