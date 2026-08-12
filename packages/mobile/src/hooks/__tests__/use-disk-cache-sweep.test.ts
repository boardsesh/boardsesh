// @vitest-environment jsdom
//
// When the disk sweep fires. The regression this file exists for is the
// foreground leg: a launch + background pair reproduces the very blind spot the
// issue names, because a session kept open for days never does either.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const sweepBoardArtCache = vi.hoisted(() =>
  vi.fn(() => Promise.resolve({ beforeBytes: 0, freedBytes: 0, filesDeleted: 0 })),
);
const sweepSnapshotLeftovers = vi.hoisted(() => vi.fn(() => Promise.resolve(0)));
vi.mock('../../lib/sweep-caches', () => ({ sweepBoardArtCache, sweepSnapshotLeftovers }));

// Capture the interaction callback so a test can decide whether the queue ever
// drains — a starved queue is the case the fallback timer exists for.
const interactions = vi.hoisted(() => {
  const pending: (() => void)[] = [];
  return {
    pending,
    runAfterInteractions: vi.fn((callback: () => void) => {
      pending.push(callback);
      return { cancel: vi.fn() };
    }),
    drain: () => {
      for (const callback of pending.splice(0)) callback();
    },
  };
});
vi.mock('react-native', () => ({ InteractionManager: interactions }));

const isBackgrounded = vi.hoisted(() => ({ value: false }));
vi.mock('../../lib/app-visibility', () => ({ useIsAppBackgrounded: () => isBackgrounded.value }));

const writeThresholdListener = vi.hoisted(() => ({ current: null as null | (() => void) }));
vi.mock('../../lib/overlay-index', () => ({
  onOverlayWriteThreshold: (_threshold: number, listener: () => void) => {
    writeThresholdListener.current = listener;
    return () => {
      writeThresholdListener.current = null;
    };
  },
}));

import { useDiskCacheSweep } from '../use-disk-cache-sweep';

beforeEach(() => {
  vi.useFakeTimers();
  sweepBoardArtCache.mockClear();
  sweepSnapshotLeftovers.mockClear();
  interactions.pending.length = 0;
  interactions.runAfterInteractions.mockClear();
  isBackgrounded.value = false;
  writeThresholdListener.current = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useDiskCacheSweep', () => {
  it('defers the launch sweep past the opening animation rather than blocking it', () => {
    renderHook(() => useDiskCacheSweep());
    expect(sweepBoardArtCache).not.toHaveBeenCalled();

    act(() => interactions.drain());
    expect(sweepBoardArtCache).toHaveBeenCalledWith({ trigger: 'launch' });
    expect(sweepSnapshotLeftovers).toHaveBeenCalledTimes(1);
  });

  // `runAfterInteractions` can be starved indefinitely by a leaked handle, which
  // would otherwise mean the sweep simply never runs on a busy launch.
  it('still sweeps via the fallback timer when the interaction queue never drains', () => {
    renderHook(() => useDiskCacheSweep());
    act(() => {
      vi.advanceTimersByTime(2_500);
    });
    expect(sweepBoardArtCache).toHaveBeenCalledWith({ trigger: 'launch' });
  });

  it('sweeps only once when both the queue and the fallback fire', () => {
    renderHook(() => useDiskCacheSweep());
    act(() => interactions.drain());
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(sweepBoardArtCache).toHaveBeenCalledTimes(1);
  });

  it('sweeps on the transition to background, and not on the way back', () => {
    const { rerender } = renderHook(() => useDiskCacheSweep());
    act(() => interactions.drain());
    sweepBoardArtCache.mockClear();

    isBackgrounded.value = true;
    rerender();
    expect(sweepBoardArtCache).toHaveBeenCalledWith({ trigger: 'background' });

    sweepBoardArtCache.mockClear();
    isBackgrounded.value = false;
    rerender();
    expect(sweepBoardArtCache).not.toHaveBeenCalled();
  });

  // The leg that covers the actual failure mode: growth in a session that never
  // backgrounds and never relaunches.
  it('sweeps when the overlay write odometer crosses its threshold', () => {
    renderHook(() => useDiskCacheSweep());
    act(() => interactions.drain());
    sweepBoardArtCache.mockClear();

    act(() => writeThresholdListener.current?.());
    expect(sweepBoardArtCache).toHaveBeenCalledWith({ trigger: 'write-threshold' });
  });

  it('unsubscribes the odometer on unmount', () => {
    const { unmount } = renderHook(() => useDiskCacheSweep());
    expect(writeThresholdListener.current).not.toBeNull();
    unmount();
    expect(writeThresholdListener.current).toBeNull();
  });
});
