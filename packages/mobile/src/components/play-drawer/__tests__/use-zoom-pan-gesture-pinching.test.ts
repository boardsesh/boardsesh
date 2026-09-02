// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// What these tests are about: the JS-thread `isPinching` mirror of "2+
// fingers are down on this board". The create-climb board's host
// (CreateDrawer) reads this (OR'd with isZoomed) to disable its native bottom
// sheet's own pan gesture for the duration — see the doc comment on
// isPinching in use-zoom-pan-gesture.ts and onInteractionActiveChange in
// InteractiveCreateBoard.tsx.

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
let capturedOnFinalize: (() => void) | null = null;

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
            if (kind === 'Pinch' && method === 'onFinalize') {
              capturedOnFinalize = args[0] as () => void;
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
    capturedOnFinalize = null;
  });

  it('stays false and wires no touches handler when no pinchRef is passed (the play-drawer board)', () => {
    const { result } = renderHook(() => useZoomPanGesture({ containerWidth: 320, containerHeight: 480 }));

    expect(result.current.isPinching).toBe(false);
    expect(capturedOnTouchesDown).toBeNull();
    expect(capturedOnFinalize).toBeNull();
  });

  it('flips true on a 2nd finger and back to false on a subsequent single-finger touch-down (interactive boards)', () => {
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

  it('clears on onFinalize when both fingers lift together (no intervening single-finger touchesDown)', () => {
    // A lift fires no touchesDown event at all, so onTouchesDown's
    // numberOfTouches===1 branch never runs in this scenario — onFinalize is
    // the only thing that can clear the mirror. Without it, a host gating on
    // isPinching (CreateDrawer) would stay locked until the user happened to
    // touch the board again — including staying locked for a touch that
    // never reaches the board at all, e.g. dragging the sheet by its handle.
    const pinchRef = { current: undefined };
    const { result } = renderHook(() => useZoomPanGesture({ containerWidth: 320, containerHeight: 480, pinchRef }));

    act(() => {
      capturedOnTouchesDown?.({ numberOfTouches: 2 });
    });
    expect(result.current.isPinching).toBe(true);
    expect(capturedOnFinalize).not.toBeNull();

    act(() => {
      capturedOnFinalize?.();
    });
    expect(result.current.isPinching).toBe(false);
  });

  it('onFinalize is a no-op when nothing was pinching', () => {
    const pinchRef = { current: undefined };
    const { result } = renderHook(() => useZoomPanGesture({ containerWidth: 320, containerHeight: 480, pinchRef }));

    act(() => {
      capturedOnFinalize?.();
    });
    expect(result.current.isPinching).toBe(false);
  });
});
