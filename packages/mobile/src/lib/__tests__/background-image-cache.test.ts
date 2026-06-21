import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../board-details', () => ({
  getBoardRenderData: vi.fn(),
}));

const downloadAsyncMock = vi.fn().mockResolvedValue(undefined);
class MockAsset {
  localUri: string | null;
  constructor(public moduleId: number) {
    // Simulate production: bundled assets have localUri pre-populated.
    this.localUri = `file:///bundled/${moduleId}.webp`;
  }
  downloadAsync = downloadAsyncMock;
  static fromModule(moduleId: number) {
    return new MockAsset(moduleId);
  }
}

vi.mock('expo-asset', () => ({
  Asset: MockAsset,
}));

vi.mock('../board-backgrounds-manifest', () => ({
  BOARD_BACKGROUND_ASSETS: {
    'kilter/product_sizes_layouts_sets/36-1.webp': 100,
    // Kilter has a bundled thumb; Tension intentionally does not, so the
    // thumb-variant fallback-to-full path is exercised below.
    'kilter/product_sizes_layouts_sets/thumbs/36-1.webp': 300,
    'tension/product_sizes_layouts_sets/12.webp': 200,
  },
}));

const { toFilesystemPath, ensureBackgroundsCached, tryGetBackgroundPathsSync } =
  await import('../background-image-cache');
const { getBoardRenderData } = await import('../board-details');

describe('toFilesystemPath', () => {
  it('strips file:// prefix', () => {
    expect(toFilesystemPath('file:///data/cache/img.png')).toBe('/data/cache/img.png');
  });

  it('returns plain paths unchanged', () => {
    expect(toFilesystemPath('/data/cache/img.png')).toBe('/data/cache/img.png');
  });

  it('only strips the first file:// occurrence', () => {
    expect(toFilesystemPath('file:///path/file://weird')).toBe('/path/file://weird');
  });
});

describe('ensureBackgroundsCached', () => {
  beforeEach(() => {
    vi.mocked(getBoardRenderData).mockReset();
    downloadAsyncMock.mockClear();
  });

  it('returns null when board render data is missing', async () => {
    vi.mocked(getBoardRenderData).mockReturnValue(null);
    const result = await ensureBackgroundsCached({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: [24],
    });
    // Null when getBoardRenderData itself fails — caller has no expected
    // layer count to fall back on, so a partial result would be misleading.
    expect(result).toBeNull();
  });

  it('resolves bundled assets without calling downloadAsync when localUri is populated', async () => {
    vi.mocked(getBoardRenderData).mockReturnValue({
      boardWidth: 100,
      boardHeight: 100,
      edgeLeft: 0,
      edgeRight: 11,
      edgeBottom: 0,
      edgeTop: 18,
      holdsData: [],
      backgroundImageKeys: ['kilter/product_sizes_layouts_sets/36-1.webp'],
    } as ReturnType<typeof getBoardRenderData>);

    const result = await ensureBackgroundsCached({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: [24],
    });

    expect(result).toEqual({ paths: ['/bundled/100.webp'], missingCount: 0 });
    // Production bundled assets short-circuit downloadAsync via the sync
    // fast-path — neither ensureBackgroundsCached nor the underlying
    // sync resolver should call it.
    expect(downloadAsyncMock).not.toHaveBeenCalled();
  });

  it('looks up bundled .webp manifest keys directly', async () => {
    vi.mocked(getBoardRenderData).mockReturnValue({
      boardWidth: 100,
      boardHeight: 100,
      edgeLeft: 0,
      edgeRight: 11,
      edgeBottom: 0,
      edgeTop: 18,
      holdsData: [],
      backgroundImageKeys: ['tension/product_sizes_layouts_sets/12.webp'],
    } as ReturnType<typeof getBoardRenderData>);

    const result = await ensureBackgroundsCached({
      boardName: 'tension',
      layoutId: 1,
      sizeId: 10,
      setIds: [24],
    });

    expect(result).toEqual({ paths: ['/bundled/200.webp'], missingCount: 0 });
  });

  it('surfaces a manifest miss via missingCount (no silent drop, no network fallback)', async () => {
    vi.mocked(getBoardRenderData).mockReturnValue({
      boardWidth: 100,
      boardHeight: 100,
      edgeLeft: 0,
      edgeRight: 11,
      edgeBottom: 0,
      edgeTop: 18,
      holdsData: [],
      backgroundImageKeys: ['newboard/bg.webp'],
    } as ReturnType<typeof getBoardRenderData>);

    const result = await ensureBackgroundsCached({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: [24],
    });

    // The no-network rule means a manifest miss is surfaced as a
    // missingCount — the caller MUST render a visible gap so the bug is
    // reportable, not invisibly-broken.
    expect(result).toEqual({ paths: [], missingCount: 1 });
    expect(downloadAsyncMock).not.toHaveBeenCalled();
  });

  it('returns a partial result with the right missingCount when only some layers resolve', async () => {
    vi.mocked(getBoardRenderData).mockReturnValue({
      boardWidth: 100,
      boardHeight: 100,
      edgeLeft: 0,
      edgeRight: 11,
      edgeBottom: 0,
      edgeTop: 18,
      holdsData: [],
      // First key resolves via the manifest; second is a new board layer
      // we never bundled (the bug this fix targets).
      backgroundImageKeys: ['kilter/product_sizes_layouts_sets/36-1.webp', 'newboard/missing-layer.webp'],
    } as ReturnType<typeof getBoardRenderData>);

    const result = await ensureBackgroundsCached({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: [24],
    });

    // 1 layer resolved, 1 missing — the consumer must show a visible
    // placeholder for the missing one. Previously this returned just
    // ['/bundled/100.webp'] and the consumer never knew a layer was lost.
    expect(result).toEqual({ paths: ['/bundled/100.webp'], missingCount: 1 });
  });
});

describe('tryGetBackgroundPathsSync', () => {
  beforeEach(() => {
    vi.mocked(getBoardRenderData).mockReset();
  });

  it('returns paths synchronously when bundled assets resolve', () => {
    vi.mocked(getBoardRenderData).mockReturnValue({
      boardWidth: 100,
      boardHeight: 100,
      edgeLeft: 0,
      edgeRight: 11,
      edgeBottom: 0,
      edgeTop: 18,
      holdsData: [],
      backgroundImageKeys: ['kilter/product_sizes_layouts_sets/36-1.webp'],
    } as ReturnType<typeof getBoardRenderData>);

    const result = tryGetBackgroundPathsSync({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: [24],
    });

    expect(result).toEqual({ paths: ['/bundled/100.webp'], missingCount: 0 });
  });

  it('surfaces manifest misses via missingCount instead of silently dropping them', () => {
    vi.mocked(getBoardRenderData).mockReturnValue({
      boardWidth: 100,
      boardHeight: 100,
      edgeLeft: 0,
      edgeRight: 11,
      edgeBottom: 0,
      edgeTop: 18,
      holdsData: [],
      backgroundImageKeys: ['kilter/product_sizes_layouts_sets/36-1.webp', 'newboard/bg.webp'],
    } as ReturnType<typeof getBoardRenderData>);

    const result = tryGetBackgroundPathsSync({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: [24],
    });

    // Resolved layer + missingCount. The hook propagates missingCount to
    // the components, which render a visible placeholder per missing
    // layer. Before the fix this returned null and the caller fell back
    // to an empty array with no signal that a layer was lost.
    expect(result).toEqual({ paths: ['/bundled/100.webp'], missingCount: 1 });
  });

  it('returns null when getBoardRenderData fails', () => {
    vi.mocked(getBoardRenderData).mockReturnValue(null);
    const result = tryGetBackgroundPathsSync({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: [24],
    });
    expect(result).toBeNull();
  });
});

describe('thumb variant', () => {
  beforeEach(() => {
    vi.mocked(getBoardRenderData).mockReset();
  });

  it('resolves the bundled thumbs/ asset when variant is "thumb"', () => {
    vi.mocked(getBoardRenderData).mockReturnValue({
      boardWidth: 100,
      boardHeight: 100,
      edgeLeft: 0,
      edgeRight: 11,
      edgeBottom: 0,
      edgeTop: 18,
      holdsData: [],
      backgroundImageKeys: ['kilter/product_sizes_layouts_sets/36-1.webp'],
    } as ReturnType<typeof getBoardRenderData>);

    const result = tryGetBackgroundPathsSync({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: [24],
      variant: 'thumb',
    });

    // Maps to `.../thumbs/36-1.webp` (module 300), not the full-res 100.
    expect(result).toEqual({ paths: ['/bundled/300.webp'], missingCount: 0 });
  });

  it('falls back to the bundled full-res asset when no thumb is bundled (never the backend)', () => {
    vi.mocked(getBoardRenderData).mockReturnValue({
      boardWidth: 100,
      boardHeight: 100,
      edgeLeft: 0,
      edgeRight: 11,
      edgeBottom: 0,
      edgeTop: 18,
      holdsData: [],
      // Tension has no thumbs/ entry in the mock manifest.
      backgroundImageKeys: ['tension/product_sizes_layouts_sets/12.webp'],
    } as ReturnType<typeof getBoardRenderData>);

    const result = tryGetBackgroundPathsSync({
      boardName: 'tension',
      layoutId: 1,
      sizeId: 10,
      setIds: [24],
      variant: 'thumb',
    });

    // Graceful fallback to the full-res key (module 200), no missing gap.
    expect(result).toEqual({ paths: ['/bundled/200.webp'], missingCount: 0 });
  });
});
