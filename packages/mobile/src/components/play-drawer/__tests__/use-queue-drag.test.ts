// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// queue-drag-math.test.ts covers the pure index/offset math. This file covers
// the hook's own JS-thread wiring that the math tests can't reach: the
// gesture-lifecycle → `commit` → `reorderQueue` path, the `isDragging` toggle,
// and that `onRowHeight` actually changes the drop step. Reanimated and
// gesture-handler are mocked so the worklets run inline on the JS thread.

type GestureHandler = (event?: unknown) => void;

// Records the handlers attached by `Gesture.Pan().…onStart().onUpdate()…` so the
// test can drive them. Each builder method returns `this` to mirror the real
// chainable API.
class PanRecorder {
  handlers: Record<string, GestureHandler> = {};
  longPressMs = 0;
  activateAfterLongPress(ms: number) {
    this.longPressMs = ms;
    return this;
  }
  onStart(cb: GestureHandler) {
    this.handlers.onStart = cb;
    return this;
  }
  onUpdate(cb: GestureHandler) {
    this.handlers.onUpdate = cb;
    return this;
  }
  onEnd(cb: GestureHandler) {
    this.handlers.onEnd = cb;
    return this;
  }
  onFinalize(cb: GestureHandler) {
    this.handlers.onFinalize = cb;
    return this;
  }
}

vi.mock('react-native-gesture-handler', () => ({
  Gesture: { Pan: () => new PanRecorder() },
}));

vi.mock('react-native-reanimated', async () => {
  const React = await import('react');
  return {
    // Stable per hook-instance object, like the real shared value, so the
    // gesture closure and `onRowHeight` mutate the same reference across the
    // re-renders that `setIsDragging` triggers.
    useSharedValue: <T,>(initial: T) => {
      const ref = React.useRef<{ value: T } | null>(null);
      if (ref.current === null) ref.current = { value: initial };
      return ref.current;
    },
    // Run synchronously on the JS thread so state updates and `commit` happen
    // inline under `act`.
    runOnJS:
      <Args extends unknown[]>(fn: (...args: Args) => void) =>
      (...args: Args) =>
        fn(...args),
  };
});

// vi.hoisted so the mock factory (hoisted above imports) can reference it.
const { hapticSelection } = vi.hoisted(() => ({ hapticSelection: vi.fn() }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection }));

import { useQueueDrag } from '../use-queue-drag';

// Future window: flat rows 3..6 map 1:1 onto queue indices 3..6 (offset 0).
const WINDOW = { firstFutureRowIndex: 3, lastFutureRowIndex: 6, firstFutureQueueIndex: 3 };

function setup() {
  const reorderQueue = vi.fn();
  const { result } = renderHook(() => useQueueDrag({ reorderQueue, ...WINDOW }));
  return { reorderQueue, result };
}

// Grab the PanRecorder behind the GestureType the hook returns.
function gestureFor(handle: ReturnType<typeof useQueueDrag>['makeHandleGesture'], rowIndex: number, uuid: string) {
  return handle(rowIndex, uuid, rowIndex) as unknown as PanRecorder;
}

describe('useQueueDrag', () => {
  beforeEach(() => {
    hapticSelection.mockClear();
  });

  it('commits a downward reorder via reorderQueue when the row moves', () => {
    const { reorderQueue, result } = setup();
    const gesture = gestureFor(result.current.makeHandleGesture, 3, 'climb-a');

    act(() => gesture.handlers.onStart());
    act(() => gesture.handlers.onUpdate({ translationY: 120 })); // +1 row (default height 120)
    act(() => gesture.handlers.onEnd());
    act(() => gesture.handlers.onFinalize());

    expect(reorderQueue).toHaveBeenCalledTimes(1);
    expect(reorderQueue).toHaveBeenCalledWith('climb-a', 3, 4);
  });

  it('does not call reorderQueue when the row lands back on its start index', () => {
    const { reorderQueue, result } = setup();
    const gesture = gestureFor(result.current.makeHandleGesture, 3, 'climb-a');

    act(() => gesture.handlers.onStart());
    act(() => gesture.handlers.onUpdate({ translationY: 10 })); // < half a row → no move
    act(() => gesture.handlers.onEnd());
    act(() => gesture.handlers.onFinalize());

    expect(reorderQueue).not.toHaveBeenCalled();
  });

  it('clamps an upward drag to the first future row (cannot enter history/current)', () => {
    const { reorderQueue, result } = setup();
    const gesture = gestureFor(result.current.makeHandleGesture, 5, 'climb-c');

    act(() => gesture.handlers.onStart());
    act(() => gesture.handlers.onUpdate({ translationY: -1000 }));
    act(() => gesture.handlers.onEnd());
    act(() => gesture.handlers.onFinalize());

    // Drop row clamps to 3 → queue index 3.
    expect(reorderQueue).toHaveBeenCalledWith('climb-c', 5, 3);
  });

  it('toggles isDragging across the gesture lifecycle', () => {
    const { result } = setup();
    const gesture = gestureFor(result.current.makeHandleGesture, 3, 'climb-a');

    expect(result.current.isDragging).toBe(false);
    act(() => gesture.handlers.onStart());
    expect(result.current.isDragging).toBe(true);
    act(() => gesture.handlers.onFinalize());
    expect(result.current.isDragging).toBe(false);
  });

  it('honours a measured row height for the drop step', () => {
    const { reorderQueue, result } = setup();
    // With the default 120px height, a 90px drag rounds to +1 row (3 → 4). After
    // reporting a 60px row height it rounds to +1.5 → +2 rows (3 → 5), proving
    // onRowHeight feeds the live step distance.
    act(() => result.current.onRowHeight(60));
    const gesture = gestureFor(result.current.makeHandleGesture, 3, 'climb-a');

    act(() => gesture.handlers.onStart());
    act(() => gesture.handlers.onUpdate({ translationY: 90 }));
    act(() => gesture.handlers.onEnd());
    act(() => gesture.handlers.onFinalize());

    expect(reorderQueue).toHaveBeenCalledWith('climb-a', 3, 5);
  });

  it('fires selection haptics on grab and on each row the drop target crosses', () => {
    const { result } = setup();
    const gesture = gestureFor(result.current.makeHandleGesture, 3, 'climb-a');

    act(() => gesture.handlers.onStart()); // grab → 1 haptic
    act(() => gesture.handlers.onUpdate({ translationY: 120 })); // target 3 → 4 → 1 haptic
    act(() => gesture.handlers.onUpdate({ translationY: 130 })); // still 4 → no haptic
    act(() => gesture.handlers.onUpdate({ translationY: 240 })); // target 4 → 5 → 1 haptic

    expect(hapticSelection).toHaveBeenCalledTimes(3);
  });
});
