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

vi.mock('@/app/lib/warm-overlay-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/lib/warm-overlay-cache')>();
  return { ...actual, scheduleOverlayWarming: vi.fn() };
});

import { cachedSearchClimbs } from '@/app/lib/db/queries/climbs/search-climbs';
import { FRONT_DOOR_WARM_LIMIT, scheduleOverlayWarming } from '@/app/lib/warm-overlay-cache';
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

  it('caps the overlay warm fan-out at FRONT_DOOR_WARM_LIMIT', async () => {
    const climbs = Array.from({ length: 50 }, (_, index) => ({ frames: `p1r${index}` }));
    vi.mocked(cachedSearchClimbs).mockResolvedValue({
      climbs: climbs as never,
      hasMore: true,
    });

    await fetchFrontDoorListPage(parsedParams, 1);

    // The caller-side half of the cap. The unit test on `warmOverlays` alone
    // would stay green with the call site unchanged — an inert guard.
    expect(scheduleOverlayWarming).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'thumbnail', maxImages: FRONT_DOOR_WARM_LIMIT }),
    );
  });
});
