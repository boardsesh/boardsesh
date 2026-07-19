import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('../board-details', () => ({
  getBoardRenderData: vi.fn(() => ({
    backgroundImageKeys: ['kilter/product_sizes_layouts_sets/36-1.webp'],
  })),
}));

const downloadAsync = vi.fn();
vi.mock('expo-asset', () => ({
  Asset: {
    fromModule: vi.fn(() => ({ localUri: null, uri: '/app/assets/36-1.webp', downloadAsync })),
  },
}));

vi.mock('../board-backgrounds-manifest', () => ({
  BOARD_BACKGROUND_ASSETS: { 'kilter/product_sizes_layouts_sets/36-1.webp': 100 },
}));

const { ensureBackgroundsCached, tryGetBackgroundPathsSync } = await import('../background-image-cache');

const params = { boardName: 'kilter' as const, layoutId: 1, sizeId: 10, setIds: [24] };

describe('background image cache on web', () => {
  it('returns the browser asset URL synchronously', () => {
    expect(tryGetBackgroundPathsSync(params)).toEqual({ paths: ['/app/assets/36-1.webp'], missingCount: 0 });
  });

  it('does not try to materialize browser assets as file URLs', async () => {
    await expect(ensureBackgroundsCached(params)).resolves.toEqual({
      paths: ['/app/assets/36-1.webp'],
      missingCount: 0,
    });
    expect(downloadAsync).not.toHaveBeenCalled();
  });
});
