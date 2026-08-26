// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));

vi.mock('@/app/lib/db/queries/climbs/search-climbs', () => ({
  cachedSearchClimbs: vi.fn(),
}));

vi.mock('@/app/lib/board-utils', () => ({
  getBoardDetailsForBoard: vi.fn(() => ({ board_name: 'kilter' })),
}));

vi.mock('@/app/components/board-renderer/util', () => ({
  buildOverlayPreloadUrls: vi.fn((_bd: unknown, frames: string | null | undefined) =>
    frames ? ['/api/internal/board-render?overlay'] : [],
  ),
}));

import { cachedSearchClimbs } from '@/app/lib/db/queries/climbs/search-climbs';
import { fetchFrontDoorListPage } from '../list-page-data.server';
import type { ParsedBoardRouteParameters } from '@/app/lib/types';

const parsedParams: ParsedBoardRouteParameters = {
  board_name: 'kilter',
  layout_id: 8,
  size_id: 10,
  set_ids: [1, 2],
  angle: 40,
};

describe('fetchFrontDoorListPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('rethrows a failed search instead of rendering a 200 with an empty list', async () => {
    // A sitemapped URL answering 200-with-nothing is read as legitimate thin
    // content and dropped; a 5xx is retried and the URL is kept.
    vi.mocked(cachedSearchClimbs).mockRejectedValue(new Error('connection terminated unexpectedly'));

    await expect(fetchFrontDoorListPage(parsedParams, 1)).rejects.toThrow('connection terminated unexpectedly');
  });

  it('returns a preload URL without starting server-side overlay warms', async () => {
    vi.mocked(cachedSearchClimbs).mockResolvedValue({
      climbs: [{ frames: 'p1r12' }] as never,
      hasMore: true,
    });

    const result = await fetchFrontDoorListPage(parsedParams, 1);

    expect(result?.preloadUrl).toBe('/api/internal/board-render?overlay');
  });
});
