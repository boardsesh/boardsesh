// @vitest-environment jsdom
//
// The full-disk render storm (issue #3647).
//
// Field shape being fixed: one iPhone with no free space produced ~50
// `UnexpectedException: You can't save the file "v5_….png" because the volume
// "User" is out of space` events in 50 minutes, spread across THREE Sentry issue
// groups (BOARDSESH-C6/C7/C8) plus a fourth from a second device. Two separate
// causes, so two separate fixes asserted here:
//
//  1. No once-guard on the reporter, and `getOrStartInflightRender` clears the
//     settled promise — so every recycled FlashList row re-rendered and
//     re-reported.
//  2. Sentry groups on the message, and the raw message interpolates the
//     FILENAME. So even one event per row would still have minted a new issue
//     group per cache key. A guard alone was never enough.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

vi.mock('../../providers/theme-provider', () => ({ useAppColorScheme: () => 'light' }));

class MockFile {
  constructor(private readonly uri: string) {}
  get exists(): boolean {
    return false;
  }
  get name(): string {
    return this.uri;
  }
}

/** Free space on the cache volume, as the platform reports it. */
const diskState = vi.hoisted(() => ({ freeBytes: null as number | null }));

vi.mock('expo-file-system', () => ({
  Directory: vi.fn(() => ({ exists: false, list: () => [] })),
  File: MockFile,
  Paths: {
    cache: { uri: 'file:///cache/' },
    get availableDiskSpace(): number | null {
      return diskState.freeBytes;
    },
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
    holdsData: mockHolds(Array.from({ length: 40 }, (_, index) => 1000 + index)),
  })),
}));

vi.mock('../../lib/background-image-cache', () => ({
  tryGetBackgroundPathsSync: vi.fn(() => ({ paths: ['file:///bg.png'], missingCount: 0 })),
  ensureBackgroundsCached: vi.fn(async () => ({ paths: ['file:///bg.png'], missingCount: 0 })),
}));

const reportErrorMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/error-reporting', () => ({ reportError: reportErrorMock, addErrorBreadcrumb: vi.fn() }));

const sweepBoardArtCache = vi.hoisted(() =>
  vi.fn(() => Promise.resolve({ beforeBytes: 0, freedBytes: 0, filesDeleted: 0 })),
);
vi.mock('../../lib/sweep-caches', () => ({ sweepBoardArtCache }));

vi.mock('../../lib/hold-color-overrides', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/hold-color-overrides')>();
  const stableOverrides = {
    overrides: {},
    shapes: {},
    brushThickness: original.DEFAULT_HOLD_BRUSH_THICKNESS,
    shapeSize: original.DEFAULT_HOLD_SHAPE_SIZE,
    renderSignature: original.DEFAULT_HOLD_COLOR_SIGNATURE,
  };
  return { ...original, useHoldColorOverrides: () => stableOverrides };
});

// Every render rejects the way a full volume does, with the FILENAME in the
// message — which is what fragmented the Sentry groups.
const renderOutcome = vi.hoisted(() => ({ mode: 'disk-full' as 'disk-full' | 'localized-disk-full' | 'other' }));

/** What Foundation hands back for the same failure, by device language. */
function failureMessage(mode: (typeof renderOutcome)['mode'], cacheKey: string): string {
  if (mode === 'disk-full') {
    return `The operation couldn’t be completed. You can’t save the file “${cacheKey}.png” because the volume “User” is out of space.`;
  }
  if (mode === 'localized-disk-full') {
    // Same NSCocoaErrorDomain 640, on a phone set to Spanish.
    return `No se puede guardar el archivo “${cacheKey}.png” porque el volumen “User” no tiene suficiente espacio.`;
  }
  return `render failed for ${cacheKey}: unknown native error`;
}

const fakeNativeModule = {
  boardRendererNative: {},
  renderHoldsOverlay: vi.fn((_configJson: string, cacheKey: string) =>
    Promise.reject(new Error(failureMessage(renderOutcome.mode, cacheKey))),
  ),
};

const {
  useNativeClimbRender,
  classifyRenderFailure,
  _inflightRendersForTests,
  _resetWarmupForTests,
  _setNativeModuleForTests,
} = await import('../use-native-climb-render');

const BASE = { boardName: 'kilter' as const, layoutId: 1, sizeId: 10, setIds: '26,27', filledStyle: false };

/** One recycled FlashList row: a distinct climb, hence a distinct cache key. */
function renderRow(index: number) {
  return renderHook(() => useNativeClimbRender({ ...BASE, frames: `p${1000 + index}r12` }));
}

/** The same row, warmed speculatively for a climb nobody has swiped to yet. */
function renderPrefetchRow(index: number) {
  return renderHook(() => useNativeClimbRender({ ...BASE, frames: `p${1000 + index}r12`, prefetch: true }));
}

beforeEach(() => {
  renderOutcome.mode = 'disk-full';
  // Default: a platform that won't say, so the message match stands alone.
  diskState.freeBytes = null;
  _resetWarmupForTests();
  _inflightRendersForTests.clear();
  fakeNativeModule.renderHoldsOverlay.mockClear();
  sweepBoardArtCache.mockClear();
  reportErrorMock.mockClear();
  _setNativeModuleForTests(fakeNativeModule as unknown as Parameters<typeof _setNativeModuleForTests>[0]);
});

describe('classifyRenderFailure', () => {
  it('recognises the out-of-space wording each platform uses', () => {
    expect(classifyRenderFailure('the volume “User” is out of space')).toBe('disk_full');
    expect(classifyRenderFailure('write failed: ENOSPC (No space left on device)')).toBe('disk_full');
    expect(classifyRenderFailure('java.io.IOException: No space left on device')).toBe('disk_full');
    expect(classifyRenderFailure('unknown native error')).toBe('render_failed');
  });

  // `NSError.localizedDescription` is translated, so the wording above only
  // exists on an English phone. Free space answers the same question in a way no
  // locale can change.
  it('recognises a full disk the OS described in another language', () => {
    const spanish = 'No se puede guardar el archivo porque el volumen no tiene suficiente espacio.';
    expect(classifyRenderFailure(spanish)).toBe('render_failed');
    expect(classifyRenderFailure(spanish, 4 * 1024 * 1024)).toBe('disk_full');
  });

  it('does not blame the disk for a genuine render bug on a phone with room to spare', () => {
    expect(classifyRenderFailure('unknown native error', 8 * 1024 * 1024 * 1024)).toBe('render_failed');
  });
});

describe('out-of-space render storm', () => {
  it('reports once across many failing rows, not once per row', async () => {
    for (let index = 0; index < 20; index += 1) renderRow(index);
    await waitFor(() => expect(reportErrorMock).toHaveBeenCalled());
    // Give every rejection a chance to land before asserting the count.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
  });

  it('carries a stable message so the per-filename Sentry groups collapse into one', async () => {
    renderRow(0);
    await waitFor(() => expect(reportErrorMock).toHaveBeenCalled());
    const [reported, options] = reportErrorMock.mock.calls[0] as [Error, Record<string, unknown>];
    expect(reported.message).toBe('Board overlay render failed: disk_full');
    // The filename is still readable — just not part of the fingerprint.
    expect(reported.message).not.toContain('.png');
    const extra = options.extra as Record<string, unknown>;
    expect(String(extra.renderErrorMessage)).toContain('out of space');
    expect(reported.cause).toBeInstanceOf(Error);
  });

  it('downgrades a full device from an error to a warning', async () => {
    renderRow(0);
    await waitFor(() => expect(reportErrorMock).toHaveBeenCalled());
    const [, options] = reportErrorMock.mock.calls[0] as [Error, Record<string, unknown>];
    expect(options.level).toBe('warning');
    expect(options.tags).toMatchObject({ renderFailure: 'disk_full', expected_disk_full: 'true' });
  });

  it('still pages at error level for a failure that is not the disk', async () => {
    renderOutcome.mode = 'other';
    renderRow(0);
    await waitFor(() => expect(reportErrorMock).toHaveBeenCalled());
    const [reported, options] = reportErrorMock.mock.calls[0] as [Error, Record<string, unknown>];
    expect(reported.message).toBe('Board overlay render failed: render_failed');
    expect(options.level).toBe('error');
  });

  it('stops calling the native renderer once it has latched, and kicks one sweep', async () => {
    renderRow(0);
    await waitFor(() => expect(sweepBoardArtCache).toHaveBeenCalledWith({ trigger: 'disk-pressure' }));
    const callsBeforeBackoff = fakeNativeModule.renderHoldsOverlay.mock.calls.length;

    for (let index = 1; index < 20; index += 1) renderRow(index);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Every row after the latch skipped the bridge entirely.
    expect(fakeNativeModule.renderHoldsOverlay.mock.calls.length).toBe(callsBeforeBackoff);
    expect(sweepBoardArtCache).toHaveBeenCalledTimes(1);
  });

  it('leaves the wall photo on screen while backed off', async () => {
    const { result } = renderRow(0);
    await waitFor(() => expect(sweepBoardArtCache).toHaveBeenCalled());
    const backedOff = renderRow(1);
    // Overlay is null, backgrounds still resolve — the existing missing-layer
    // contract, not a blank screen.
    expect(backedOff.result.current.overlayUri).toBeNull();
    expect(backedOff.result.current.backgroundPaths).toEqual(['file:///bg.png']);
    expect(result.current.backgroundPaths).toEqual(['file:///bg.png']);
  });

  // The same storm, on a phone that isn't set to English: without the free-space
  // check nothing backs off and nothing sweeps, because the OS phrased "out of
  // space" in Spanish.
  it('backs off and sweeps when the OS reports the full disk in another language', async () => {
    renderOutcome.mode = 'localized-disk-full';
    diskState.freeBytes = 3 * 1024 * 1024;
    renderRow(0);
    await waitFor(() => expect(sweepBoardArtCache).toHaveBeenCalledWith({ trigger: 'disk-pressure' }));
    const [reported, options] = reportErrorMock.mock.calls[0] as [Error, Record<string, unknown>];
    expect(reported.message).toBe('Board overlay render failed: disk_full');
    expect(options.level).toBe('warning');
  });

  // A play view the user is looking at never re-runs the render effect on its
  // own, so without a re-trigger it stays without art for the life of the mount
  // even after the sweep freed the space.
  it('comes back once the back-off lifts instead of staying blank for the whole mount', async () => {
    vi.useFakeTimers();
    try {
      renderRow(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(sweepBoardArtCache).toHaveBeenCalledWith({ trigger: 'disk-pressure' });

      const stationary = renderRow(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const callsWhileLatched = fakeNativeModule.renderHoldsOverlay.mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_001);
      });
      expect(fakeNativeModule.renderHoldsOverlay.mock.calls.length).toBeGreaterThan(callsWhileLatched);
      // Still the missing-layer contract while it retries, never a blank screen.
      expect(stationary.result.current.backgroundPaths).toEqual(['file:///bg.png']);
    } finally {
      vi.useRealTimers();
    }
  });

  // The play drawer warms three climbs ahead. Each one resuming its PNG write
  // the moment the back-off lifts is the storm the latch exists to stop — and
  // nobody is waiting on any of them, so the climb that IS swiped to makes its
  // own attempt anyway (the visible-surface recovery is asserted above).
  it('never schedules a recovery for a prefetch, unlike a surface on screen', async () => {
    vi.useFakeTimers();
    try {
      renderRow(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(sweepBoardArtCache).toHaveBeenCalledWith({ trigger: 'disk-pressure' });

      renderPrefetchRow(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const callsWhileLatched = fakeNativeModule.renderHoldsOverlay.mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_001);
      });
      expect(fakeNativeModule.renderHoldsOverlay.mock.calls.length).toBe(callsWhileLatched);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after a bounded number of retries rather than retrying forever', async () => {
    vi.useFakeTimers();
    try {
      renderRow(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      renderRow(1);

      const attempts: number[] = [];
      for (let round = 0; round < 6; round += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(60_001);
        });
        attempts.push(fakeNativeModule.renderHoldsOverlay.mock.calls.length);
      }
      // Every retry fails and re-latches, so the count stops moving once the
      // per-mount budget is spent.
      expect(attempts.at(-1)).toBe(attempts.at(-2));
    } finally {
      vi.useRealTimers();
    }
  });
});
