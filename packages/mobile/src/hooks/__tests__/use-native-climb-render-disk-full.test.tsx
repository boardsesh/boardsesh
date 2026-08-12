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
import { renderHook, waitFor } from '@testing-library/react';

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

vi.mock('expo-file-system', () => ({
  Directory: vi.fn(() => ({ exists: false, list: () => [] })),
  File: MockFile,
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

const reportErrorMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/error-reporting', () => ({ reportError: reportErrorMock }));

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
const renderOutcome = vi.hoisted(() => ({ mode: 'disk-full' as 'disk-full' | 'other' }));
const fakeNativeModule = {
  boardRendererNative: {},
  renderHoldsOverlay: vi.fn((_configJson: string, cacheKey: string) =>
    Promise.reject(
      new Error(
        renderOutcome.mode === 'disk-full'
          ? `The operation couldn’t be completed. You can’t save the file “${cacheKey}.png” because the volume “User” is out of space.`
          : `render failed for ${cacheKey}: unknown native error`,
      ),
    ),
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

beforeEach(() => {
  renderOutcome.mode = 'disk-full';
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
});
