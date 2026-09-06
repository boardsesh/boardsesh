// @vitest-environment jsdom
//
// Render failures used to be invisible.
//
// Field shape: on iOS, the Aura look on Kilter Original 12x12 stopped drawing
// the play board's hold overlay after ~7 swipes and never came back until the
// app was restarted — thumbnails kept working the whole time. Nothing in the
// app could say why. The native rejection was a `console.warn` plus ONE Sentry
// event per failure kind per JS lifetime, the expo-image load failures were the
// same, and there was no product-analytics event for a mobile render failure at
// all. So a session that failed every render after a point looked, in every
// dashboard we have, exactly like a session that never failed.
//
// Two things are asserted here:
//
//  1. Every failure — both stages, capability fallbacks included — fires
//     `Board Render Failed`, carrying enough to stratify (board, drawing,
//     surface) and nothing that identifies a file or a climb.
//  2. A native `render_failed` retries itself exactly ONCE per cache key, so a
//     stationary play board repairs itself instead of sitting blank, and a
//     recycled FlashList row can never turn that into a storm.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

vi.mock('../../providers/theme-provider', () => ({ useAppColorScheme: () => 'light' }));

/** Overlay URIs the cache directory currently holds. */
const existingOverlayUris = vi.hoisted(() => new Set<string>());
class MockFile {
  constructor(private readonly uri: string) {}
  get exists(): boolean {
    return existingOverlayUris.has(this.uri);
  }
  get name(): string {
    return this.uri;
  }
}

vi.mock('expo-file-system', () => ({
  Directory: vi.fn(() => ({ exists: false, list: () => [] })),
  File: MockFile,
  Paths: {
    cache: { uri: 'file:///cache/' },
    // Plenty of room, so nothing here is ever misread as a full disk.
    availableDiskSpace: 8 * 1024 * 1024 * 1024,
  },
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
    holdsData: mockHolds([1100, 1200, 1500, 1600, 9999, ...Array.from({ length: 40 }, (_, index) => 2000 + index)]),
  })),
}));

vi.mock('../../lib/background-image-cache', () => ({
  tryGetBackgroundPathsSync: vi.fn(() => ({ paths: ['file:///bg.png'], missingCount: 0 })),
  ensureBackgroundsCached: vi.fn(async () => ({ paths: ['file:///bg.png'], missingCount: 0 })),
}));

const reportErrorMock = vi.hoisted(() => vi.fn());
const addErrorBreadcrumbMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/error-reporting', () => ({
  reportError: reportErrorMock,
  addErrorBreadcrumb: addErrorBreadcrumbMock,
}));

const trackMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/analytics', () => ({ track: trackMock }));

vi.mock('../../lib/hold-color-overrides', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/hold-color-overrides')>();
  // Referentially STABLE: these feed the overlay effect's deps, and a fresh
  // object per render would re-fire it every tick.
  const stableOverrides = {
    overrides: {},
    shapes: {},
    brushThickness: original.DEFAULT_HOLD_BRUSH_THICKNESS,
    shapeSize: original.DEFAULT_HOLD_SHAPE_SIZE,
    renderSignature: original.DEFAULT_HOLD_COLOR_SIGNATURE,
  };
  return { ...original, useHoldColorOverrides: () => stableOverrides };
});

/** What the native renderer rejects with, per test. */
const renderRejection = vi.hoisted(() => ({ message: 'Rust render failed with code -2' }));

const fakeNativeModule = {
  boardRendererNative: {},
  // Typed rather than inferred: the default implementation only ever rejects,
  // so an inferred `Promise<never>` would reject any suite that installs a
  // render which actually resolves (or never settles at all).
  renderHoldsOverlay: vi.fn<(configJson: string, cacheKey: string) => Promise<string>>(() =>
    Promise.reject(new Error(renderRejection.message)),
  ),
};

const {
  useNativeClimbRender,
  buildCacheKey,
  _cacheRenderedOverlayForTests,
  _inflightRendersForTests,
  _renderedOverlaysForTests,
  _resetWarmupForTests,
  _setNativeModuleForTests,
  _RENDER_FAILURE_EVENT_CAP_FOR_TESTS,
  _CONFIG_FAILURE_EVENT_CAP_FOR_TESTS,
  _MARKER_RENDERER_UNAVAILABLE_MESSAGE_FOR_TESTS,
} = await import('../use-native-climb-render');

const BASE = { boardName: 'kilter' as const, layoutId: 1, sizeId: 10, setIds: '26,27', filledStyle: false };
const FRAMES = 'p1100r12p1200r13';

type FailureProperties = {
  board_name: string;
  layout_id: number;
  size_id: number;
  render_mode: string;
  glow_falloff: string;
  glow_falloff_source: string;
  surface: string;
  stage: string;
  failure_kind: string;
  error_code: string;
  render_width: number | null;
  frames_length: number;
  failures_this_session: number;
};

/** Every `Board Render Failed` fired so far, in order. */
function failureEvents(): FailureProperties[] {
  return trackMock.mock.calls
    .filter(([name]) => name === 'Board Render Failed')
    .map(([, properties]) => properties as FailureProperties);
}

function renderRow(
  overrides: { frames?: string; filledStyle?: boolean; renderWidth?: number; playSurface?: boolean } = {},
) {
  return renderHook(() => useNativeClimbRender({ ...BASE, frames: FRAMES, ...overrides }));
}

function cacheKeyFor(frames: string): string {
  return buildCacheKey(BASE.boardName, BASE.layoutId, BASE.sizeId, BASE.setIds, frames, BASE.filledStyle);
}

// The Aura capability probe and the render-settings store both latch MODULE-wide
// on the first mount, and each resolution re-runs the overlay effect — so the
// very first row rendered in a file fails more than once and every later row
// exactly once. Settle those latches on a throwaway row, so a per-test failure
// count means what it says.
beforeAll(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  _setNativeModuleForTests(fakeNativeModule as unknown as Parameters<typeof _setNativeModuleForTests>[0]);
  const warmup = renderRow({ frames: 'p9999r12' });
  await waitFor(() => expect(fakeNativeModule.renderHoldsOverlay).toHaveBeenCalled());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  warmup.unmount();
});

beforeEach(() => {
  renderRejection.message = 'Rust render failed with code -2';
  existingOverlayUris.clear();
  // Resets the whole module's failure state, not just the warm-up latch: the
  // overlay index, `reportedOverlayLoadTelemetry` (Sentry's once-per-kind set),
  // `reportedRenderFailures`, the disk back-off and the per-lifetime failure
  // counter. Without it the counter would carry the beforeAll warm-up's
  // failures into every `failures_this_session` assertion below.
  _resetWarmupForTests();
  _renderedOverlaysForTests.clear();
  _inflightRendersForTests.clear();
  trackMock.mockClear();
  reportErrorMock.mockClear();
  addErrorBreadcrumbMock.mockClear();
  fakeNativeModule.renderHoldsOverlay.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  _setNativeModuleForTests(fakeNativeModule as unknown as Parameters<typeof _setNativeModuleForTests>[0]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Board Render Failed — the native stage', () => {
  it('reports a native rejection with the board, the surface and a bucketed error code', async () => {
    renderRow();
    await waitFor(() => expect(failureEvents()).toHaveLength(1));

    expect(failureEvents()[0]).toMatchObject({
      board_name: 'kilter',
      layout_id: 1,
      size_id: 10,
      stage: 'native',
      failure_kind: 'render_failed',
      error_code: 'code_-2',
      surface: 'full',
      render_width: null,
      frames_length: FRAMES.length,
      failures_this_session: 1,
    });
    // The stratification props ride along on a failure too — a failure rate
    // pooled across Aura and classic answers nothing.
    expect(typeof failureEvents()[0].render_mode).toBe('string');
    expect(typeof failureEvents()[0].glow_falloff_source).toBe('string');
  });

  it('names the thumbnail surface separately', async () => {
    renderRow({ filledStyle: true, renderWidth: 400 });
    await waitFor(() => expect(failureEvents()).toHaveLength(1));

    expect(failureEvents()[0]).toMatchObject({ surface: 'thumbnail', render_width: 400 });
  });

  // Twelve call sites render a board at full size — preview cards and rails, the
  // preview sheet, the reaction menu, the wall kiosk hero, the carousel's
  // off-screen peek. Only the play drawer's CURRENT card opts in, so `play` has
  // to be its own value: a rate pooled with the others describes nothing anyone
  // experienced.
  it('separates the one board the climber is looking at from every other full-size surface', async () => {
    renderRow({ playSurface: true });
    await waitFor(() => expect(failureEvents()).toHaveLength(1));
    expect(failureEvents()[0].surface).toBe('play');

    trackMock.mockClear();
    renderRow({ frames: 'p1500r12p1600r13' });
    await waitFor(() => expect(failureEvents()).toHaveLength(1));
    expect(failureEvents()[0].surface).toBe('full');
  });

  // The message interpolates the cache key and the cache path. Neither may
  // reach an event property — it is the climb the climber is looking at, and it
  // would shatter the event into one group per file.
  it('sends nothing derived from the message, the filename or the cache key', async () => {
    renderRejection.message = 'You can’t save the file “v5_secret-cache-key.png” because the volume is out of space';
    renderRow();
    await waitFor(() => expect(failureEvents()).toHaveLength(1));

    const serialized = JSON.stringify(failureEvents()[0]);
    expect(serialized).not.toContain('secret-cache-key');
    expect(serialized).not.toContain('.png');
    expect(serialized).not.toContain('file:///');
  });

  // A binary that cannot honour a config's marker overrides is a designed
  // fallback, so Sentry deliberately never hears about it (#4240). That is
  // exactly why it has to be visible somewhere else: the climber is looking at a
  // different drawing than the one they chose.
  it('reports the capability fallback that Sentry is told to ignore', async () => {
    renderRejection.message = _MARKER_RENDERER_UNAVAILABLE_MESSAGE_FOR_TESTS;
    renderRow();
    await waitFor(() => expect(failureEvents().length).toBeGreaterThan(0));

    expect(failureEvents()[0]).toMatchObject({
      stage: 'native',
      failure_kind: 'capability_fallback',
      error_code: 'capability',
    });
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it('leaves a breadcrumb for every failure, even the ones Sentry never reports', async () => {
    renderRejection.message = _MARKER_RENDERER_UNAVAILABLE_MESSAGE_FOR_TESTS;
    renderRow();
    await waitFor(() => expect(addErrorBreadcrumbMock).toHaveBeenCalled());

    const breadcrumb = addErrorBreadcrumbMock.mock.calls[0][0] as { category: string; message: string };
    expect(breadcrumb).toMatchObject({
      category: 'board-render',
      message: 'Board render failed: native/capability_fallback/capability',
    });
    expect(breadcrumb.message).not.toContain('.png');
  });

  // The Sentry report is once per kind per JS lifetime, so the FIRST failure is
  // the only one anyone ever sees. Without the running count that report cannot
  // say whether it was a one-off or the first of hundreds.
  it('tells the one Sentry report how many failures the session has seen', async () => {
    renderRow();
    await waitFor(() => expect(reportErrorMock).toHaveBeenCalled());

    const [, options] = reportErrorMock.mock.calls[0] as [Error, { extra: Record<string, unknown> }];
    expect(options.extra.failuresThisSession).toBe(1);
  });
});

describe('Board Render Failed — the image-load stage', () => {
  it('reports an expo-image load failure under its own stage', async () => {
    _cacheRenderedOverlayForTests(cacheKeyFor(FRAMES), 'file:///overlay-cached.png');
    const { result } = renderRow();

    act(() => result.current.onOverlayError({ error: 'Failed to load resource' }, result.current.overlayLoadKey));

    await waitFor(() => expect(failureEvents().length).toBeGreaterThan(0));
    expect(failureEvents()[0]).toMatchObject({
      stage: 'image_load',
      failure_kind: 'cache_entry_missing',
      board_name: 'kilter',
      surface: 'full',
    });
  });

  it('buckets what expo-image said rather than passing the message through', async () => {
    _cacheRenderedOverlayForTests(cacheKeyFor(FRAMES), 'file:///overlay-cached.png');
    const { result } = renderRow();

    act(() => result.current.onOverlayError({ error: 'PNG decoder returned null' }, result.current.overlayLoadKey));

    await waitFor(() => expect(failureEvents().length).toBeGreaterThan(0));
    expect(failureEvents()[0].error_code).toBe('png');
  });

  // PostHog is counting IMAGES THAT FAILED, so one `onError` must be one event.
  // The terminal path used to fire the entry kind AND `retry_exhausted`, which
  // made two real errors read as three failures and burned the budget a third
  // early — while Sentry still wants both classes.
  it('counts one failure per image error, even on the terminal path', async () => {
    // A file that IS on disk and still will not decode: the path that spends the
    // retry budget without invalidating anything, so two errors stay two errors
    // with no render in between.
    const overlayUri = 'file:///overlay-present.png';
    _cacheRenderedOverlayForTests(cacheKeyFor(FRAMES), overlayUri);
    existingOverlayUris.add(overlayUri);
    const { result } = renderRow();

    const imageLoadEvents = () => failureEvents().filter((event) => event.stage === 'image_load');

    // First error spends the one retry; the second is terminal.
    act(() => result.current.onOverlayError({ error: 'Failed to load' }, result.current.overlayLoadKey));
    await waitFor(() => expect(imageLoadEvents()).toHaveLength(1));
    expect(imageLoadEvents()[0].failure_kind).toBe('cache_entry_present');

    act(() => result.current.onOverlayError({ error: 'Failed to load' }, result.current.overlayLoadKey));
    await waitFor(() => expect(imageLoadEvents()).toHaveLength(2));

    // Two errors, two failures — never three.
    expect(imageLoadEvents()[1].failure_kind).toBe('retry_exhausted');
    // Sentry still hears both classes on that terminal error.
    const sentryKinds = reportErrorMock.mock.calls
      .map(([error]) => String((error as Error).message))
      .filter((message) => message.startsWith('Generated overlay image load failed'));
    expect(sentryKinds).toContain('Generated overlay image load failed: cache_entry_present');
    expect(sentryKinds).toContain('Generated overlay image load failed: retry_exhausted');
  });

  // Sentry's guard here is once-per-kind too. The PostHog event is what turns
  // "it happened at least once this launch" into a rate.
  it('keeps reporting to PostHog after Sentry has gone quiet for that kind', async () => {
    _cacheRenderedOverlayForTests(cacheKeyFor(FRAMES), 'file:///overlay-a.png');
    const rowA = renderRow();
    act(() => rowA.result.current.onOverlayError({ error: 'Failed to load' }, rowA.result.current.overlayLoadKey));

    const otherFrames = 'p1500r12p1600r13';
    _cacheRenderedOverlayForTests(cacheKeyFor(otherFrames), 'file:///overlay-b.png');
    const rowB = renderRow({ frames: otherFrames });
    act(() => rowB.result.current.onOverlayError({ error: 'Failed to load' }, rowB.result.current.overlayLoadKey));

    await waitFor(() => expect(failureEvents().filter((event) => event.stage === 'image_load')).toHaveLength(2));
    const sentryImageLoadReports = reportErrorMock.mock.calls.filter(([error]) =>
      String((error as Error).message).startsWith('Generated overlay image load failed'),
    );
    expect(sentryImageLoadReports).toHaveLength(1);
  });
});

describe('one bounded self-retry after a native render failure', () => {
  it('retries a failed key exactly once, then leaves it alone', async () => {
    vi.useFakeTimers();
    renderRow();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fakeNativeModule.renderHoldsOverlay).toHaveBeenCalledTimes(1);

    // The retry lands, re-enters the render path, and fails again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(fakeNativeModule.renderHoldsOverlay).toHaveBeenCalledTimes(2);

    // …and that is the end of it. A second retry for the same key is the storm
    // the keyed guard exists to prevent.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fakeNativeModule.renderHoldsOverlay).toHaveBeenCalledTimes(2);
  });

  it('does not retry a full disk — the back-off owns that path', async () => {
    renderRejection.message = 'write failed: ENOSPC (No space left on device)';
    vi.useFakeTimers();
    renderRow();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(failureEvents()[0]).toMatchObject({ failure_kind: 'disk_full' });
    const callsAfterFirstFailure = fakeNativeModule.renderHoldsOverlay.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    // The 60s disk back-off is the only thing allowed to bring this key back.
    expect(fakeNativeModule.renderHoldsOverlay.mock.calls.length).toBe(callsAfterFirstFailure);
  });

  it('does not retry a capability fallback — the degraded re-render is the retry', async () => {
    renderRejection.message = _MARKER_RENDERER_UNAVAILABLE_MESSAGE_FOR_TESTS;
    vi.useFakeTimers();
    renderRow();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const callsAfterFirstFailure = fakeNativeModule.renderHoldsOverlay.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(fakeNativeModule.renderHoldsOverlay.mock.calls.length).toBe(callsAfterFirstFailure);
  });

  it('drops a pending retry when the surface unmounts', async () => {
    vi.useFakeTimers();
    const { unmount } = renderRow();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(fakeNativeModule.renderHoldsOverlay).toHaveBeenCalledTimes(1);
  });
});

// The failure the Android emulator repro pinned down: the native render
// SUCCEEDS and writes a veil-only PNG, because the climb's frames name
// placement ids this board config has no holds for (a Kilter Homewall climb,
// ids 4000+, drawn under Kilter Original 12x12). The Rust renderer drops every
// unmatched hold and returns Ok — no rejection, nothing logged.
describe('Board Render Failed — the config stage', () => {
  const OFF_BOARD_FRAMES = 'p4000r12p4001r13';

  it('reports a climb whose frames match no hold on this board, and skips the render', async () => {
    renderRow({ frames: OFF_BOARD_FRAMES });
    await waitFor(() => expect(failureEvents()).toHaveLength(1));

    expect(failureEvents()[0]).toMatchObject({
      stage: 'config',
      failure_kind: 'no_matching_holds',
      error_code: 'no_matching_holds',
      board_name: 'kilter',
      lit_count: 2,
      unmatched_count: 2,
    });
    // Rendering would write and cache a veil with nothing on it, which makes
    // the same failure quieter every time the climber comes back to it.
    expect(fakeNativeModule.renderHoldsOverlay).not.toHaveBeenCalled();
  });

  it('still renders a climb that only partly overhangs the board', async () => {
    // 1100 exists on the fixture board, 4000 does not.
    renderRow({ frames: 'p1100r12p4000r13' });
    await waitFor(() => expect(failureEvents()).toHaveLength(1));

    expect(failureEvents()[0]).toMatchObject({
      stage: 'config',
      failure_kind: 'partial_hold_match',
      error_code: 'partial_hold_match',
      lit_count: 2,
      unmatched_count: 1,
    });
    // Degraded is not blank: the holds that do exist still get drawn.
    expect(fakeNativeModule.renderHoldsOverlay).toHaveBeenCalledTimes(1);
  });

  // Nothing is cached when the render is skipped, so the cached-entry
  // short-circuit at the top of the effect cannot absorb a swipe back — without
  // a keyed guard the same unanswerable question spends the session budget
  // again every time the climber returns to the climb.
  it('reports one mismatch per climb, not one per effect run', async () => {
    const { rerender } = renderHook(({ frames }) => useNativeClimbRender({ ...BASE, frames }), {
      initialProps: { frames: OFF_BOARD_FRAMES },
    });
    await waitFor(() => expect(failureEvents()).toHaveLength(1));

    rerender({ frames: FRAMES });
    rerender({ frames: OFF_BOARD_FRAMES });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(failureEvents().filter((event) => event.stage === 'config')).toHaveLength(1);
  });

  // The regression that would have shipped: builds before this fix cached
  // veil-only PNGs under the SAME RENDERER_VERSION, and the startup warm-up scan
  // restores them from disk. With the check below the cache lookup, that entry
  // was handed straight back — so everyone who already hit the bug would have
  // kept a blank board forever, silently, even on the fixed build.
  it('evicts a veil-only overlay an earlier build cached, instead of serving it forever', async () => {
    const staleKey = cacheKeyFor(OFF_BOARD_FRAMES);
    _cacheRenderedOverlayForTests(staleKey, 'file:///stale-veil.png');
    expect(_renderedOverlaysForTests.get(staleKey)?.uri).toBe('file:///stale-veil.png');

    const { result } = renderRow({ frames: OFF_BOARD_FRAMES });
    await waitFor(() => expect(failureEvents()).toHaveLength(1));

    expect(failureEvents()[0].failure_kind).toBe('no_matching_holds');
    // Gone from the index, and never surfaced to the view layer.
    expect(_renderedOverlaysForTests.get(staleKey)).toBeUndefined();
    expect(result.current.overlayUri).toBeNull();
    expect(fakeNativeModule.renderHoldsOverlay).not.toHaveBeenCalled();
  });

  // The state seed reads the index during the first render, so a stale entry is
  // already on screen before the effect runs. Dropping it from the index alone
  // would leave it painted.
  it('takes a stale veil off screen, not just out of the index', async () => {
    _cacheRenderedOverlayForTests(cacheKeyFor(OFF_BOARD_FRAMES), 'file:///stale-veil.png');
    const { result } = renderRow({ frames: OFF_BOARD_FRAMES });

    await waitFor(() => expect(result.current.overlayUri).toBeNull());
  });

  it('still short-circuits on a cache hit for a climb whose holds all exist', async () => {
    _cacheRenderedOverlayForTests(cacheKeyFor(FRAMES), 'file:///overlay-good.png');
    const { result } = renderRow();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(result.current.overlayUri).toBe('file:///overlay-good.png');
    expect(fakeNativeModule.renderHoldsOverlay).not.toHaveBeenCalled();
    expect(failureEvents()).toHaveLength(0);
  });

  it('leaves a climb whose holds all exist completely alone', async () => {
    renderRow();
    await waitFor(() => expect(fakeNativeModule.renderHoldsOverlay).toHaveBeenCalled());

    expect(failureEvents().filter((event) => event.stage === 'config')).toHaveLength(0);
  });
});

// The remaining iOS suspect: a correctly rendered file that expo-image never
// paints. The same climbs draw on Android and on the host, so silence — neither
// onLoad nor onError — is a third outcome nothing was watching for.
//
// The watchdog arms off the view layer's MOUNT signal, never off `overlayUri`.
// `LayeredClimbImage` renders a bare `<View>` and no image at all while the app
// is backgrounded or the tab's board art is released (opening `/play` does
// exactly that to every other surface), and nothing there can ever fire
// `onLoad` — so arming on the URI would have reported guaranteed-bogus silence.
describe('the overlay paint watchdog', () => {
  /** A cached overlay, so the hook has one to hand the view layer. */
  function renderPlayBoard(overrides: { playSurface?: boolean; filledStyle?: boolean } = {}) {
    _cacheRenderedOverlayForTests(cacheKeyFor(FRAMES), 'file:///overlay-cached.png');
    return renderRow({ playSurface: true, ...overrides });
  }

  function paintTimeouts() {
    return failureEvents().filter((event) => event.failure_kind === 'paint_timeout');
  }

  it('reports an overlay a mounted image never answered for', async () => {
    vi.useFakeTimers();
    const { result } = renderPlayBoard();
    act(() => result.current.onOverlayMounted(result.current.overlayLoadKey));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100);
    });

    expect(paintTimeouts()).toHaveLength(1);
    expect(paintTimeouts()[0]).toMatchObject({
      stage: 'image_load',
      failure_kind: 'paint_timeout',
      error_code: 'paint_timeout',
      surface: 'play',
    });
    // Observation only: the overlay is still on screen and nothing was retried.
    expect(result.current.overlayUri).toBe('file:///overlay-cached.png');
    expect(fakeNativeModule.renderHoldsOverlay).not.toHaveBeenCalled();
  });

  // The regression this shape exists to prevent. A surface with an overlay URI
  // but no `<Image>` mounted cannot answer, so it must never be asked.
  it('never reports a surface that is rendering no image at all', async () => {
    vi.useFakeTimers();
    const { result } = renderPlayBoard();
    expect(result.current.overlayUri).toBe('file:///overlay-cached.png');
    // The view layer never reports a mount: hidden by backgrounding, or by this
    // tab's board art being released.

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(paintTimeouts()).toHaveLength(0);
  });

  it('disarms the moment a mounted image goes away', async () => {
    vi.useFakeTimers();
    const { result } = renderPlayBoard();
    act(() => result.current.onOverlayMounted(result.current.overlayLoadKey));
    // The app backgrounds, or /play opens and this tab releases its board art.
    act(() => result.current.onOverlayMounted(null));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(paintTimeouts()).toHaveLength(0);
  });

  it('stays quiet when expo-image answers in time', async () => {
    vi.useFakeTimers();
    const { result } = renderPlayBoard();
    act(() => result.current.onOverlayMounted(result.current.overlayLoadKey));

    act(() => result.current.onOverlayLoad(result.current.overlayLoadKey));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(paintTimeouts()).toHaveLength(0);
  });

  it('stays quiet when expo-image answers with an error — that is the other path', async () => {
    vi.useFakeTimers();
    const { result } = renderPlayBoard();
    act(() => result.current.onOverlayMounted(result.current.overlayLoadKey));

    act(() => result.current.onOverlayError({ error: 'Failed to load' }, result.current.overlayLoadKey));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(paintTimeouts()).toHaveLength(0);
  });

  // The carousel's peek board, the preview cards and rails, the preview sheet,
  // the reaction menu and the wall kiosk hero all render a full-size board and
  // none of them opts in.
  it('never watches a surface that did not opt in', async () => {
    vi.useFakeTimers();
    const { result } = renderPlayBoard({ playSurface: false });
    act(() => result.current.onOverlayMounted(result.current.overlayLoadKey));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(paintTimeouts()).toHaveLength(0);
  });

  it('never watches a thumbnail', async () => {
    vi.useFakeTimers();
    _cacheRenderedOverlayForTests(
      buildCacheKey(BASE.boardName, BASE.layoutId, BASE.sizeId, BASE.setIds, FRAMES, true),
      'file:///overlay-thumb.png',
    );
    const { result } = renderRow({ filledStyle: true });
    act(() => result.current.onOverlayMounted(result.current.overlayLoadKey));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(paintTimeouts()).toHaveLength(0);
  });

  // A late `onError` from the PREVIOUS image lands after the next one is already
  // mounted and watched. Cancelling on it would silence exactly the case the
  // watchdog exists to catch.
  it('is not cancelled by a stale error from the image before it', async () => {
    vi.useFakeTimers();
    const { result } = renderPlayBoard();
    const staleLoadKey = result.current.overlayLoadKey;
    act(() => result.current.onOverlayMounted(staleLoadKey));

    // A new image mounts and takes over the watch.
    act(() => result.current.onOverlayMounted('99:0'));
    // …and only now does the previous image's error arrive.
    act(() => result.current.onOverlayError({ error: 'Failed to load' }, staleLoadKey));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100);
    });

    expect(paintTimeouts()).toHaveLength(1);
  });

  it('is still cancelled by the error for the image it is actually watching', async () => {
    vi.useFakeTimers();
    const { result } = renderPlayBoard();
    act(() => result.current.onOverlayMounted('99:0'));

    act(() => result.current.onOverlayError({ error: 'Failed to load' }, '99:0'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100);
    });

    expect(paintTimeouts()).toHaveLength(0);
  });

  it('does not stack timers across a rapid swipe', async () => {
    vi.useFakeTimers();
    _cacheRenderedOverlayForTests(cacheKeyFor(FRAMES), 'file:///overlay-a.png');
    const otherFrames = 'p1500r12p1600r13';
    _cacheRenderedOverlayForTests(cacheKeyFor(otherFrames), 'file:///overlay-b.png');
    const { result, rerender } = renderHook(
      ({ frames }) => useNativeClimbRender({ ...BASE, frames, playSurface: true }),
      { initialProps: { frames: FRAMES } },
    );
    act(() => result.current.onOverlayMounted(result.current.overlayLoadKey));

    rerender({ frames: otherFrames });
    act(() => result.current.onOverlayMounted(result.current.overlayLoadKey));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100);
    });

    // One timer per hook instance: the swipe replaced the first climb's watch.
    expect(paintTimeouts()).toHaveLength(1);
  });
});

describe('the per-lifetime event caps', () => {
  // A board whose sets do not cover a climb's holds produces a config mismatch
  // on EVERY row of a list. Sharing one budget would let a single scroll spend
  // the whole session on one answer and silence the native and image_load
  // signals — the ones that actually move.
  it('gives the config stage its own budget so a list scroll cannot silence the rest', async () => {
    vi.useFakeTimers();
    const configCap = _CONFIG_FAILURE_EVENT_CAP_FOR_TESTS;
    // Distinct off-board climbs, the way a FlashList recycles through a list.
    for (let index = 0; index < configCap + 10; index += 1) renderRow({ frames: `p${4000 + index}r12` });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(failureEvents().filter((event) => event.stage === 'config')).toHaveLength(configCap);

    // The native budget is untouched, so a real render failure is still heard.
    renderRow({ frames: 'p1100r12p1200r13' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(failureEvents().filter((event) => event.stage === 'native').length).toBeGreaterThan(0);
  });

  it('stops firing after the cap but keeps counting', async () => {
    vi.useFakeTimers();
    const cap = _RENDER_FAILURE_EVENT_CAP_FOR_TESTS;
    // One row per distinct climb, the way a FlashList recycles through a list.
    for (let index = 0; index < cap + 8; index += 1) renderRow({ frames: `p${2000 + index}r12` });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(failureEvents()).toHaveLength(cap);
    // The last event that got through still says how many failures there were,
    // so a stream that stops at the cap reads as truncated rather than as a
    // device that failed exactly `cap` times.
    expect(failureEvents().at(-1)?.failures_this_session).toBe(cap);
  });
});

// Issue #5187: the render that never comes back. Every board surface used to
// hand its render straight to Expo's shared serial queue, so a fast scroll
// queued one native render per row and the play board a climber then opened
// waited behind all of them — for minutes, on a Low Power Mode CPU. Nothing
// measured it: the only render telemetry starts once the overlay <Image>
// mounts, and an overlay that is never produced never mounts one.
//
// The watchdog answers the question that investigation could not: after a fixed
// wait, was the render sitting in OUR queue behind other surfaces, or inside
// native? The two call for opposite fixes.
describe('the render stall watchdog', () => {
  /** Resolvers for renders the native fake has been asked for, by cache key. */
  const stalledRenders = new Map<string, ((uri: string) => void)[]>();

  function resolveStalledRender(cacheKey: string, uri: string): void {
    const pending = stalledRenders.get(cacheKey)?.shift();
    if (!pending) throw new Error(`No pending render for ${cacheKey}`);
    pending(uri);
  }

  type StallProperties = FailureProperties & {
    stall_state?: string;
    queue_depth?: number;
    dispatched_count?: number;
    ms_waiting?: number;
  };

  function stallEvents(): StallProperties[] {
    return failureEvents().filter((event) => event.failure_kind === 'render_stalled');
  }

  const OTHER_FRAMES = 'p1500r12p1600r13';

  beforeEach(() => {
    vi.useFakeTimers();
    stalledRenders.clear();
    // A render that answers only when this test says so — the shape of the
    // field report, where the play board's overlay simply never arrived.
    fakeNativeModule.renderHoldsOverlay.mockImplementation(
      (_configJson: string, cacheKey: string) =>
        new Promise<string>((resolve) => {
          const pendingForKey = stalledRenders.get(cacheKey) ?? [];
          pendingForKey.push(resolve);
          stalledRenders.set(cacheKey, pendingForKey);
        }),
    );
  });

  afterEach(() => {
    // Hand the file's default rejecting renderer back to the suites after this
    // one; leaving a never-settling render installed would hang them.
    fakeNativeModule.renderHoldsOverlay.mockImplementation((_configJson: string, _cacheKey: string) =>
      Promise.reject(new Error(renderRejection.message)),
    );
  });

  it('reports a play board whose render is still inside native after six seconds', async () => {
    renderRow({ playSurface: true });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5999);
    });
    expect(stallEvents()).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(stallEvents()).toHaveLength(1);
    expect(stallEvents()[0]).toMatchObject({
      stage: 'native',
      failure_kind: 'render_stalled',
      error_code: 'render_stalled',
      surface: 'play',
      board_name: 'kilter',
      stall_state: 'dispatched',
    });
    expect(typeof stallEvents()[0].queue_depth).toBe('number');
    expect(typeof stallEvents()[0].dispatched_count).toBe('number');
    expect(typeof stallEvents()[0].ms_waiting).toBe('number');
  });

  // The distinction the event exists for: this render never reached native at
  // all, so a native profile would show nothing wrong.
  it('says a second board was waiting in our own queue, not inside native', async () => {
    renderRow({ playSurface: true });
    renderRow({ playSurface: true, frames: OTHER_FRAMES });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });

    expect(stallEvents().map((event) => event.stall_state)).toEqual(['dispatched', 'queued']);
    expect(stallEvents()[1].queue_depth).toBeGreaterThanOrEqual(1);
  });

  it('stays quiet when the render lands in time', async () => {
    renderRow({ playSurface: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      resolveStalledRender(cacheKeyFor(FRAMES), 'file:///overlay-in-time.png');
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(stallEvents()).toHaveLength(0);
  });

  // Twelve call sites render a board at full size and none of them opts in —
  // a stalled thumbnail is the queue working as designed, not a defect.
  it('never watches a surface that did not opt in', async () => {
    renderRow();
    renderRow({ filledStyle: true, frames: OTHER_FRAMES });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });

    expect(stallEvents()).toHaveLength(0);
  });

  it('drops the watch when the climber swipes to another climb', async () => {
    const { rerender } = renderHook(({ frames }) => useNativeClimbRender({ ...BASE, frames, playSurface: true }), {
      initialProps: { frames: FRAMES },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    rerender({ frames: OTHER_FRAMES });

    // The first climb's watchdog was due at t=6000 and the second's at t=9000.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5999);
    });
    expect(stallEvents()).toHaveLength(0);

    // Exactly one watch per mounted key — the new one, on its own schedule.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(stallEvents()).toHaveLength(1);
  });

  it('reports nothing at all once the surface unmounts', async () => {
    const { unmount } = renderRow({ playSurface: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(stallEvents()).toHaveLength(0);
    expect(addErrorBreadcrumbMock).not.toHaveBeenCalled();
  });

  // The whole point of queueing in JS rather than in native: a row the climber
  // scrolled past takes its render back with it.
  it('never asks native for a queued render whose surface went away first', async () => {
    renderRow({ playSurface: true });
    const scrolledAway = renderRow({ frames: OTHER_FRAMES, filledStyle: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fakeNativeModule.renderHoldsOverlay).toHaveBeenCalledTimes(1);

    scrolledAway.unmount();
    await act(async () => {
      resolveStalledRender(cacheKeyFor(FRAMES), 'file:///overlay-play.png');
      await vi.advanceTimersByTimeAsync(0);
    });

    // The freed slot found nothing to take: the withdrawn request was dropped
    // rather than run for a row nobody is looking at.
    expect(fakeNativeModule.renderHoldsOverlay).toHaveBeenCalledTimes(1);
    expect(failureEvents()).toHaveLength(0);
    expect(addErrorBreadcrumbMock).not.toHaveBeenCalled();
    expect(reportErrorMock).not.toHaveBeenCalled();
  });
});
