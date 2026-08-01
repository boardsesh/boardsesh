import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { NextResponse } from 'next/server';
import { GET } from '../route';

// Mock the rate limiter so we can drive both the allowed and limited paths.
const mockEnforcePublicApiRateLimit = vi.fn();
vi.mock('@/app/lib/public-api-rate-limit.server', () => ({
  enforcePublicApiRateLimit: (...args: unknown[]) => mockEnforcePublicApiRateLimit(...args),
}));

// Mock the data layer — the route's only job here is rate-limit + cache headers.
const mockGetClimbStatsForAllAngles = vi.fn();
vi.mock('@/app/lib/data/queries', () => ({
  getClimbStatsForAllAngles: (...args: unknown[]) => mockGetClimbStatsForAllAngles(...args),
}));

function callGet() {
  const req = new Request('http://localhost/api/v1/kilter/climb-stats/CLIMB-1');
  return GET(req, { params: Promise.resolve({ board_name: 'kilter', climb_uuid: 'CLIMB-1' }) });
}

describe('GET /api/v1/[board_name]/climb-stats/[climb_uuid]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnforcePublicApiRateLimit.mockResolvedValue(null);
    mockGetClimbStatsForAllAngles.mockResolvedValue([]);
  });

  it('returns 200 with an edge Cache-Control header when under the limit', async () => {
    const res = await callGet();

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=300, stale-while-revalidate=86400');
    expect(mockGetClimbStatsForAllAngles).toHaveBeenCalledTimes(1);
  });

  it('returns 429 with Retry-After and skips the DB when rate limited', async () => {
    mockEnforcePublicApiRateLimit.mockResolvedValue(
      NextResponse.json(
        { error: 'Too many requests. Please slow down.' },
        { status: 429, headers: { 'Retry-After': '42' } },
      ),
    );

    const res = await callGet();

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
    expect(mockGetClimbStatsForAllAngles).not.toHaveBeenCalled();
  });
});
