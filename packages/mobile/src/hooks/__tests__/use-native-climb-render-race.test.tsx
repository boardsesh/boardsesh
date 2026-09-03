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

const existingOverlayUris = vi.hoisted(() => new Set<string>());
class MockFile {
  constructor(private readonly uri: string) {}
  get exists(): boolean {
    return existingOverlayUris.has(this.uri);
  }
}

vi.mock('expo-file-system', () => ({
  Directory: vi.fn(() => ({ exists: false, list: () => [] })),
  File: MockFile,
  Paths: { cache: { uri: 'file:///cache/' } },
}));

// One hold per placement id these frames light. The render path now skips a
// config whose holds match NONE of the lit ids (the silent blank-overlay case:
// a climb from another board drawn under this one), so a fixture board has to
// actually contain the ids its climbs light.
function mockHolds(ids: number[]) {
  return ids.map((id) => ({ id, mirroredHoldId: null, cx: 100, cy: 200, r: 20 }));
}

vi.mock('../../lib/board-details', () => ({
  getBoardRenderData: vi.fn(() => ({
    boardWidth: 1000,
    boardHeight: 1200,
    holdsData: mockHolds([1100, 1200, 1300, 1400]),
  })),
}));

vi.mock('../../lib/background-image-cache', () => ({
  tryGetBackgroundPathsSync: vi.fn(() => ({ paths: ['file:///bg.png'], missingCount: 0 })),
  ensureBackgroundsCached: vi.fn(async () => ({ paths: ['file:///bg.png'], missingCount: 0 })),
}));

const reportErrorMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/error-reporting', () => ({
  reportError: reportErrorMock,
  addErrorBreadcrumb: vi.fn(),
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
const pendingRenders = new Map<string, { resolve: (uri: string) => void }[]>();
const fakeNativeModule = {
  // Availability flag getNativeModule() checks; the hook calls the top-level
  // renderHoldsOverlay wrapper, not this object.
  boardRendererNative: {},
  renderHoldsOverlay: vi.fn(
    (_configJson: string, cacheKey: string) =>
      new Promise<string>((resolve) => {
        const pendingForKey = pendingRenders.get(cacheKey) ?? [];
        pendingForKey.push({ resolve });
        pendingRenders.set(cacheKey, pendingForKey);
      }),
  ),
};

const {
  useNativeClimbRender,
  buildCacheKey,
  _renderedOverlaysForTests,
  _cacheRenderedOverlayForTests,
  _inflightRendersForTests,
  _resetWarmupForTests,
  _setNativeModuleForTests,
  _unsupportedRenderSignaturesForTests,
  _MARKER_RENDERER_UNAVAILABLE_MESSAGE_FOR_TESTS,
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

function resolveNextRender(cacheKey: string, uri: string): void {
  const pending = pendingRenders.get(cacheKey)?.shift();
  if (!pending) throw new Error(`No pending render for ${cacheKey}`);
  pending.resolve(uri);
}

describe('useNativeClimbRender in-flight race', () => {
  beforeEach(() => {
    pendingRenders.clear();
    existingOverlayUris.clear();
    _resetWarmupForTests();
    _inflightRendersForTests.clear();
    fakeNativeModule.renderHoldsOverlay.mockClear();
    reportErrorMock.mockClear();
    _setNativeModuleForTests(fakeNativeModule as unknown as Parameters<typeof _setNativeModuleForTests>[0]);
  });

  it('discards a slow render resolution after props moved to a cached climb', async () => {
    const slowKey = cacheKeyFor(FRAMES_SLOW);
    const cachedKey = cacheKeyFor(FRAMES_CACHED);
    _cacheRenderedOverlayForTests(cachedKey, 'file:///overlay-cached.png');

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
      resolveNextRender(slowKey, 'file:///overlay-slow.png');
      await Promise.resolve();
    });
    expect(result.current.overlayUri).toBe('file:///overlay-cached.png');

    // The late result still landed in the cache for an instant hit on swipe-back.
    expect(_renderedOverlaysForTests.get(slowKey)?.uri).toBe('file:///overlay-slow.png');
    rerender({ frames: FRAMES_SLOW });
    await waitFor(() => expect(result.current.overlayUri).toBe('file:///overlay-slow.png'));
  });

  it('regenerates one missing cache entry and exposes a new load key even when the URI is unchanged', async () => {
    const cacheKey = cacheKeyFor(FRAMES_CACHED);
    const overlayUri = 'file:///overlay-cached.png';
    _cacheRenderedOverlayForTests(cacheKey, overlayUri);
    const { result } = renderHook(() => useNativeClimbRender({ ...BASE, frames: FRAMES_CACHED }));
    const failedLoadKey = result.current.overlayLoadKey;

    act(() => result.current.onOverlayError({ error: 'Failed to load resource' }, failedLoadKey));
    await waitFor(() => expect(pendingRenders.has(cacheKey)).toBe(true));
    expect(result.current.overlayUri).toBeNull();
    expect(fakeNativeModule.renderHoldsOverlay).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveNextRender(cacheKey, overlayUri);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.overlayUri).toBe(overlayUri));
    expect(result.current.overlayLoadKey).not.toBe(failedLoadKey);
  });

  it('withholds and repairs a missing overlay for a non-Image notification consumer', async () => {
    const cacheKey = cacheKeyFor(FRAMES_CACHED);
    const overlayUri = 'file:///notification-overlay.png';
    _cacheRenderedOverlayForTests(cacheKey, overlayUri);
    const { result } = renderHook(() =>
      useNativeClimbRender({ ...BASE, frames: FRAMES_CACHED, verifyOverlayFile: true }),
    );
    const failedLoadKey = result.current.overlayLoadKey;

    expect(result.current.overlayUri).toBeNull();
    await waitFor(() => expect(pendingRenders.has(cacheKey)).toBe(true));
    existingOverlayUris.add(overlayUri);
    await act(async () => {
      resolveNextRender(cacheKey, overlayUri);
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.overlayUri).toBe(overlayUri));
    expect(result.current.overlayLoadKey).not.toBe(failedLoadKey);
    expect(fakeNativeModule.renderHoldsOverlay).toHaveBeenCalledTimes(1);
  });

  it('revalidates an unchanged notification overlay at native use after its verified file is evicted', async () => {
    const cacheKey = cacheKeyFor(FRAMES_CACHED);
    const overlayUri = 'file:///notification-evicted-later.png';
    existingOverlayUris.add(overlayUri);
    _cacheRenderedOverlayForTests(cacheKey, overlayUri);
    const view = renderHook(() => useNativeClimbRender({ ...BASE, frames: FRAMES_CACHED, verifyOverlayFile: true }));
    await waitFor(() => expect(view.result.current.overlayUri).toBe(overlayUri));

    existingOverlayUris.delete(overlayUri);
    view.rerender();
    expect(view.result.current.overlayUri).toBe(overlayUri);
    expect(fakeNativeModule.renderHoldsOverlay).not.toHaveBeenCalled();

    act(() => {
      expect(
        view.result.current.verifyOverlayForNativeUse(
          view.result.current.overlayUri,
          view.result.current.overlayLoadKey,
        ),
      ).toBeNull();
    });

    await waitFor(() => expect(view.result.current.overlayUri).toBeNull());
    await waitFor(() => expect(pendingRenders.has(cacheKey)).toBe(true));
  });

  it('repairs two same-key native-use evictions after each exact replacement verifies', async () => {
    const cacheKey = cacheKeyFor(FRAMES_CACHED);
    const overlayUri = 'file:///notification-evicted-twice.png';
    existingOverlayUris.add(overlayUri);
    _cacheRenderedOverlayForTests(cacheKey, overlayUri);
    const view = renderHook(() => useNativeClimbRender({ ...BASE, frames: FRAMES_CACHED, verifyOverlayFile: true }));
    await waitFor(() => expect(view.result.current.overlayUri).toBe(overlayUri));

    existingOverlayUris.delete(overlayUri);
    act(() => {
      expect(
        view.result.current.verifyOverlayForNativeUse(
          view.result.current.overlayUri,
          view.result.current.overlayLoadKey,
        ),
      ).toBeNull();
    });
    await waitFor(() => expect(fakeNativeModule.renderHoldsOverlay).toHaveBeenCalledTimes(1));
    existingOverlayUris.add(overlayUri);
    await act(async () => {
      resolveNextRender(cacheKey, overlayUri);
      await Promise.resolve();
    });
    await waitFor(() => expect(view.result.current.overlayUri).toBe(overlayUri));

    existingOverlayUris.delete(overlayUri);
    act(() => {
      expect(
        view.result.current.verifyOverlayForNativeUse(
          view.result.current.overlayUri,
          view.result.current.overlayLoadKey,
        ),
      ).toBeNull();
    });
    await waitFor(() => expect(fakeNativeModule.renderHoldsOverlay).toHaveBeenCalledTimes(2));
    existingOverlayUris.add(overlayUri);
    await act(async () => {
      resolveNextRender(cacheKey, overlayUri);
      await Promise.resolve();
    });
    await waitFor(() => expect(view.result.current.overlayUri).toBe(overlayUri));
  });

  it('deduplicates simultaneous repairs across mounted consumers', async () => {
    const cacheKey = cacheKeyFor(FRAMES_CACHED);
    const overlayUri = 'file:///shared.png';
    _cacheRenderedOverlayForTests(cacheKey, overlayUri);
    const first = renderHook(() => useNativeClimbRender({ ...BASE, frames: FRAMES_CACHED }));
    const second = renderHook(() => useNativeClimbRender({ ...BASE, frames: FRAMES_CACHED }));
    const firstLoadKey = first.result.current.overlayLoadKey;
    const secondLoadKey = second.result.current.overlayLoadKey;

    act(() => {
      first.result.current.onOverlayError({ error: 'Failed to load resource' }, firstLoadKey);
      second.result.current.onOverlayError({ error: 'Failed to load resource' }, secondLoadKey);
    });
    await waitFor(() => expect(pendingRenders.has(cacheKey)).toBe(true));
    expect(fakeNativeModule.renderHoldsOverlay).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveNextRender(cacheKey, overlayUri);
      await Promise.resolve();
    });
    await waitFor(() => expect(first.result.current.overlayUri).toBe(overlayUri));
    await waitFor(() => expect(second.result.current.overlayUri).toBe(overlayUri));
  });

  it('lets a delayed second consumer adopt the generation committed by the first repair', async () => {
    const cacheKey = cacheKeyFor(FRAMES_CACHED);
    const overlayUri = 'file:///delayed-peer.png';
    const failedEntry = _cacheRenderedOverlayForTests(cacheKey, overlayUri);
    const first = renderHook(() => useNativeClimbRender({ ...BASE, frames: FRAMES_CACHED }));
    const second = renderHook(() => useNativeClimbRender({ ...BASE, frames: FRAMES_CACHED }));
    const delayedSecondError = second.result.current.onOverlayError;
    const delayedSecondLoadKey = second.result.current.overlayLoadKey;

    act(() =>
      first.result.current.onOverlayError({ error: 'First consumer failed' }, first.result.current.overlayLoadKey),
    );
    await waitFor(() => expect(pendingRenders.has(cacheKey)).toBe(true));
    await act(async () => {
      resolveNextRender(cacheKey, overlayUri);
      await Promise.resolve();
    });
    await waitFor(() => expect(first.result.current.overlayUri).toBe(overlayUri));
    const repairedEntry = _renderedOverlaysForTests.get(cacheKey);
    expect(repairedEntry?.generation).not.toBe(failedEntry.generation);
    const reportsBeforeDelayedError = reportErrorMock.mock.calls.length;

    act(() => delayedSecondError({ error: 'Delayed second-consumer failure' }, delayedSecondLoadKey));

    expect(_renderedOverlaysForTests.get(cacheKey)).toEqual(repairedEntry);
    expect(second.result.current.overlayUri).toBe(overlayUri);
    expect(second.result.current.overlayLoadKey).toBe(`${repairedEntry?.generation}:1`);
    expect(fakeNativeModule.renderHoldsOverlay).toHaveBeenCalledTimes(1);
    expect(reportErrorMock).toHaveBeenCalledTimes(reportsBeforeDelayedError);
  });

  it('preserves a peer repair and remounts only the failed consumer', () => {
    const cacheKey = cacheKeyFor(FRAMES_CACHED);
    const overlayUri = 'file:///same-path.png';
    _cacheRenderedOverlayForTests(cacheKey, overlayUri);
    const { result } = renderHook(() => useNativeClimbRender({ ...BASE, frames: FRAMES_CACHED }));
    const failedLoadKey = result.current.overlayLoadKey;
    const peerReplacement = _cacheRenderedOverlayForTests(cacheKey, overlayUri);

    act(() => result.current.onOverlayError({ error: 'Failed to load resource' }, failedLoadKey));

    expect(_renderedOverlaysForTests.get(cacheKey)).toEqual(peerReplacement);
    expect(result.current.overlayUri).toBe(overlayUri);
    expect(result.current.overlayLoadKey).not.toBe(failedLoadKey);
    expect(fakeNativeModule.renderHoldsOverlay).not.toHaveBeenCalled();
  });

  it('adopts a same-URI peer rewrite before classifying its existing file as terminal', () => {
    const cacheKey = cacheKeyFor(FRAMES_CACHED);
    const overlayUri = 'file:///same-path-existing.png';
    const failedEntry = _cacheRenderedOverlayForTests(cacheKey, overlayUri);
    const { result } = renderHook(() => useNativeClimbRender({ ...BASE, frames: FRAMES_CACHED }));
    const failedOnError = result.current.onOverlayError;
    const failedLoadKey = result.current.overlayLoadKey;

    // A peer rewrites the native cache path while generation A's Image error
    // is still queued. The path now exists because it contains generation B.
    const peerReplacement = _cacheRenderedOverlayForTests(cacheKey, overlayUri);
    existingOverlayUris.add(overlayUri);
    expect(peerReplacement.generation).not.toBe(failedEntry.generation);

    act(() => failedOnError({ error: 'Delayed generation A failure' }, failedLoadKey));

    expect(_renderedOverlaysForTests.get(cacheKey)).toEqual(peerReplacement);
    expect(result.current.overlayUri).toBe(overlayUri);
    expect(result.current.overlayLoadKey).toBe(`${peerReplacement.generation}:1`);
    expect(result.current.overlayLoadKey).not.toBe(failedLoadKey);
    expect(fakeNativeModule.renderHoldsOverlay).not.toHaveBeenCalled();
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it('ignores a stale error callback after props move to another cache key', () => {
    const oldKey = cacheKeyFor(FRAMES_SLOW);
    const currentKey = cacheKeyFor(FRAMES_CACHED);
    _cacheRenderedOverlayForTests(oldKey, 'file:///old.png');
    _cacheRenderedOverlayForTests(currentKey, 'file:///current.png');
    const { result, rerender } = renderHook(
      (props: { frames: string }) => useNativeClimbRender({ ...BASE, ...props }),
      { initialProps: { frames: FRAMES_SLOW } },
    );
    const staleOnError = result.current.onOverlayError;
    const staleLoadKey = result.current.overlayLoadKey;

    rerender({ frames: FRAMES_CACHED });
    act(() => staleOnError({ error: 'Failed to load resource' }, staleLoadKey));

    expect(result.current.overlayUri).toBe('file:///current.png');
    expect(_renderedOverlaysForTests.has(oldKey)).toBe(true);
    expect(_renderedOverlaysForTests.has(currentKey)).toBe(true);
    expect(fakeNativeModule.renderHoldsOverlay).not.toHaveBeenCalled();
  });

  it('keeps overlay callbacks stable while the current attempt changes', async () => {
    const cacheKey = cacheKeyFor(FRAMES_CACHED);
    const overlayUri = 'file:///stable-callbacks.png';
    _cacheRenderedOverlayForTests(cacheKey, overlayUri);
    const { result } = renderHook(() => useNativeClimbRender({ ...BASE, frames: FRAMES_CACHED }));
    const initialOnLoad = result.current.onOverlayLoad;
    const initialOnError = result.current.onOverlayError;
    const initialVerifyForNativeUse = result.current.verifyOverlayForNativeUse;
    const initialLoadKey = result.current.overlayLoadKey;

    act(() => result.current.onOverlayError({ error: 'Failed to load resource' }, initialLoadKey));
    await waitFor(() => expect(pendingRenders.has(cacheKey)).toBe(true));
    await act(async () => {
      resolveNextRender(cacheKey, overlayUri);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.overlayUri).toBe(overlayUri));

    expect(result.current.onOverlayLoad).toBe(initialOnLoad);
    expect(result.current.onOverlayError).toBe(initialOnError);
    expect(result.current.verifyOverlayForNativeUse).toBe(initialVerifyForNativeUse);
  });

  it('remounts a present-file decode failure with the same URI and ignores its stale old attempt', () => {
    const cacheKey = cacheKeyFor(FRAMES_CACHED);
    const overlayUri = 'file:///stale-same-consumer.png';
    existingOverlayUris.add(overlayUri);
    _cacheRenderedOverlayForTests(cacheKey, overlayUri);
    const { result } = renderHook(() => useNativeClimbRender({ ...BASE, frames: FRAMES_CACHED }));
    const stableOnError = result.current.onOverlayError;
    const staleLoadKey = result.current.overlayLoadKey;

    act(() => stableOnError({ error: 'Transient decode failure' }, staleLoadKey));
    const replacementLoadKey = result.current.overlayLoadKey;

    expect(result.current.overlayUri).toBe(overlayUri);
    expect(replacementLoadKey).not.toBe(staleLoadKey);
    expect(_renderedOverlaysForTests.get(cacheKey)?.uri).toBe(overlayUri);
    expect(fakeNativeModule.renderHoldsOverlay).not.toHaveBeenCalled();

    act(() => stableOnError({ error: 'Queued old-attempt failure' }, staleLoadKey));

    expect(result.current.overlayUri).toBe(overlayUri);
    expect(result.current.overlayLoadKey).toBe(replacementLoadKey);
    expect(_renderedOverlaysForTests.has(cacheKey)).toBe(true);
  });

  it('stops after one retry until the exact replacement reports onLoad', async () => {
    const cacheKey = cacheKeyFor(FRAMES_CACHED);
    const overlayUri = 'file:///retry-budget.png';
    _cacheRenderedOverlayForTests(cacheKey, overlayUri);
    const { result } = renderHook(() => useNativeClimbRender({ ...BASE, frames: FRAMES_CACHED }));
    const firstLoadKey = result.current.overlayLoadKey;

    act(() => result.current.onOverlayError({ error: 'Failed to load resource' }, firstLoadKey));
    await waitFor(() => expect(pendingRenders.has(cacheKey)).toBe(true));
    await act(async () => {
      resolveNextRender(cacheKey, overlayUri);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.overlayUri).toBe(overlayUri));

    act(() => result.current.onOverlayError({ error: 'Failed to load resource' }, result.current.overlayLoadKey));
    expect(result.current.overlayUri).toBeNull();
    expect(fakeNativeModule.renderHoldsOverlay).toHaveBeenCalledTimes(1);
  });

  it('replenishes the retry budget when native-use validation acknowledges the exact remount', async () => {
    const cacheKey = cacheKeyFor(FRAMES_CACHED);
    const overlayUri = 'file:///retry-reset.png';
    existingOverlayUris.add(overlayUri);
    _cacheRenderedOverlayForTests(cacheKey, overlayUri);
    const { result } = renderHook(() =>
      useNativeClimbRender({ ...BASE, frames: FRAMES_CACHED, verifyOverlayFile: true }),
    );
    const firstLoadKey = result.current.overlayLoadKey;

    act(() => result.current.onOverlayError({ error: 'Failed to load resource' }, firstLoadKey));
    await waitFor(() => expect(result.current.overlayLoadKey).not.toBe(firstLoadKey));
    const verifiedRetryLoadKey = result.current.overlayLoadKey;
    act(() => result.current.onOverlayError({ error: 'Failed to load resource' }, verifiedRetryLoadKey));

    await waitFor(() => expect(result.current.overlayLoadKey).not.toBe(verifiedRetryLoadKey));
    expect(result.current.overlayUri).toBe(overlayUri);
    expect(fakeNativeModule.renderHoldsOverlay).not.toHaveBeenCalled();
  });

  it('stops a persistent existing-file decode failure after one remount and reports both classes without identifiers', () => {
    const cacheKey = cacheKeyFor(FRAMES_CACHED);
    const overlayUri = 'file:///private/cache/path.png';
    existingOverlayUris.add(overlayUri);
    _cacheRenderedOverlayForTests(cacheKey, overlayUri);
    const { result } = renderHook(() => useNativeClimbRender({ ...BASE, frames: FRAMES_CACHED }));
    const firstLoadKey = result.current.overlayLoadKey;

    act(() => result.current.onOverlayError({ error: `decode failed at ${overlayUri}` }, firstLoadKey));
    expect(result.current.overlayUri).toBe(overlayUri);
    expect(result.current.overlayLoadKey).not.toBe(firstLoadKey);

    act(() =>
      result.current.onOverlayError(
        { error: `persistent decode failed at ${overlayUri}` },
        result.current.overlayLoadKey,
      ),
    );

    expect(result.current.overlayUri).toBeNull();
    expect(fakeNativeModule.renderHoldsOverlay).not.toHaveBeenCalled();
    expect(reportErrorMock).toHaveBeenCalledTimes(2);
    expect(reportErrorMock.mock.calls.map(([error]) => (error as Error).message)).toEqual([
      'Generated overlay image load failed: cache_entry_present',
      'Generated overlay image load failed: retry_exhausted',
    ]);
    expect(JSON.stringify(reportErrorMock.mock.calls)).not.toContain(overlayUri);
    expect(JSON.stringify(reportErrorMock.mock.calls)).not.toContain(cacheKey);
  });
});

// Issue #4240: a renderer that cannot honour a config's marker overrides is a
// designed capability fallback, not a defect. Before this, the throw was
// reported to Sentry once per climb — and because Grasshopper's board-level
// stroke default leaves the render signature at DEFAULT_HOLD_COLOR_SIGNATURE,
// the "record the signature and stop retrying" throttle never engaged (29
// events in 60 seconds from one browser session).
describe('capability-fallback render rejections', () => {
  const rejectingNativeModule = {
    boardRendererNative: {},
    renderHoldsOverlay: vi.fn<(configJson: string, cacheKey: string) => Promise<string>>(),
  };

  beforeEach(() => {
    existingOverlayUris.clear();
    _resetWarmupForTests();
    _renderedOverlaysForTests.clear();
    _inflightRendersForTests.clear();
    _unsupportedRenderSignaturesForTests.clear();
    reportErrorMock.mockClear();
    rejectingNativeModule.renderHoldsOverlay.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    _setNativeModuleForTests(rejectingNativeModule as unknown as Parameters<typeof _setNativeModuleForTests>[0]);
  });

  it('does not report the marker-unavailable fallback, and never poisons the default signature', async () => {
    rejectingNativeModule.renderHoldsOverlay.mockRejectedValue(
      new Error(_MARKER_RENDERER_UNAVAILABLE_MESSAGE_FOR_TESTS),
    );

    renderHook(() => useNativeClimbRender({ ...BASE, frames: FRAMES_SLOW }));

    await waitFor(() => expect(rejectingNativeModule.renderHoldsOverlay).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(console.warn).toHaveBeenCalled());

    expect(reportErrorMock).not.toHaveBeenCalled();
    // The default signature is consulted for every render on every board —
    // adding it here would blank the overlay app-wide.
    expect(_unsupportedRenderSignaturesForTests.size).toBe(0);
  });

  it('still reports an unrelated render failure', async () => {
    rejectingNativeModule.renderHoldsOverlay.mockRejectedValue(new Error('some native failure'));

    renderHook(() => useNativeClimbRender({ ...BASE, frames: FRAMES_SLOW }));

    await waitFor(() => expect(reportErrorMock).toHaveBeenCalledTimes(1));
    // Reported through a stable synthetic message with the original as `cause`
    // (issue #3647): Sentry groups on the message, and the native errors
    // interpolate the cache filename, so reporting the raw error minted a new
    // issue group per climb. The original text still rides along in `extra`.
    const [reported, options] = reportErrorMock.mock.calls[0] as [Error, Record<string, unknown>];
    expect(reported.message).toBe('Board overlay render failed: render_failed');
    expect((reported.cause as Error).message).toBe('some native failure');
    expect((options.extra as Record<string, unknown>).renderErrorMessage).toBe('some native failure');
  });
});
