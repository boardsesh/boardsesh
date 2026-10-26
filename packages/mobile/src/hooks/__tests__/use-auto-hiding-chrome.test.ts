// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAutoHidingChrome } from '../use-auto-hiding-chrome';

describe('useAutoHidingChrome', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts visible so the way out is on screen, then hides after the delay', () => {
    const { result } = renderHook(() => useAutoHidingChrome({ visibleMs: 4000, pinned: false }));
    expect(result.current.visible).toBe(true);

    act(() => {
      vi.advanceTimersByTime(3999);
    });
    expect(result.current.visible).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.visible).toBe(false);
  });

  it('comes back on a touch and restarts the countdown from it', () => {
    const { result } = renderHook(() => useAutoHidingChrome({ visibleMs: 4000, pinned: false }));
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(result.current.visible).toBe(false);

    act(() => {
      result.current.reveal();
    });
    expect(result.current.visible).toBe(true);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    // A second touch before it fades pushes the fade back again.
    act(() => {
      result.current.reveal();
    });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current.visible).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.visible).toBe(false);
  });

  it('never hides while pinned, and hides again once unpinned and idle', () => {
    const { result, rerender } = renderHook(({ pinned }) => useAutoHidingChrome({ visibleMs: 4000, pinned }), {
      initialProps: { pinned: true },
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.visible).toBe(true);

    rerender({ pinned: false });
    expect(result.current.visible).toBe(false);
  });

  it('clears its timer on unmount', () => {
    const { unmount } = renderHook(() => useAutoHidingChrome({ visibleMs: 4000, pinned: false }));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
