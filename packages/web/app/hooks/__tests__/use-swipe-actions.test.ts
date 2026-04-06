import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Capture the config passed to useSwipeable
let capturedSwipeableConfig: Record<string, (...args: unknown[]) => unknown> = {};
vi.mock('react-swipeable', () => ({
  useSwipeable: (config: Record<string, (...args: unknown[]) => unknown>) => {
    capturedSwipeableConfig = config;
    return { ref: vi.fn() };
  },
}));

// Mock useSwipeDirection
const mockDetect = vi.fn();
const mockReset = vi.fn();
const mockIsHorizontalRef = { current: null as boolean | null };
vi.mock('../use-swipe-direction', () => ({
  useSwipeDirection: () => ({
    detect: mockDetect,
    reset: mockReset,
    isHorizontalRef: mockIsHorizontalRef,
  }),
}));

import { useSwipeActions, type UseSwipeActionsOptions } from '../use-swipe-actions';

function createDefaultOptions(): UseSwipeActionsOptions {
  return {
    onSwipeLeft: vi.fn(),
    onSwipeRight: vi.fn(),
  };
}

describe('useSwipeActions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    capturedSwipeableConfig = {};
    mockDetect.mockReset();
    mockReset.mockReset();
    mockIsHorizontalRef.current = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns swipeHandlers, swipeLeftConfirmed, contentRef, leftActionRef, rightActionRef', () => {
    const { result } = renderHook(() => useSwipeActions(createDefaultOptions()));

    expect(result.current.swipeHandlers).toBeDefined();
    expect(result.current.swipeLeftConfirmed).toBe(false);
    expect(typeof result.current.contentRef).toBe('function');
    expect(typeof result.current.leftActionRef).toBe('function');
    expect(typeof result.current.rightActionRef).toBe('function');
  });

  it('does nothing when disabled', () => {
    const options = { ...createDefaultOptions(), disabled: true };
    renderHook(() => useSwipeActions(options));

    act(() => {
      capturedSwipeableConfig.onSwiping({
        deltaX: -150,
        deltaY: 0,
        event: { preventDefault: vi.fn(), nativeEvent: { preventDefault: vi.fn() } },
      });
    });

    expect(mockDetect).not.toHaveBeenCalled();
  });

  it('calls onSwipeLeft immediately when swiped left past threshold', () => {
    const options = createDefaultOptions();
    renderHook(() => useSwipeActions(options));

    mockIsHorizontalRef.current = true;
    mockDetect.mockReturnValue(true);

    act(() => {
      capturedSwipeableConfig.onSwiping({
        deltaX: -110,
        deltaY: 0,
        event: { nativeEvent: { preventDefault: vi.fn() } },
      });
    });

    act(() => {
      capturedSwipeableConfig.onSwipedLeft({ deltaX: -110 });
    });

    // Action fires immediately — no timer advance needed
    expect(options.onSwipeLeft).toHaveBeenCalledTimes(1);
  });

  it('calls onSwipeRight when swiped right past threshold and detected horizontal', () => {
    const options = createDefaultOptions();
    renderHook(() => useSwipeActions(options));

    mockIsHorizontalRef.current = true;
    mockDetect.mockReturnValue(true);

    act(() => {
      capturedSwipeableConfig.onSwiping({
        deltaX: 110,
        deltaY: 0,
        event: { nativeEvent: { preventDefault: vi.fn() } },
      });
    });

    act(() => {
      capturedSwipeableConfig.onSwipedRight({ deltaX: 110 });
    });

    expect(options.onSwipeRight).toHaveBeenCalledTimes(1);
  });

  it('snaps back when swipe below threshold', () => {
    const options = createDefaultOptions();
    renderHook(() => useSwipeActions(options));

    mockIsHorizontalRef.current = true;
    mockDetect.mockReturnValue(true);

    act(() => {
      capturedSwipeableConfig.onSwiping({
        deltaX: -40,
        deltaY: 0,
        event: { nativeEvent: { preventDefault: vi.fn() } },
      });
    });

    act(() => {
      capturedSwipeableConfig.onSwipedLeft({ deltaX: -40 });
    });

    // onSwipeLeft should not be called since delta < threshold
    expect(options.onSwipeLeft).not.toHaveBeenCalled();
    // resetDirection should be called
    expect(mockReset).toHaveBeenCalled();
  });

  it('swipeLeftConfirmed becomes true immediately and resets after 600ms', () => {
    const options = createDefaultOptions();
    const { result } = renderHook(() => useSwipeActions(options));

    mockIsHorizontalRef.current = true;
    mockDetect.mockReturnValue(true);

    expect(result.current.swipeLeftConfirmed).toBe(false);

    act(() => {
      capturedSwipeableConfig.onSwiping({
        deltaX: -110,
        deltaY: 0,
        event: { nativeEvent: { preventDefault: vi.fn() } },
      });
    });

    act(() => {
      capturedSwipeableConfig.onSwipedLeft({ deltaX: -110 });
    });

    // Action fires immediately and confirmation is active
    expect(options.onSwipeLeft).toHaveBeenCalledTimes(1);
    expect(result.current.swipeLeftConfirmed).toBe(true);

    // Still active before 600ms
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.swipeLeftConfirmed).toBe(true);

    // Resets after 600ms
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current.swipeLeftConfirmed).toBe(false);
  });

  it('does not trigger action for vertical swipes (isHorizontalRef.current = false)', () => {
    const options = createDefaultOptions();
    renderHook(() => useSwipeActions(options));

    mockIsHorizontalRef.current = false;
    mockDetect.mockReturnValue(false);

    act(() => {
      capturedSwipeableConfig.onSwiping({
        deltaX: -110,
        deltaY: 0,
        event: { nativeEvent: { preventDefault: vi.fn() } },
      });
    });

    act(() => {
      capturedSwipeableConfig.onSwipedLeft({ deltaX: -110 });
    });

    // Should snap back, not trigger action
    expect(options.onSwipeLeft).not.toHaveBeenCalled();
  });

  it('onTouchEndOrOnMouseUp resets if below threshold', () => {
    const options = createDefaultOptions();
    renderHook(() => useSwipeActions(options));

    mockIsHorizontalRef.current = true;
    mockDetect.mockReturnValue(true);

    // Swipe a small amount
    act(() => {
      capturedSwipeableConfig.onSwiping({
        deltaX: 30,
        deltaY: 0,
        event: { nativeEvent: { preventDefault: vi.fn() } },
      });
    });

    // Touch end
    act(() => {
      capturedSwipeableConfig.onTouchEndOrOnMouseUp();
    });

    expect(mockReset).toHaveBeenCalled();
  });

  it('DOM refs apply transform via contentRef callback', () => {
    const { result } = renderHook(() => useSwipeActions(createDefaultOptions()));

    const mockElement = {
      style: { transform: '', transition: '', opacity: '', visibility: '' },
    } as unknown as HTMLElement;

    // Set the content ref
    act(() => {
      result.current.contentRef(mockElement);
    });

    mockDetect.mockReturnValue(true);
    mockIsHorizontalRef.current = true;

    // Simulate swiping to trigger applyOffset
    act(() => {
      capturedSwipeableConfig.onSwiping({
        deltaX: 50,
        deltaY: 0,
        event: { nativeEvent: { preventDefault: vi.fn() } },
      });
    });

    expect(mockElement.style.transform).toBe('translateX(50px)');
  });

  it('respects custom swipeThreshold', () => {
    const options = { ...createDefaultOptions(), swipeThreshold: 50 };
    renderHook(() => useSwipeActions(options));

    mockIsHorizontalRef.current = true;
    mockDetect.mockReturnValue(true);

    // Swipe just past the custom threshold
    act(() => {
      capturedSwipeableConfig.onSwiping({
        deltaX: -60,
        deltaY: 0,
        event: { nativeEvent: { preventDefault: vi.fn() } },
      });
    });

    act(() => {
      capturedSwipeableConfig.onSwipedLeft({ deltaX: -60 });
    });

    // Action fires immediately
    expect(options.onSwipeLeft).toHaveBeenCalledTimes(1);
  });

  it('respects custom maxSwipe (clamps offset)', () => {
    const options = { ...createDefaultOptions(), maxSwipe: 80 };
    const { result } = renderHook(() => useSwipeActions(options));

    const mockElement = {
      style: { transform: '', transition: '', opacity: '', visibility: '' },
    } as unknown as HTMLElement;

    act(() => {
      result.current.contentRef(mockElement);
    });

    mockDetect.mockReturnValue(true);
    mockIsHorizontalRef.current = true;

    // Swipe beyond maxSwipe
    act(() => {
      capturedSwipeableConfig.onSwiping({
        deltaX: 200,
        deltaY: 0,
        event: { nativeEvent: { preventDefault: vi.fn() } },
      });
    });

    // Should be clamped to maxSwipe
    expect(mockElement.style.transform).toBe('translateX(80px)');
  });

  it('resets direction on swipe completion', () => {
    const options = createDefaultOptions();
    renderHook(() => useSwipeActions(options));

    mockIsHorizontalRef.current = true;
    mockDetect.mockReturnValue(true);

    act(() => {
      capturedSwipeableConfig.onSwiping({
        deltaX: 110,
        deltaY: 0,
        event: { nativeEvent: { preventDefault: vi.fn() } },
      });
    });

    act(() => {
      capturedSwipeableConfig.onSwipedRight({ deltaX: 110 });
    });

    expect(mockReset).toHaveBeenCalled();
  });

  it('calls onSwipeLeftLong when swiped past long left threshold', () => {
    const options = {
      ...createDefaultOptions(),
      onSwipeLeftLong: vi.fn(),
      swipeThreshold: 90,
      longSwipeLeftThreshold: 120,
    };
    renderHook(() => useSwipeActions(options));

    mockIsHorizontalRef.current = true;
    mockDetect.mockReturnValue(true);

    act(() => {
      capturedSwipeableConfig.onSwiping({
        deltaX: -130,
        deltaY: 0,
        event: { nativeEvent: { preventDefault: vi.fn() } },
      });
    });

    act(() => {
      capturedSwipeableConfig.onSwipedLeft({ deltaX: -130 });
    });

    expect(options.onSwipeLeftLong).toHaveBeenCalledTimes(1);
    expect(options.onSwipeLeft).not.toHaveBeenCalled();
  });

  it('uses short swipe callback when left swipe is below long threshold', () => {
    const options = {
      ...createDefaultOptions(),
      onSwipeLeftLong: vi.fn(),
      swipeThreshold: 90,
      longSwipeLeftThreshold: 120,
    };
    renderHook(() => useSwipeActions(options));

    mockIsHorizontalRef.current = true;
    mockDetect.mockReturnValue(true);

    act(() => {
      capturedSwipeableConfig.onSwiping({
        deltaX: -100,
        deltaY: 0,
        event: { nativeEvent: { preventDefault: vi.fn() } },
      });
    });

    act(() => {
      capturedSwipeableConfig.onSwipedLeft({ deltaX: -100 });
    });

    // Action fires immediately
    expect(options.onSwipeLeft).toHaveBeenCalledTimes(1);
    expect(options.onSwipeLeftLong).not.toHaveBeenCalled();
  });

  it('emits swipe zone changes when crossing long-right threshold', () => {
    const onSwipeZoneChange = vi.fn();
    const options = {
      ...createDefaultOptions(),
      onSwipeRightLong: vi.fn(),
      longSwipeRightThreshold: 150,
      maxSwipe: 180,
      onSwipeZoneChange,
    };
    renderHook(() => useSwipeActions(options));

    mockIsHorizontalRef.current = true;
    mockDetect.mockReturnValue(true);

    act(() => {
      capturedSwipeableConfig.onSwiping({
        deltaX: 110,
        deltaY: 0,
        event: { nativeEvent: { preventDefault: vi.fn() } },
      });
    });

    act(() => {
      capturedSwipeableConfig.onSwiping({
        deltaX: 160,
        deltaY: 0,
        event: { nativeEvent: { preventDefault: vi.fn() } },
      });
    });

    act(() => {
      capturedSwipeableConfig.onSwipedRight({ deltaX: 160 });
    });

    expect(onSwipeZoneChange).toHaveBeenCalledWith('right-short');
    expect(onSwipeZoneChange).toHaveBeenCalledWith('right-long');
    expect(onSwipeZoneChange).toHaveBeenCalledWith('none');
    expect(options.onSwipeRightLong).toHaveBeenCalledTimes(1);
  });

  it('peeks content and keeps action layer visible during left swipe confirmation', () => {
    const options = createDefaultOptions();
    const { result } = renderHook(() => useSwipeActions(options));

    const mockContent = {
      style: { transform: '', transition: '', opacity: '', visibility: '' },
    } as unknown as HTMLElement;
    const mockRightAction = {
      style: { transform: '', transition: '', opacity: '', visibility: '' },
    } as unknown as HTMLElement;

    act(() => {
      result.current.contentRef(mockContent);
      result.current.rightActionRef(mockRightAction);
    });

    mockIsHorizontalRef.current = true;
    mockDetect.mockReturnValue(true);

    act(() => {
      capturedSwipeableConfig.onSwiping({
        deltaX: -110,
        deltaY: 0,
        event: { nativeEvent: { preventDefault: vi.fn() } },
      });
    });

    act(() => {
      capturedSwipeableConfig.onSwipedLeft({ deltaX: -110 });
    });

    // Content should be at peek offset with fast peek-in animation
    expect(mockContent.style.transform).toBe('translateX(-76px)');
    expect(mockContent.style.transition).toBe('transform 120ms ease-out');
    // Right action layer should be fully visible
    expect(mockRightAction.style.opacity).toBe('1');
    expect(mockRightAction.style.visibility).toBe('visible');

    // After confirmation timer (600ms), content snaps back with gentler animation
    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(mockContent.style.transform).toBe('translateX(0px)');
    expect(mockContent.style.transition).toBe('transform 200ms ease-out');
  });

  it('handles rapid double-swipe without duplicate actions', () => {
    const options = createDefaultOptions();
    renderHook(() => useSwipeActions(options));

    mockIsHorizontalRef.current = true;
    mockDetect.mockReturnValue(true);

    // First swipe
    act(() => {
      capturedSwipeableConfig.onSwiping({
        deltaX: -110,
        deltaY: 0,
        event: { nativeEvent: { preventDefault: vi.fn() } },
      });
    });
    act(() => {
      capturedSwipeableConfig.onSwipedLeft({ deltaX: -110 });
    });

    // Second swipe immediately after (before timer fires)
    act(() => {
      capturedSwipeableConfig.onSwiping({
        deltaX: -110,
        deltaY: 0,
        event: { nativeEvent: { preventDefault: vi.fn() } },
      });
    });
    act(() => {
      capturedSwipeableConfig.onSwipedLeft({ deltaX: -110 });
    });

    // Action fires twice (once per swipe) — that's correct
    expect(options.onSwipeLeft).toHaveBeenCalledTimes(2);

    // But only one timer should be pending — advance and confirm single reset
    act(() => {
      vi.advanceTimersByTime(600);
    });

    // No additional calls after timer
    expect(options.onSwipeLeft).toHaveBeenCalledTimes(2);
  });

  it('cleans up confirmation timer on unmount', () => {
    const options = createDefaultOptions();
    const { result, unmount } = renderHook(() => useSwipeActions(options));

    mockIsHorizontalRef.current = true;
    mockDetect.mockReturnValue(true);

    act(() => {
      capturedSwipeableConfig.onSwiping({
        deltaX: -110,
        deltaY: 0,
        event: { nativeEvent: { preventDefault: vi.fn() } },
      });
    });

    act(() => {
      capturedSwipeableConfig.onSwipedLeft({ deltaX: -110 });
    });

    expect(result.current.swipeLeftConfirmed).toBe(true);

    // Unmount before timer fires — should not throw
    unmount();

    // Advancing timers should not cause errors
    act(() => {
      vi.advanceTimersByTime(600);
    });
  });
});
