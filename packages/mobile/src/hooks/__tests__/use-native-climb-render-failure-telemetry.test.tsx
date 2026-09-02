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
  renderHoldsOverlay: vi.fn((_configJson: string, _cacheKey: string) =>
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

function renderRow(overrides: { frames?: string; filledStyle?: boolean; renderWidth?: number } = {}) {
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

  it('names the thumbnail surface separately from the play board', async () => {
    renderRow({ filledStyle: true, renderWidth: 400 });
    await waitFor(() => expect(failureEvents()).toHaveLength(1));

    expect(failureEvents()[0]).toMatchObject({ surface: 'thumbnail', render_width: 400 });
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

describe('the per-lifetime event cap', () => {
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
