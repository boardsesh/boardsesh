// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * The unlisted wall's photo redirect: fresh signature every time, cached
 * nowhere, and the same "not found" for a private wall as for no wall at all.
 */

vi.mock('server-only', () => ({}));

const logError = vi.fn();
vi.mock('@/app/lib/observability/request-logger', () => ({
  createRequestLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: logError }),
}));

vi.mock('@/app/lib/auth/rate-limiter', () => ({
  checkRateLimit: vi.fn(() => ({ limited: false, retryAfterSeconds: 0 })),
  getClientIp: vi.fn(() => '203.0.113.7'),
}));

const fetchSprayWallPhotoUrl = vi.fn(async (_wallUuid: string): Promise<string | null> => null);
const fetchSprayWallArtImageUrl = vi.fn(async (_wallUuid: string, _look: string): Promise<string | null> => null);
vi.mock('@/app/lib/spray/spray-wall-render-data.server', () => ({ fetchSprayWallPhotoUrl, fetchSprayWallArtImageUrl }));

const { GET } = await import('../route');

function request(wallUuid: string, query = '') {
  return GET(new Request(`https://boardsesh.com/api/v1/spray-walls/${wallUuid}/photo${query}`), {
    params: Promise.resolve({ wall_uuid: wallUuid }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/v1/spray-walls/[wall_uuid]/photo', () => {
  it('redirects to the signature the backend just minted, uncached', async () => {
    fetchSprayWallPhotoUrl.mockResolvedValue('https://private.example/wall.jpg?sig=fresh');

    const response = await request('wall-1');

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://private.example/wall.jpg?sig=fresh');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('404s a wall this anonymous read may not see', async () => {
    // What the backend answers for a private wall, a soft-deleted one and a
    // uuid that was never a wall: all null, all the same 404 here.
    fetchSprayWallPhotoUrl.mockResolvedValue(null);

    const response = await request('wall-1');

    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('502s a failed read rather than pinning a cacheable 404', async () => {
    fetchSprayWallPhotoUrl.mockRejectedValue(new Error('backend is wedged'));

    const response = await request('wall-1');

    expect(response.status).toBe(502);
    expect(response.headers.get('cache-control')).toBe('no-store');
    // A server fault goes out at `error` level, or a dashboard that filters by
    // level never sees the 502s this route is emitting.
    expect(logError).toHaveBeenCalledWith('spray wall photo read failed', expect.objectContaining({ status: 502 }));
  });

  it('redirects ?look= to that generated look, and never to the photo', async () => {
    fetchSprayWallArtImageUrl.mockResolvedValue('https://private.example/art/1-r1-cutout.webp?sig=fresh');

    const response = await request('wall-1', '?look=hold-cutouts');

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://private.example/art/1-r1-cutout.webp?sig=fresh');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(fetchSprayWallArtImageUrl).toHaveBeenCalledWith('wall-1', 'hold-cutouts');
    expect(fetchSprayWallPhotoUrl).not.toHaveBeenCalled();
  });

  it('404s a look that is not ready, and a look it does not know without asking the backend', async () => {
    fetchSprayWallArtImageUrl.mockResolvedValue(null);
    expect((await request('wall-1', '?look=wall-crop')).status).toBe(404);

    const unknown = await request('wall-1', '?look=blurred');
    expect(unknown.status).toBe(404);
    expect(fetchSprayWallArtImageUrl).toHaveBeenCalledTimes(1);
  });
});
