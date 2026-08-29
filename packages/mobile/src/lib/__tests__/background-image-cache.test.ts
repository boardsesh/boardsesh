import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

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
    // Dedicated key for the asset-resolution-failure regression test below —
    // module 999 is never touched by any other test, so the module-scoped
    // `resolvedPaths` cache in background-image-cache.ts can't short-circuit
    // it with a stale success from an earlier test in this file.
    'kilter/product_sizes_layouts_sets/999-failure-test.webp': 999,
    // MoonBoard 2016: the frame and the black hold sheet ship `.dark.webp`
    // siblings (issue #3885); the pale set A deliberately does not, so the
    // "no sibling => unchanged" fallback is exercised in the same board.
    'moonboard/moonboard-bg.webp': 400,
    'moonboard/moonboard-bg.dark.webp': 401,
    'moonboard/thumbs/moonboard-bg.webp': 402,
    'moonboard/thumbs/moonboard-bg.dark.webp': 403,
    'moonboard/moonboard2016/holdsetb.webp': 410,
    'moonboard/moonboard2016/holdsetb.dark.webp': 411,
    'moonboard/moonboard2016/holdseta.webp': 420,
    // Woods: hold sprites on a white ground, so its `.dark.webp` siblings have the
    // ground keyed out rather than lifted (issue #4753). Full-res + thumb per size,
    // light and dark, which is the only board carrying the full four.
    'woods/woods-12x12-bg.webp': 500,
    'woods/thumbs/woods-12x12-bg.webp': 501,
    'woods/woods-12x12-bg.dark.webp': 502,
    'woods/thumbs/woods-12x12-bg.dark.webp': 503,
    'woods/woods-8x10-bg.webp': 510,
    'woods/thumbs/woods-8x10-bg.webp': 511,
    'woods/woods-8x10-bg.dark.webp': 512,
    'woods/thumbs/woods-8x10-bg.dark.webp': 513,
  },
}));

const MOONBOARD_2016_LAYERS = [
  'moonboard/moonboard-bg.webp',
  'moonboard/moonboard2016/holdseta.webp',
  'moonboard/moonboard2016/holdsetb.webp',
];

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

  // Regression guard for #3191: the Sentry crash was an *unhandled promise
  // rejection* from a network board-art fetch that 403'd. That call site was
  // removed (see index.tsx), but ensureBackgroundsCached itself must stay
  // reject-proof for any asset-resolution failure — a failed layer degrades
  // to a missing-count gap the caller renders visibly, never an uncaught
  // rejection that crashes the surrounding effect.
  it('resolves with a missing layer instead of rejecting when native asset resolution fails', async () => {
    vi.mocked(getBoardRenderData).mockReturnValue({
      boardWidth: 100,
      boardHeight: 100,
      edgeLeft: 0,
      edgeRight: 11,
      edgeBottom: 0,
      edgeTop: 18,
      holdsData: [],
      // Dedicated manifest key (module 999) — see the manifest mock comment —
      // so this test's fromModule() call can't be served by another test's
      // already-cached success.
      backgroundImageKeys: ['kilter/product_sizes_layouts_sets/999-failure-test.webp'],
    } as ReturnType<typeof getBoardRenderData>);

    // Simulate the dev-mode / not-yet-materialized case (localUri unset), so
    // resolution falls through to downloadAsync() — then make that reject,
    // standing in for any native asset-resolution failure.
    const fromModuleSpy = vi.spyOn(MockAsset, 'fromModule').mockImplementationOnce((moduleId: number) => {
      const asset = new MockAsset(moduleId);
      asset.localUri = null;
      return asset;
    });
    downloadAsyncMock.mockRejectedValueOnce(new Error('simulated asset resolution failure'));

    try {
      const result = await ensureBackgroundsCached({
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: [24],
      });

      // If this ever regressed to an uncaught rejection, `await` above would
      // throw and fail the test — resolving here proves the catch-and-degrade
      // contract holds.
      expect(result).toEqual({ paths: [], missingCount: 1 });
    } finally {
      // try/finally so a failed assertion above still restores the spy —
      // otherwise a failure here would leak a mocked fromModule() into
      // every later test in this file.
      fromModuleSpy.mockRestore();
    }
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

// Issue #3885. MoonBoard is the only board whose art is drawn for a WHITE wall:
// its grid frame + A-K/1-18 labels are pure #000000 and its "set B" sheet is
// black plastic, so over the dark play field (#181225) they measure ~1.1:1 and
// vanish. Dark-mode siblings (scripts/generate-dark-board-art.ts) lift just
// those layers. Everything without a sibling — and all of light mode — must
// resolve exactly what it resolved before the feature existed.
describe('dark-mode art variants', () => {
  beforeEach(() => {
    vi.mocked(getBoardRenderData).mockReset();
    vi.mocked(getBoardRenderData).mockReturnValue({
      boardWidth: 650,
      boardHeight: 1000,
      edgeLeft: 0,
      edgeRight: 11,
      edgeBottom: 0,
      edgeTop: 18,
      holdsData: [],
      backgroundImageKeys: MOONBOARD_2016_LAYERS,
    } as ReturnType<typeof getBoardRenderData>);
  });

  const moonboardParams = { boardName: 'moonboard' as const, layoutId: 1, sizeId: 10, setIds: [1] };

  it('swaps only the layers that have a .dark.webp sibling', () => {
    const result = tryGetBackgroundPathsSync({ ...moonboardParams, colorScheme: 'dark' });

    // 401 = frame dark, 420 = pale set A (NO sibling, unchanged), 411 = set B dark.
    expect(result).toEqual({ paths: ['/bundled/401.webp', '/bundled/420.webp', '/bundled/411.webp'], missingCount: 0 });
  });

  it('leaves light mode byte-identical to before the feature existed', () => {
    const explicitLight = tryGetBackgroundPathsSync({ ...moonboardParams, colorScheme: 'light' });
    const omitted = tryGetBackgroundPathsSync(moonboardParams);

    expect(omitted).toEqual({
      paths: ['/bundled/400.webp', '/bundled/420.webp', '/bundled/410.webp'],
      missingCount: 0,
    });
    // Omitting the param must behave exactly like passing 'light' — this is what
    // keeps the one remaining caller that never passes it (the Live Activity
    // thumbnail builder; PlaylistBoardBackdrop and the climbs-tab prefetch now
    // thread the live app colour scheme through, see #3962) rendering as it
    // does today.
    expect(explicitLight).toEqual(omitted);
  });

  it('resolves the dark sibling of the THUMB variant, not the full-res one', () => {
    vi.mocked(getBoardRenderData).mockReturnValue({
      boardWidth: 650,
      boardHeight: 1000,
      edgeLeft: 0,
      edgeRight: 11,
      edgeBottom: 0,
      edgeTop: 18,
      holdsData: [],
      backgroundImageKeys: ['moonboard/moonboard-bg.webp'],
    } as ReturnType<typeof getBoardRenderData>);

    // Thumb resolution has to happen FIRST, then the dark swap on the result —
    // otherwise a list cell would load the full-res dark frame (403, not 401).
    expect(tryGetBackgroundPathsSync({ ...moonboardParams, variant: 'thumb', colorScheme: 'dark' })).toEqual({
      paths: ['/bundled/403.webp'],
      missingCount: 0,
    });
  });

  it('never treats a missing dark sibling as a missing layer', () => {
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

    // Kilter art is mid-tone and already reads on a dark field, so it ships no
    // dark sibling. A dark render must fall through to the normal key rather
    // than counting a gap and painting the grey missing-layer placeholder.
    expect(
      tryGetBackgroundPathsSync({ boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: [24], colorScheme: 'dark' }),
    ).toEqual({
      paths: ['/bundled/100.webp'],
      missingCount: 0,
    });
  });

  it('applies the same swap on the async path', async () => {
    const result = await ensureBackgroundsCached({ ...moonboardParams, colorScheme: 'dark' });

    expect(result).toEqual({ paths: ['/bundled/401.webp', '/bundled/420.webp', '/bundled/411.webp'], missingCount: 0 });
  });
});

describe('bundled Woods board art', () => {
  // Read as SOURCE TEXT rather than imported: the generated manifest `require()`s
  // the .webp binaries, which vitest has no loader for. What matters here is the
  // key set, and a regenerated manifest that drops (or renames) a Woods entry
  // would leave the board rendering a grey missing-layer placeholder.
  const manifestSource = readFileSync(new URL('../board-backgrounds-manifest.ts', import.meta.url), 'utf8');
  const manifestKeys = [...manifestSource.matchAll(/^\s*'([^']+)':/gm)].map((match) => match[1]);

  it('bundles a light and a dark key for each size and variant', () => {
    // Woods' dark art comes from its own generator (scripts/generate-woods-dark-art.ts):
    // MoonBoard's transforms lift a near-black transparent layer, and this art is hold
    // sprites on an opaque white ground, so the ground is keyed out instead.
    expect(manifestKeys.filter((key) => key.startsWith('woods/')).sort()).toEqual([
      'woods/thumbs/woods-12x12-bg.dark.webp',
      'woods/thumbs/woods-12x12-bg.webp',
      'woods/thumbs/woods-8x10-bg.dark.webp',
      'woods/thumbs/woods-8x10-bg.webp',
      'woods/woods-12x12-bg.dark.webp',
      'woods/woods-12x12-bg.webp',
      'woods/woods-8x10-bg.dark.webp',
      'woods/woods-8x10-bg.webp',
    ]);
  });

  it('resolves the full-res, thumb and dark-mode paths for a Woods board', () => {
    vi.mocked(getBoardRenderData).mockReturnValue({
      boardWidth: 1225,
      boardHeight: 1400,
      edgeLeft: 0,
      edgeRight: 33,
      edgeBottom: 0,
      edgeTop: 31,
      holdsData: [],
      backgroundImageKeys: ['woods/woods-12x12-bg.webp'],
    } as ReturnType<typeof getBoardRenderData>);

    const woodsParams = { boardName: 'woods' as const, layoutId: 1, sizeId: 2, setIds: [1] };

    expect(tryGetBackgroundPathsSync(woodsParams)).toEqual({ paths: ['/bundled/500.webp'], missingCount: 0 });
    expect(tryGetBackgroundPathsSync({ ...woodsParams, variant: 'thumb' })).toEqual({
      paths: ['/bundled/501.webp'],
      missingCount: 0,
    });
    expect(tryGetBackgroundPathsSync({ ...woodsParams, colorScheme: 'dark' })).toEqual({
      paths: ['/bundled/502.webp'],
      missingCount: 0,
    });
    // Thumb first, then the dark swap on top of it — a list cell gets the small dark
    // file, not the full-res one.
    expect(tryGetBackgroundPathsSync({ ...woodsParams, variant: 'thumb', colorScheme: 'dark' })).toEqual({
      paths: ['/bundled/503.webp'],
      missingCount: 0,
    });
  });
});
