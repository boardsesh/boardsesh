import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// Isolate the warming logic from the real URL builders — the test only cares
// which URLs get fetched, not how they're assembled.
vi.mock('@/app/components/board-renderer/util', () => ({
  buildOverlayUrl: vi.fn(() => '/api/internal/board-render?overlay'),
  buildOgBoardRenderUrl: vi.fn(() => 'https://ws.boardsesh.com/og/climb?og'),
}));

import { FRONT_DOOR_WARM_LIMIT, warmOverlays } from '../warm-overlay-cache';
import { buildOgBoardRenderUrl } from '@/app/components/board-renderer/util';

type WarmOverlaysArg = Parameters<typeof warmOverlays>[0];
const boardDetails = { board_name: 'kilter' } as unknown as WarmOverlaysArg['boardDetails'];
const climbs = [{ frames: 'p1r12p2r13' }];

describe('warmOverlays', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(buildOgBoardRenderUrl).mockReturnValue('https://ws.boardsesh.com/og/climb?og');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ body: null }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('warms both the overlay and the absolute og image on the full climb-view path', async () => {
    await warmOverlays({ boardDetails, climbs, variant: 'full' });

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/internal/board-render?overlay'),
      expect.anything(),
    );
    expect(fetch).toHaveBeenCalledWith('https://ws.boardsesh.com/og/climb?og', expect.anything());
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('warms only the overlay for a thumbnail list — no per-row og render', async () => {
    await warmOverlays({ boardDetails, climbs, variant: 'thumbnail' });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/internal/board-render?overlay'),
      expect.anything(),
    );
    expect(buildOgBoardRenderUrl).not.toHaveBeenCalled();
  });

  it('skips the relative og fallback (backend origin unresolvable)', async () => {
    vi.mocked(buildOgBoardRenderUrl).mockReturnValue('/api/og/climb?relative');

    await warmOverlays({ boardDetails, climbs, variant: 'full' });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalledWith('/api/og/climb?relative', expect.anything());
  });

  it('swallows fetch failures instead of rejecting', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network down'));

    await expect(warmOverlays({ boardDetails, climbs, variant: 'full' })).resolves.toBeUndefined();
  });

  it('warms only FRONT_DOOR_WARM_LIMIT rows of a full list page', async () => {
    const fiftyClimbs = Array.from({ length: 50 }, (_, index) => ({ frames: `p1r${index}` }));

    await warmOverlays({ boardDetails, climbs: fiftyClimbs, variant: 'thumbnail', maxImages: FRONT_DOOR_WARM_LIMIT });

    // Each warm target is a same-origin CPU-bound WASM render. 50 rows at the
    // old default of 20 made one crawled list page cost 20 extra invocations.
    expect(FRONT_DOOR_WARM_LIMIT).toBe(6);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it('bounds every warm fetch with an abort signal', async () => {
    await warmOverlays({ boardDetails, climbs, variant: 'thumbnail' });

    // A warm request that never settles keeps the serverless instance — and the
    // pool connections it is holding — alive past the response it rode in on.
    const [, requestInit] = vi.mocked(fetch).mock.calls[0];
    expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
  });
});
