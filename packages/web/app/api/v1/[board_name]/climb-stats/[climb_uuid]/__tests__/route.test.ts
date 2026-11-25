import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { NextResponse } from 'next/server';
import { GET } from '../route';

const { admission, recordRows, getStats } = vi.hoisted(() => ({
  admission: vi.fn(),
  recordRows: vi.fn(),
  getStats: vi.fn(),
}));
vi.mock('@/app/lib/api/catalog-admission.server', () => ({ withCatalogAdmission: admission }));
vi.mock('@/app/lib/data/queries', () => ({ getClimbStatsForAllAngles: getStats }));

function callGet() {
  const req = new Request('http://localhost/api/v1/kilter/climb-stats/CLIMB-1');
  return GET(req, { params: Promise.resolve({ board_name: 'kilter', climb_uuid: 'CLIMB-1' }) });
}

describe('GET /api/v1/[board_name]/climb-stats/[climb_uuid]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    admission.mockImplementation((_request, _operation, work) => work(recordRows));
    getStats.mockResolvedValue([{ angle: 40 }, { angle: 45 }]);
  });

  it('returns cached stats and settles the actual angle count', async () => {
    const response = await callGet();
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, s-maxage=300, stale-while-revalidate=86400');
    expect(admission).toHaveBeenCalledWith(expect.any(Request), 'reststats', expect.any(Function));
    expect(recordRows).toHaveBeenCalledWith(2);
  });

  it('propagates shared admission refusals without reading stats', async () => {
    admission.mockResolvedValue(NextResponse.json({ error: 'Rate limited' }, { status: 429 }));
    expect((await callGet()).status).toBe(429);
    expect(getStats).not.toHaveBeenCalled();
    expect(recordRows).not.toHaveBeenCalled();
  });
});
