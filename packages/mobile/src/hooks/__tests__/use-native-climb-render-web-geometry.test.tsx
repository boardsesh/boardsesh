// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { BoardArtGeometry } from '@boardsesh/board-art-geometry';

/**
 * Web-only: the Aura traced silhouettes arrive as a per-board `import()` chunk,
 * so the first render of a board draws rings and a second one has to replace it
 * once the art lands. Both halves of that recovery are pinned here — the browser
 * is the only platform where `boardArtGeometryPending` is ever true, so nothing
 * else in the suite reaches this branch.
 */

vi.mock('../../providers/theme-provider', () => ({ useAppColorScheme: () => 'dark' }));

vi.mock('expo-file-system', () => ({
  Directory: vi.fn(() => ({ exists: false, list: () => [] })),
  File: vi.fn(() => ({ exists: false })),
  Paths: { cache: { uri: 'file:///cache/' } },
}));

vi.mock('../../lib/board-details', () => ({
  getBoardRenderData: vi.fn(() => ({
    boardWidth: 1080,
    boardHeight: 1080,
    holdsData: [{ id: 1, mirroredHoldId: null, cx: 100, cy: 200, r: 20 }],
  })),
}));

vi.mock('../../lib/background-image-cache', () => ({
  tryGetBackgroundPathsSync: vi.fn(() => ({ paths: ['file:///bg.png'], missingCount: 0 })),
  ensureBackgroundsCached: vi.fn(async () => ({ paths: ['file:///bg.png'], missingCount: 0 })),
}));

vi.mock('../../lib/error-reporting', () => ({ reportError: vi.fn(), addErrorBreadcrumb: vi.fn() }));

// The shard index, driven by hand: `pending` is what the browser's async index
// reports, and the prefetch resolves only when a test says so.
const geometryChunk = vi.hoisted(() => ({
  pending: true,
  prefetchCalls: 0,
  resolve: null as null | ((geometry: BoardArtGeometry | null) => void),
}));
vi.mock('@boardsesh/board-art-geometry', async (importOriginal) => {
  const original = await importOriginal<typeof import('@boardsesh/board-art-geometry')>();
  return {
    ...original,
    boardArtGeometryPending: () => geometryChunk.pending,
    prefetchBoardArtGeometry: () => {
      geometryChunk.prefetchCalls += 1;
      return new Promise<BoardArtGeometry | null>((resolve) => {
        geometryChunk.resolve = resolve;
      });
    },
  };
});

// Referentially stable, for the reason the other suites give: a fresh settings
// object every render would re-fire the overlay effect and hide a missing
// re-render behind an accidental one.
const boardRenderSettingsRef = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../../lib/board-render-settings', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/board-render-settings')>();
  boardRenderSettingsRef.current = { ...original.DEFAULT_BOARD_RENDER_SETTINGS, mode: 'aura' };
  return {
    ...original,
    useBoardRenderSettings: () => ({
      settings: boardRenderSettingsRef.current,
      loaded: true,
      setMode: () => {},
      setBoardseshField: () => {},
      reset: () => {},
    }),
  };
});

const { overlayNameMatchesScope } = await import('../../lib/cache-sweep-plan');

const {
  useNativeClimbRender,
  buildCacheKey,
  _renderedOverlaysForTests,
  _inflightRendersForTests,
  _resetBoardConfigCacheForTests,
  _resetBoardseshSupportForTests,
  _resetNativeModuleLoadForTests,
  _resetWarmupForTests,
  _setNativeModuleForTests,
  _unsupportedRenderSignaturesForTests,
} = await import('../use-native-climb-render');

/** Stands in for the browser renderer's own caches: one key, one PNG, for good. */
const webOverlayStore = new Map<string, string>();
let renderIndex = 0;

const GRASSHOPPER = { boardName: 'grasshopper' as const, layoutId: 1, sizeId: 5, setIds: '1', frames: 'p1r2' };
const FAKE_GEOMETRY = {
  outlines: { 1: [0, 0, 1, 0, 1, 1] },
  lightness: {},
  ledBright: {},
} as unknown as BoardArtGeometry;

describe('web Aura geometry recovery', () => {
  const nativeModule = {
    boardRendererNative: {},
    renderHoldsOverlay: vi.fn<(configJson: string, cacheKey: string) => Promise<string>>(),
    probeBoardseshRendererSupport: vi.fn<() => Promise<boolean>>(),
  };

  /** Every cache key the renderer was asked for an Aura drawing under, in order. */
  function auraRenderKeys(): string[] {
    return nativeModule.renderHoldsOverlay.mock.calls
      .filter(([configJson]) => JSON.parse(configJson).render_mode === 'aura')
      .map(([, cacheKey]) => cacheKey);
  }

  beforeEach(() => {
    geometryChunk.pending = true;
    geometryChunk.prefetchCalls = 0;
    geometryChunk.resolve = null;
    _renderedOverlaysForTests.clear();
    _inflightRendersForTests.clear();
    _unsupportedRenderSignaturesForTests.clear();
    _resetBoardConfigCacheForTests();
    _resetBoardseshSupportForTests();
    _resetNativeModuleLoadForTests();
    _resetWarmupForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    nativeModule.renderHoldsOverlay.mockReset();
    webOverlayStore.clear();
    renderIndex = 0;
    // Faithful to `packages/mobile/modules/board-renderer/src/index.web.ts`: the
    // browser renderer answers steps 1 and 2 — the live object-URL map and the
    // Cache API copy that survives a reload — BEFORE it draws anything, so one
    // cache key means one PNG for good. A stub that minted a fresh URI per call
    // would pass this suite with the bug in place.
    nativeModule.renderHoldsOverlay.mockImplementation((_configJson, cacheKey) => {
      const alreadyDrawn = webOverlayStore.get(cacheKey);
      if (alreadyDrawn) return Promise.resolve(alreadyDrawn);
      renderIndex += 1;
      const objectUrl = `blob:overlay-${renderIndex}`;
      webOverlayStore.set(cacheKey, objectUrl);
      return Promise.resolve(objectUrl);
    });
    nativeModule.probeBoardseshRendererSupport.mockReset();
    nativeModule.probeBoardseshRendererSupport.mockResolvedValue(true);
    _setNativeModuleForTests(nativeModule as unknown as Parameters<typeof _setNativeModuleForTests>[0]);
  });

  it('renders the silhouettes under a key of their own once the chunk lands', async () => {
    const { result } = renderHook(() => useNativeClimbRender({ ...GRASSHOPPER }));

    // The ring pass. Its PNG is named for what it is: art still in flight.
    await waitFor(() => expect(auraRenderKeys()).toHaveLength(1));
    const ringKey = auraRenderKeys()[0];
    expect(ringKey.endsWith('_geopending')).toBe(true);
    await waitFor(() => expect(result.current.overlayUri).toBe(webOverlayStore.get(ringKey)));
    const ringUri = webOverlayStore.get(ringKey);

    await waitFor(() => expect(geometryChunk.resolve).not.toBeNull());
    geometryChunk.pending = false;
    geometryChunk.resolve?.(FAKE_GEOMETRY);

    // The recovery pass, under the clean key — which none of the browser's three
    // overlay stores has an entry for, so it actually draws. Sharing the ring's
    // key would hand step 1 or step 2 of the web renderer the ring PNG straight
    // back, and on a reload the Cache API copy would still be there.
    await waitFor(() => expect(auraRenderKeys()).toHaveLength(2));
    const geometryKey = auraRenderKeys()[1];
    expect(geometryKey).toBe(ringKey.slice(0, -'_geopending'.length));
    await waitFor(() => expect(result.current.overlayUri).toBe(webOverlayStore.get(geometryKey)));
    expect(result.current.overlayUri).not.toBe(ringUri);
  });

  it('does not re-ask for a chunk that failed, so a dropped download is not a loop', async () => {
    renderHook(() => useNativeClimbRender({ ...GRASSHOPPER }));

    await waitFor(() => expect(geometryChunk.resolve).not.toBeNull());
    expect(geometryChunk.prefetchCalls).toBe(1);

    // A failed download resolves `null` and leaves the key pending. Bouncing the
    // effect on that would re-enter the same branch and ask again — forever.
    geometryChunk.resolve?.(null);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(geometryChunk.prefetchCalls).toBe(1);
    expect(auraRenderKeys()).toHaveLength(1);
  });
});

describe('the _geopending cache-key token', () => {
  const ARGS = ['kilter', 1, 7, '1,20', 'p1100r12', false, 400, 'sig'] as const;

  it('is absent unless the art is still downloading, so no native PNG is renamed', () => {
    expect(buildCacheKey(...ARGS)).toBe(buildCacheKey(...ARGS, false));
    expect(buildCacheKey(...ARGS, true)).toBe(`${buildCacheKey(...ARGS)}_geopending`);
  });

  it('leaves the sweep able to reap the board it belongs to', () => {
    // Both halves the cache sweep reads are upstream of the token: the version
    // prefix it matches current files on, and the delimited board run it reaps a
    // single board's art by.
    const pendingName = `${buildCacheKey(...ARGS, true)}.png`;
    expect(pendingName.startsWith('v')).toBe(true);
    expect(overlayNameMatchesScope(pendingName, { boardType: 'kilter', layoutId: 1, sizeId: 7 })).toBe(true);
    expect(overlayNameMatchesScope(pendingName, { boardType: 'kilter', layoutId: 1, sizeId: 70 })).toBe(false);
  });
});
