// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { NextRequest } from 'next/server';
import { GET } from '../route';

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/analytics.server', () => ({
  trackServer: vi.fn(),
  resolveRequestAttribution: vi.fn(async () => ({ distinctId: 'test', isAuthenticated: false })),
}));

vi.mock('@/app/lib/url-utils.server', () => ({
  parseBoardRouteParamsWithSlugs: vi.fn(async (params) => ({
    board_name: params.board_name,
    layout_id: Number(params.layout_id),
    size_id: Number(params.size_id),
    set_ids: String(params.set_ids).split(',').map(Number),
    angle: Number(params.angle),
    climb_uuid: params.climb_uuid,
  })),
}));

vi.mock('@/app/lib/data/queries', () => ({
  getClimb: vi.fn(async () => ({
    frames: 'p1r12,p2r13',
  })),
}));

vi.mock('@/app/lib/board-utils', () => ({
  getBoardDetailsForBoard: vi.fn(() => ({
    board_name: 'kilter',
    layout_id: 1,
    size_id: 7,
    set_ids: [1, 20],
    images_to_holds: {},
    holdsData: [],
    edge_left: 0,
    edge_right: 144,
    edge_bottom: 0,
    edge_top: 180,
    boardWidth: 1080,
    boardHeight: 1350,
  })),
}));

vi.mock('@/app/components/board-renderer/util', () => ({
  buildOgBoardRenderUrl: vi.fn(() => '/api/internal/board-render?board_name=kilter&variant=og&format=png'),
}));

function makeRequest(params: Record<string, string>): NextRequest {
  const url = new URL('http://localhost:3000/api/og/climb');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url);
}

const validParams = {
  board_name: 'kilter',
  layout_id: '1',
  size_id: '7',
  set_ids: '1,20',
  angle: '40',
  climb_uuid: 'climb-123',
};

describe('api/og/climb legacy redirect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('redirects legacy climb OG requests to the immutable Rust-render URL', async () => {
    const response = await GET(makeRequest(validParams));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/api/internal/board-render?board_name=kilter&variant=og&format=png',
    );
    expect(response.headers.get('Cache-Control')).toContain('s-maxage=300');
  });

  it('returns 400 when required params are missing', async () => {
    const response = await GET(makeRequest({ ...validParams, climb_uuid: '' }));

    expect(response.status).toBe(400);
  });
});
