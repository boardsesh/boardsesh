// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// What these tests are about: the JS-thread `isPinching` mirror of
// isPinchingSV. The create-climb board's host (CreateDrawer) reads this (OR'd
// with isZoomed) to disable its native bottom sheet's own pan gesture for the
// duration — see the doc comment on isPinching in use-zoom-pan-gesture.ts and
// onInteractionActiveChange in InteractiveCreateBoard.tsx.

vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  return {
    useSharedValue: (initial: unknown) => {
      const ref = useRef<{ value: unknown } | null>(null);
      if (ref.current === null) ref.current = { value: initial };
      return ref.current;
    },
    useAnimatedStyle: (factory: () => unknown) => factory(),
    withTiming: (toValue: unknown) => toValue,
    cancelAnimation: () => {},
    runOnJS:
      (fn: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) =>
        fn(...args),
  };
});

type TouchesEvent = { numberOfTouches: number };
type TouchesHandler = (event: TouchesEvent) => void;
let capturedOnTouchesDown: TouchesHandler | null = null;

vi.mock('react-native-gesture-handler', () => {
  const makeBuilder = (kind: string) => {
    const proxy: Record<string, (...args: unknown[]) => unknown> = new Proxy(
      {},
      {
        get: (_target, method: string) => {
          return (...args: unknown[]) => {
            if (kind === 'Pinch' && method === 'onTouchesDown') {
              capturedOnTouchesDown = args[0] as TouchesHandler;
            }
            return proxy;
          };
        },
      },
    );
    return proxy;
  };
  return {
    Gesture: { Pinch: () => makeBuilder('Pinch'), Pan: () => makeBuilder('Pan') },
  };
});

import { useZoomPanGesture } from '../use-zoom-pan-gesture';

describe('useZoomPanGesture isPinching', () => {
  beforeEach(() => {
    capturedOnTouchesDown = null;
  });

  it('stays false and wires no touches handler when no pinchRef is passed (the play-drawer board)', () => {
    const { result } = renderHook(() => useZoomPanGesture({ containerWidth: 320, containerHeight: 480 }));

    expect(result.current.isPinching).toBe(false);
    expect(capturedOnTouchesDown).toBeNull();
  });

  it('flips true on a 2nd finger and back to false on a fresh 1-finger touch (interactive boards)', () => {
    const pinchRef = { current: undefined };
    const { result } = renderHook(() => useZoomPanGesture({ containerWidth: 320, containerHeight: 480, pinchRef }));

    expect(result.current.isPinching).toBe(false);
    expect(capturedOnTouchesDown).not.toBeNull();

    act(() => {
      capturedOnTouchesDown?.({ numberOfTouches: 2 });
    });
    expect(result.current.isPinching).toBe(true);

    act(() => {
      capturedOnTouchesDown?.({ numberOfTouches: 1 });
    });
    expect(result.current.isPinching).toBe(false);
  });

  it('does not fire again for a 3rd finger already mid-pinch', () => {
    const pinchRef = { current: undefined };
    const { result } = renderHook(() => useZoomPanGesture({ containerWidth: 320, containerHeight: 480, pinchRef }));

    act(() => {
      capturedOnTouchesDown?.({ numberOfTouches: 2 });
    });
    expect(result.current.isPinching).toBe(true);

    // A 3rd finger re-fires the >=2 branch — isPinching should simply stay true.
    act(() => {
      capturedOnTouchesDown?.({ numberOfTouches: 3 });
    });
    expect(result.current.isPinching).toBe(true);
  });
});
