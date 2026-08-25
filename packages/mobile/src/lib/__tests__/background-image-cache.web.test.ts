import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('../board-details', () => ({
  getBoardRenderData: vi.fn(() => ({
    backgroundImageKeys: ['kilter/product_sizes_layouts_sets/36-1.webp'],
  })),
}));
const resolveBoardBackgroundAsset = vi.fn(
  (_asset: { objectKey: string }, manifestKey: string) => `https://cdn.example/${manifestKey}`,
);
vi.mock('../board-background-asset-resolver', () => ({ resolveBoardBackgroundAsset }));
vi.mock('../board-backgrounds-manifest', () => ({
  BOARD_BACKGROUND_ASSETS: {
    'kilter/product_sizes_layouts_sets/36-1.webp': {
      objectKey: 'static/v1/abc.webp',
    },
  },
}));

const { ensureBackgroundsCached, tryGetBackgroundPathsSync } = await import('../background-image-cache');
const params = { boardName: 'kilter' as const, layoutId: 1, sizeId: 10, setIds: [24] };

describe('background image lookup on web', () => {
  it('returns the immutable CDN URL synchronously without asking the native wrapper', async () => {
    const expected = {
      paths: ['https://cdn.example/kilter/product_sizes_layouts_sets/36-1.webp'],
      missingCount: 0,
    };
    expect(tryGetBackgroundPathsSync(params)).toEqual(expected);
    await expect(ensureBackgroundsCached(params)).resolves.toEqual(expected);
    expect(resolveBoardBackgroundAsset).toHaveBeenCalled();
  });
});
