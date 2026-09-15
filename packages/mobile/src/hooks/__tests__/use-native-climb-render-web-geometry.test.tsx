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

const {
  useNativeClimbRender,
  _renderedOverlaysForTests,
  _inflightRendersForTests,
  _resetBoardConfigCacheForTests,
  _resetBoardseshSupportForTests,
  _resetNativeModuleLoadForTests,
  _resetWarmupForTests,
  _setNativeModuleForTests,
  _unsupportedRenderSignaturesForTests,
} = await import('../use-native-climb-render');

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

  /** Every config the renderer was handed, in order. */
  function sentConfigs(): Record<string, unknown>[] {
    return nativeModule.renderHoldsOverlay.mock.calls.map(([configJson]) => JSON.parse(configJson));
  }
  function auraRenderCount(): number {
    return sentConfigs().filter((config) => config.render_mode === 'aura').length;
  }
  function cachedOverlayUris(): string[] {
    return [..._renderedOverlaysForTests.values()].map((entry) => entry.uri);
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
    // One distinct file per render, so the cache can be read for WHICH drawing
    // it is holding rather than just how many it has.
    let renderIndex = 0;
    nativeModule.renderHoldsOverlay.mockImplementation(() => {
      renderIndex += 1;
      return Promise.resolve(`file:///render-${renderIndex}.png`);
    });
    nativeModule.probeBoardseshRendererSupport.mockReset();
    nativeModule.probeBoardseshRendererSupport.mockResolvedValue(true);
    _setNativeModuleForTests(nativeModule as unknown as Parameters<typeof _setNativeModuleForTests>[0]);
  });

  it('evicts the ring-only overlay and renders again once the chunk lands', async () => {
    renderHook(() => useNativeClimbRender({ ...GRASSHOPPER }));

    // The ring pass: Aura mode, no silhouettes yet, and its PNG is now cached
    // under the key the recovery run will ask for.
    await waitFor(() => expect(auraRenderCount()).toBe(1));
    await waitFor(() => expect(geometryChunk.resolve).not.toBeNull());
    const ringUri = await waitFor(() => {
      const uris = cachedOverlayUris();
      expect(uris.length).toBeGreaterThan(0);
      return uris[uris.length - 1];
    });

    geometryChunk.pending = false;
    geometryChunk.resolve?.(FAKE_GEOMETRY);

    // A second Aura render is the whole point: without the eviction the cached
    // ring PNG answers the recovery run and this stays at 1 forever — on web
    // that cache survives the reload, so the board keeps its rings for good.
    await waitFor(() => expect(auraRenderCount()).toBe(2));
    await waitFor(() => expect(cachedOverlayUris()).not.toContain(ringUri));
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
    expect(auraRenderCount()).toBe(1);
  });
});
