import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('../board-details', () => ({ getBoardRenderData: vi.fn() }));

const resolveBoardBackgroundAsset = vi.fn(
  (entry: { objectKey: string }): string | null => `/bundled/${entry.objectKey}`,
);
vi.mock('../board-background-asset-resolver', () => ({ resolveBoardBackgroundAsset }));

function asset(objectKey: string) {
  return { objectKey };
}

vi.mock('../board-backgrounds-manifest', () => ({
  BOARD_BACKGROUND_ASSETS: {
    'kilter/product_sizes_layouts_sets/36-1.webp': asset('kilter-full'),
    'kilter/product_sizes_layouts_sets/thumbs/36-1.webp': asset('kilter-thumb'),
    'tension/product_sizes_layouts_sets/12.webp': asset('tension-full'),
    'moonboard/moonboard-bg.webp': asset('moonboard-bg'),
    'moonboard/moonboard-bg.dark.webp': asset('moonboard-bg-dark'),
    'moonboard/thumbs/moonboard-bg.webp': asset('moonboard-bg-thumb'),
    'moonboard/thumbs/moonboard-bg.dark.webp': asset('moonboard-bg-thumb-dark'),
    'moonboard/moonboard2016/holdseta.webp': asset('moonboard-a'),
    'moonboard/moonboard2016/holdsetb.webp': asset('moonboard-b'),
    'moonboard/moonboard2016/holdsetb.dark.webp': asset('moonboard-b-dark'),
  },
}));

const { ensureBackgroundsCached, tryGetBackgroundPathsSync } = await import('../background-image-cache');
const { getBoardRenderData } = await import('../board-details');

const params = { boardName: 'kilter' as const, layoutId: 1, sizeId: 10, setIds: [24] };

function renderData(backgroundImageKeys: string[]) {
  return { backgroundImageKeys } as ReturnType<typeof getBoardRenderData>;
}

describe('native board background lookup', () => {
  beforeEach(() => {
    vi.mocked(getBoardRenderData).mockReset();
    resolveBoardBackgroundAsset.mockClear();
    resolveBoardBackgroundAsset.mockImplementation((entry: { objectKey: string }) => `/bundled/${entry.objectKey}`);
  });

  it('returns null when board render data is unavailable', async () => {
    vi.mocked(getBoardRenderData).mockReturnValue(null);
    expect(tryGetBackgroundPathsSync(params)).toBeNull();
    await expect(ensureBackgroundsCached(params)).resolves.toBeNull();
  });

  it('resolves installed wrapper resources synchronously and preserves the async API', async () => {
    vi.mocked(getBoardRenderData).mockReturnValue(renderData(['kilter/product_sizes_layouts_sets/36-1.webp']));
    const expected = { paths: ['/bundled/kilter-full'], missingCount: 0 };
    expect(tryGetBackgroundPathsSync(params)).toEqual(expected);
    await expect(ensureBackgroundsCached(params)).resolves.toEqual(expected);
  });

  it('uses a packaged thumbnail when present and falls back to full resolution when absent', () => {
    vi.mocked(getBoardRenderData).mockReturnValue(renderData(['kilter/product_sizes_layouts_sets/36-1.webp']));
    expect(tryGetBackgroundPathsSync({ ...params, variant: 'thumb' })).toEqual({
      paths: ['/bundled/kilter-thumb'],
      missingCount: 0,
    });

    vi.mocked(getBoardRenderData).mockReturnValue(renderData(['tension/product_sizes_layouts_sets/12.webp']));
    expect(tryGetBackgroundPathsSync({ ...params, variant: 'thumb' })).toEqual({
      paths: ['/bundled/tension-full'],
      missingCount: 0,
    });
  });

  it('uses dark siblings layer-by-layer and retains light layers without one', () => {
    vi.mocked(getBoardRenderData).mockReturnValue(
      renderData([
        'moonboard/moonboard-bg.webp',
        'moonboard/moonboard2016/holdseta.webp',
        'moonboard/moonboard2016/holdsetb.webp',
      ]),
    );
    expect(tryGetBackgroundPathsSync({ ...params, colorScheme: 'dark' })).toEqual({
      paths: ['/bundled/moonboard-bg-dark', '/bundled/moonboard-a', '/bundled/moonboard-b-dark'],
      missingCount: 0,
    });
  });

  it('reports catalog misses and wrapper misses without a network fallback', () => {
    vi.mocked(getBoardRenderData).mockReturnValue(
      renderData(['kilter/product_sizes_layouts_sets/36-1.webp', 'newboard/missing.webp']),
    );
    resolveBoardBackgroundAsset.mockReturnValue(null);
    expect(tryGetBackgroundPathsSync(params)).toEqual({ paths: [], missingCount: 2 });
    expect(resolveBoardBackgroundAsset).toHaveBeenCalledOnce();
  });
});
