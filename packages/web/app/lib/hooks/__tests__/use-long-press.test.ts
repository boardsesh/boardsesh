import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { renderHook, act } from '@testing-library/react';
import { useLongPress } from '../use-long-press';

/**
 * jsdom doesn't implement the PointerEvent constructor, so synthesize a
 * plain Event and tack on the pointer-specific properties the hook reads.
 */
function createPointerEvent(
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel' | 'pointerleave',
  { clientX = 0, clientY = 0, button = 0 }: { clientX?: number; clientY?: number; button?: number } = {},
): Event {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, 'clientX', { value: clientX });
  Object.defineProperty(event, 'clientY', { value: clientY });
  Object.defineProperty(event, 'button', { value: button });
  return event;
}

describe('useLongPress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires the callback after the press threshold elapses', () => {
    const callback = vi.fn();
    const { result } = renderHook(() => useLongPress(callback, { thresholdMs: 500 }));

    const element = document.createElement('button');
    act(() => {
      result.current.ref(element);
    });

    act(() => {
      element.dispatchEvent(createPointerEvent('pointerdown'));
    });

    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(callback).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('cancels the timer when the pointer is released before the threshold', () => {
    const callback = vi.fn();
    const { result } = renderHook(() => useLongPress(callback, { thresholdMs: 500 }));

    const element = document.createElement('button');
    act(() => {
      result.current.ref(element);
    });

    act(() => {
      element.dispatchEvent(createPointerEvent('pointerdown'));
    });
    act(() => {
      vi.advanceTimersByTime(200);
      element.dispatchEvent(createPointerEvent('pointerup'));
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(callback).not.toHaveBeenCalled();
  });

  it('cancels on pointercancel', () => {
    const callback = vi.fn();
    const { result } = renderHook(() => useLongPress(callback, { thresholdMs: 500 }));

    const element = document.createElement('button');
    act(() => {
      result.current.ref(element);
    });

    act(() => {
      element.dispatchEvent(createPointerEvent('pointerdown'));
    });
    act(() => {
      element.dispatchEvent(createPointerEvent('pointercancel'));
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(callback).not.toHaveBeenCalled();
  });

  it('cancels on pointerleave', () => {
    const callback = vi.fn();
    const { result } = renderHook(() => useLongPress(callback, { thresholdMs: 500 }));

    const element = document.createElement('button');
    act(() => {
      result.current.ref(element);
    });

    act(() => {
      element.dispatchEvent(createPointerEvent('pointerdown'));
    });
    act(() => {
      element.dispatchEvent(createPointerEvent('pointerleave'));
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(callback).not.toHaveBeenCalled();
  });

  it('cancels when the pointer drags past the movement threshold', () => {
    const callback = vi.fn();
    const { result } = renderHook(() => useLongPress(callback, { thresholdMs: 500, moveThresholdPx: 10 }));

    const element = document.createElement('button');
    act(() => {
      result.current.ref(element);
    });

    act(() => {
      element.dispatchEvent(createPointerEvent('pointerdown', { clientX: 100, clientY: 100 }));
    });
    act(() => {
      // hypot(8, 6) === 10 — at the threshold but not past it
      element.dispatchEvent(createPointerEvent('pointermove', { clientX: 108, clientY: 106 }));
      vi.advanceTimersByTime(500);
    });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('cancels when the pointer drags past the movement threshold (jitter past 10px)', () => {
    const callback = vi.fn();
    const { result } = renderHook(() => useLongPress(callback, { thresholdMs: 500, moveThresholdPx: 10 }));

    const element = document.createElement('button');
    act(() => {
      result.current.ref(element);
    });

    act(() => {
      element.dispatchEvent(createPointerEvent('pointerdown', { clientX: 100, clientY: 100 }));
    });
    act(() => {
      element.dispatchEvent(createPointerEvent('pointermove', { clientX: 120, clientY: 100 }));
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(callback).not.toHaveBeenCalled();
  });

  it('ignores non-primary mouse buttons', () => {
    const callback = vi.fn();
    const { result } = renderHook(() => useLongPress(callback, { thresholdMs: 500 }));

    const element = document.createElement('button');
    act(() => {
      result.current.ref(element);
    });

    act(() => {
      element.dispatchEvent(createPointerEvent('pointerdown', { button: 2 }));
      vi.advanceTimersByTime(500);
    });

    expect(callback).not.toHaveBeenCalled();
  });

  it('consumeLongPress returns true exactly once after a long-press fires', () => {
    const callback = vi.fn();
    const { result } = renderHook(() => useLongPress(callback, { thresholdMs: 500 }));

    const element = document.createElement('button');
    act(() => {
      result.current.ref(element);
    });

    act(() => {
      element.dispatchEvent(createPointerEvent('pointerdown'));
      vi.advanceTimersByTime(500);
    });

    expect(result.current.consumeLongPress()).toBe(true);
    expect(result.current.consumeLongPress()).toBe(false);
  });

  it('consumeLongPress returns false when no long-press has fired', () => {
    const { result } = renderHook(() => useLongPress(vi.fn(), { thresholdMs: 500 }));

    expect(result.current.consumeLongPress()).toBe(false);
  });

  it('preventDefault is called on contextmenu to suppress the iOS callout', () => {
    const { result } = renderHook(() => useLongPress(vi.fn(), { thresholdMs: 500 }));

    const element = document.createElement('button');
    act(() => {
      result.current.ref(element);
    });

    const contextMenuEvent = new Event('contextmenu', { bubbles: true, cancelable: true });
    element.dispatchEvent(contextMenuEvent);
    expect(contextMenuEvent.defaultPrevented).toBe(true);
  });

  it('detaches listeners from the previous element when the ref node changes', () => {
    const callback = vi.fn();
    const { result } = renderHook(() => useLongPress(callback, { thresholdMs: 500 }));

    const first = document.createElement('button');
    const second = document.createElement('button');

    act(() => {
      result.current.ref(first);
    });
    act(() => {
      result.current.ref(second);
    });

    // The old element no longer fires the callback.
    act(() => {
      first.dispatchEvent(createPointerEvent('pointerdown'));
      vi.advanceTimersByTime(500);
    });
    expect(callback).not.toHaveBeenCalled();

    // The new element does.
    act(() => {
      second.dispatchEvent(createPointerEvent('pointerdown'));
      vi.advanceTimersByTime(500);
    });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('clears any pending timer when the hook unmounts mid-press', () => {
    const callback = vi.fn();
    const { result, unmount } = renderHook(() => useLongPress(callback, { thresholdMs: 500 }));

    const element = document.createElement('button');
    act(() => {
      result.current.ref(element);
    });

    act(() => {
      element.dispatchEvent(createPointerEvent('pointerdown'));
    });

    unmount();

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(callback).not.toHaveBeenCalled();
  });

  it('handles undefined callback without throwing when the timer fires', () => {
    const { result } = renderHook(() => useLongPress(undefined, { thresholdMs: 500 }));

    const element = document.createElement('button');
    act(() => {
      result.current.ref(element);
    });

    expect(() => {
      act(() => {
        element.dispatchEvent(createPointerEvent('pointerdown'));
        vi.advanceTimersByTime(500);
      });
    }).not.toThrow();
  });
});
