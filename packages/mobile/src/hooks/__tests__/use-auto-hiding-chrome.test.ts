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

  it('runs a control only while the controls were already up', () => {
    const action = vi.fn();
    const { result } = renderHook(() => useAutoHidingChrome({ visibleMs: 4000, pinned: false }));

    act(() => {
      result.current.guardPress(action)();
    });
    expect(action).toHaveBeenCalledOnce();

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    // Faded: an activation that reaches the control without a touch (Switch
    // Control, Voice Control) brings the controls back first.
    act(() => {
      result.current.guardPress(action)();
    });
    expect(action).toHaveBeenCalledOnce();
    expect(result.current.visible).toBe(true);
    act(() => {
      result.current.guardPress(action)();
    });
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('never lets the touch that revealed the controls press one of them', () => {
    const action = vi.fn();
    const { result } = renderHook(() => useAutoHidingChrome({ visibleMs: 4000, pinned: false }));
    act(() => {
      vi.advanceTimersByTime(4000);
    });

    // A tap lands on the invisible Exit: touch start reveals, the press that
    // ends the same touch must not exit.
    act(() => {
      result.current.handleTouchStart();
    });
    act(() => {
      result.current.guardPress(action)();
    });
    expect(action).not.toHaveBeenCalled();

    // The next tap, with the controls up, acts.
    act(() => {
      result.current.handleTouchStart();
    });
    act(() => {
      result.current.guardPress(action)();
    });
    expect(action).toHaveBeenCalledOnce();
  });

  it('clears its timer on unmount', () => {
    const { unmount } = renderHook(() => useAutoHidingChrome({ visibleMs: 4000, pinned: false }));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
