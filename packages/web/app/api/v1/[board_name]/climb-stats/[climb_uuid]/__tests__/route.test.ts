import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { GET } from '../route';

// Mock the rate limiter so we can drive both the allowed and limited paths.
const mockCheckRateLimit = vi.fn();
const mockGetClientIp = vi.fn();
vi.mock('@/app/lib/auth/rate-limiter', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  getClientIp: (...args: unknown[]) => mockGetClientIp(...args),
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
    mockGetClientIp.mockReturnValue('127.0.0.1');
    mockCheckRateLimit.mockReturnValue({ limited: false, retryAfterSeconds: 0 });
    mockGetClimbStatsForAllAngles.mockResolvedValue([]);
  });

  it('returns 200 with an edge Cache-Control header when under the limit', async () => {
    const res = await callGet();

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=300, stale-while-revalidate=86400');
    expect(mockGetClimbStatsForAllAngles).toHaveBeenCalledTimes(1);
  });

  it('returns 429 with Retry-After and skips the DB when rate limited', async () => {
    mockCheckRateLimit.mockReturnValue({ limited: true, retryAfterSeconds: 42 });

    const res = await callGet();

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
    expect(mockGetClimbStatsForAllAngles).not.toHaveBeenCalled();
  });

  it('never advertises a back-off below 1 second', async () => {
    mockCheckRateLimit.mockReturnValue({ limited: true, retryAfterSeconds: 0 });

    const res = await callGet();

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('1');
  });
});
