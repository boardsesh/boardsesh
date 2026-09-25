// The public climb-stats endpoint must never serve a spray wall.
//
// It is anonymous and CDN-cached under a key with no viewer in it, so a single
// fetch by anybody would publish a private wall's per-angle ascents, quality,
// setter grade and FA username to every later caller. It is also the one www
// route that takes `board_name` straight off the params without going through
// `parseBoardRouteParamsWithSlugs`, so the 404 the deep routes give had to be
// repeated here by hand — which is exactly the kind of guard that rots.

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const getClimbStatsForAllAngles = vi.fn(async () => [{ angle: 40, ascensionist_count: 3 }]);

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/data/queries', () => ({ getClimbStatsForAllAngles }));
vi.mock('@/app/lib/observability/request-logger', () => ({
  createRequestLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/app/lib/observability/report-error', () => ({ reportHandledError: vi.fn() }));

const { GET } = await import('../[board_name]/climb-stats/[climb_uuid]/route');

const CLIMB_UUID = 'ABCDEF1234567890ABCDEF1234567890';

const request = (boardName: string) =>
  GET(new Request(`https://boardsesh.com/api/v1/${boardName}/climb-stats/${CLIMB_UUID}`), {
    params: Promise.resolve({ board_name: boardName, climb_uuid: CLIMB_UUID }),
  });

beforeEach(() => {
  getClimbStatsForAllAngles.mockClear();
});

describe('GET /api/v1/[board_name]/climb-stats/[climb_uuid]', () => {
  it('404s for spray, without touching the database', async () => {
    const response = await request('spray');
    expect(response.status).toBe(404);
    expect(getClimbStatsForAllAngles).not.toHaveBeenCalled();
  });

  it('still serves a catalogue board', async () => {
    // Guards the guard: a handler that 404'd everything would pass the case above
    // for the wrong reason.
    const response = await request('kilter');
    expect(response.status).toBe(200);
    expect(getClimbStatsForAllAngles).toHaveBeenCalled();
  });
});
