// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// In-flight render race regression (play-drawer "unlit holds"): a slow native
// render must not clobber nativeRender state after the hook's props have moved
// to a different climb, or the key-match guard nulls overlayUri for the current
// climb with nothing left to re-fire the effect.

// The hook asks the theme provider for the app's colour scheme (issue #3885) —
// deliberately not react-native's useColorScheme(), which follows the OS. Stub
// the provider so these tests don't need a rendered ThemeProvider; the pure
// helpers exercised here take the scheme as an argument anyway.
vi.mock('../../providers/theme-provider', () => ({
  useAppColorScheme: () => 'light',
}));

vi.mock('expo-file-system', () => ({
  Directory: vi.fn(() => ({ exists: false, list: () => [] })),
  Paths: { cache: { uri: 'file:///cache/' } },
}));

vi.mock('../../lib/board-details', () => ({
  getBoardRenderData: vi.fn(() => ({
    boardWidth: 1000,
    boardHeight: 1200,
    holdsData: [{ id: 1, mirroredHoldId: null, cx: 100, cy: 200, r: 20 }],
  })),
}));

vi.mock('../../lib/background-image-cache', () => ({
  tryGetBackgroundPathsSync: vi.fn(() => ({ paths: ['file:///bg.png'], missingCount: 0 })),
  ensureBackgroundsCached: vi.fn(async () => ({ paths: ['file:///bg.png'], missingCount: 0 })),
}));

vi.mock('../../lib/error-reporting', () => ({
  reportError: vi.fn(),
}));

vi.mock('../../lib/hold-color-overrides', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/hold-color-overrides')>();
  // Referentially STABLE value: `overrides`/`shapes` are effect deps in the
  // hook, so a fresh object per render would re-fire the overlay effect every
  // render and self-heal the exact stale-clobber this suite exists to catch.
  const stableOverrides = {
    overrides: {},
    shapes: {},
    brushThickness: original.DEFAULT_HOLD_BRUSH_THICKNESS,
    shapeSize: original.DEFAULT_HOLD_SHAPE_SIZE,
    renderSignature: original.DEFAULT_HOLD_COLOR_SIGNATURE,
  };
  return {
    ...original,
    useHoldColorOverrides: () => stableOverrides,
  };
});

// Controllable native renderer: each call returns a deferred we resolve from
// the test, keyed by the cacheKey argument. Injected via the test-only setter
// because the hook loads the real module through a literal CJS require() that
// the vitest mock registry can't intercept.
const pendingRenders = new Map<string, { resolve: (uri: string) => void }>();
const fakeNativeModule = {
  // Availability flag getNativeModule() checks; the hook calls the top-level
  // renderHoldsOverlay wrapper, not this object.
  boardRendererNative: {},
  renderHoldsOverlay: vi.fn(
    (_configJson: string, cacheKey: string) =>
      new Promise<string>((resolve) => {
        pendingRenders.set(cacheKey, { resolve });
      }),
  ),
};

const {
  useNativeClimbRender,
  buildCacheKey,
  _renderedOverlaysForTests,
  _inflightRendersForTests,
  _setNativeModuleForTests,
} = await import('../use-native-climb-render');

const BASE = {
  boardName: 'kilter' as const,
  layoutId: 1,
  sizeId: 10,
  setIds: '26,27',
  filledStyle: false,
};

const FRAMES_SLOW = 'p1100r12p1200r13';
const FRAMES_CACHED = 'p1300r12p1400r15';

function cacheKeyFor(frames: string): string {
  return buildCacheKey(BASE.boardName, BASE.layoutId, BASE.sizeId, BASE.setIds, frames, BASE.filledStyle);
}

describe('useNativeClimbRender in-flight race', () => {
  beforeEach(() => {
    pendingRenders.clear();
    _renderedOverlaysForTests.clear();
    _inflightRendersForTests.clear();
    _setNativeModuleForTests(fakeNativeModule as unknown as Parameters<typeof _setNativeModuleForTests>[0]);
  });

  it('discards a slow render resolution after props moved to a cached climb', async () => {
    const slowKey = cacheKeyFor(FRAMES_SLOW);
    const cachedKey = cacheKeyFor(FRAMES_CACHED);
    _renderedOverlaysForTests.set(cachedKey, 'file:///overlay-cached.png');

    const { result, rerender } = renderHook(
      (props: { frames: string }) => useNativeClimbRender({ ...BASE, ...props }),
      { initialProps: { frames: FRAMES_SLOW } },
    );

    // Slow climb: render kicked off, nothing to show yet.
    await waitFor(() => expect(pendingRenders.has(slowKey)).toBe(true));
    expect(result.current.overlayUri).toBeNull();

    // Swipe to a climb whose overlay is already cached — sync branch shows it.
    rerender({ frames: FRAMES_CACHED });
    await waitFor(() => expect(result.current.overlayUri).toBe('file:///overlay-cached.png'));

    // The slow render finally resolves. It must NOT clobber the current climb.
    await act(async () => {
      pendingRenders.get(slowKey)?.resolve('file:///overlay-slow.png');
      await Promise.resolve();
    });
    expect(result.current.overlayUri).toBe('file:///overlay-cached.png');

    // The late result still landed in the cache for an instant hit on swipe-back.
    expect(_renderedOverlaysForTests.get(slowKey)).toBe('file:///overlay-slow.png');
    rerender({ frames: FRAMES_SLOW });
    await waitFor(() => expect(result.current.overlayUri).toBe('file:///overlay-slow.png'));
  });
});
