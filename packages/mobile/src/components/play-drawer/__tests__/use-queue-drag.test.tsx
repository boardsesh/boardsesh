// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

// `useQueueDrag` reaches for reanimated shared values, gesture-handler gestures,
// and haptics — all UI-thread / native concerns. Stub them so the hook runs in
// node and we can assert what this perf fix is really about: the returned
// controls keep a stable identity across re-renders, and `isDragging` is the
// only thing that flips when a drag starts/ends.

// Mirror reanimated's real contract: useSharedValue returns the SAME mutable
// ref across re-renders (backed by useRef here). That stable identity is exactly
// what lets the memoized `shared` bag and `controls` keep a stable identity —
// the behaviour this perf fix relies on.
vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  return {
    useSharedValue: (initial: unknown) => {
      const ref = useRef<{ value: unknown } | null>(null);
      if (ref.current === null) ref.current = { value: initial };
      return ref.current;
    },
    runOnJS:
      (fn: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) =>
        fn(...args),
  };
});

// A chainable Gesture.Pan() builder: every method returns the same builder so
// `.activateAfterLongPress(...).onStart(...).onUpdate(...)` resolves.
// Each callback handed to the builder (`onStart`, `onUpdate`, ...) is kept, so a
// test can play a drag through the handlers the hook registered.
const pan = vi.hoisted(() => ({ handlers: {} as Record<string, (event?: { translationY: number }) => void> }));

vi.mock('react-native-gesture-handler', () => {
  const makeBuilder = () => {
    const builder: Record<string, (...args: unknown[]) => unknown> = {};
    const proxy: typeof builder = new Proxy(builder, {
      get: (_target, method) => (argument: unknown) => {
        if (typeof method === 'string' && typeof argument === 'function') {
          pan.handlers[method] = argument as (event?: { translationY: number }) => void;
        }
        return proxy;
      },
    });
    return proxy;
  };
  return {
    Gesture: { Pan: () => makeBuilder() },
  };
});

vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));

import { useQueueDrag } from '../use-queue-drag';

type Options = Parameters<typeof useQueueDrag>[0];

// A single stable reorderQueue ref across re-renders — mirrors the real
// QueueContext callback, which is referentially stable. (A fresh function each
// render would churn the internal `commit`/`makeHandleGesture` callbacks, which
// is a test artifact, not a regression in the hook.)
const reorderQueue = vi.fn();

function makeOptions(overrides: Partial<Options> = {}): Options {
  return {
    reorderQueue,
    firstFutureRowIndex: 3,
    lastFutureRowIndex: 6,
    firstFutureQueueIndex: 3,
    ...overrides,
  };
}

describe('useQueueDrag identity stability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the result and controls identity stable across unrelated re-renders', () => {
    const { result, rerender } = renderHook((props: Options) => useQueueDrag(props), {
      initialProps: makeOptions(),
    });

    const firstResult = result.current;
    const firstControls = result.current.controls;
    const firstShared = result.current.controls.shared;
    const firstMakeHandle = result.current.controls.makeHandleGesture;
    const firstOnRowHeight = result.current.controls.onRowHeight;

    // Re-render with identical options (an unrelated parent update).
    rerender(makeOptions());

    expect(result.current).toBe(firstResult);
    expect(result.current.controls).toBe(firstControls);
    expect(result.current.controls.shared).toBe(firstShared);
    expect(result.current.controls.makeHandleGesture).toBe(firstMakeHandle);
    expect(result.current.controls.onRowHeight).toBe(firstOnRowHeight);
  });

  it('keeps the row-facing controls stable when the future window shifts', () => {
    const { result, rerender } = renderHook((props: Options) => useQueueDrag(props), {
      initialProps: makeOptions({ firstFutureRowIndex: 3, lastFutureRowIndex: 6, firstFutureQueueIndex: 3 }),
    });

    const firstControls = result.current.controls;

    // A queue change that moves the future window must not churn the controls
    // identity (rows would needlessly re-render otherwise).
    rerender(makeOptions({ firstFutureRowIndex: 4, lastFutureRowIndex: 8, firstFutureQueueIndex: 4 }));

    expect(result.current.controls).toBe(firstControls);
  });

  it('starts not-dragging and builds a handle gesture without flipping isDragging', () => {
    const { result } = renderHook((props: Options) => useQueueDrag(props), { initialProps: makeOptions() });

    expect(result.current.isDragging).toBe(false);
    const controlsBeforeDrag = result.current.controls;

    // Building the gesture for a row must not start a drag or change the
    // controls identity (the rows hold this object).
    const gesture = result.current.controls.makeHandleGesture(3, 'climb-a', 3);
    expect(gesture).toBeDefined();
    expect(result.current.isDragging).toBe(false);
    expect(result.current.controls).toBe(controlsBeforeDrag);
  });

  it('exposes a shared bag with the five drag coordinate values', () => {
    const { result } = renderHook((props: Options) => useQueueDrag(props), { initialProps: makeOptions() });
    const { shared } = result.current.controls;

    expect(shared.activeUuid.value).toBeNull();
    expect(shared.dragTranslateY.value).toBe(0);
    expect(shared.activeRowIndex.value).toBe(-1);
    expect(shared.targetRowIndex.value).toBe(-1);
    expect(typeof shared.rowHeight.value).toBe('number');
  });
});

// The drag works in whole rows: how far the finger has to travel to move one
// slot is the row's height. Rows are not one fixed height any more. A climber
// who switches the thumbnail off takes a queue row from about 112pt to as little
// as 44pt, under a sheet that stays mounted, so the hook has to follow what the
// rows measure rather than keep the first figure it was given.
describe('useQueueDrag row height', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pan.handlers = {};
  });

  /** Lifts row 3 and drags it down by `translationY`. */
  function dragRowThree(translationY: number) {
    act(() => {
      pan.handlers.onStart();
      pan.handlers.onUpdate({ translationY });
    });
  }

  it('steps by a fallback height until a row has been measured', () => {
    const { result } = renderHook((props: Options) => useQueueDrag(props), { initialProps: makeOptions() });

    expect(result.current.controls.shared.rowHeight.value).toBe(120);
  });

  it('takes every new measurement, not only the first', () => {
    const { result } = renderHook((props: Options) => useQueueDrag(props), { initialProps: makeOptions() });
    const { shared, onRowHeight } = result.current.controls;

    // With a thumbnail, then with the thumbnail switched off, then back on.
    onRowHeight(112.5);
    expect(shared.rowHeight.value).toBe(112.5);
    onRowHeight(58.5);
    expect(shared.rowHeight.value).toBe(58.5);
    onRowHeight(112.5);
    expect(shared.rowHeight.value).toBe(112.5);
  });

  it('ignores the same height reported again by the row’s neighbours, and a row that has not laid out', () => {
    const { result } = renderHook((props: Options) => useQueueDrag(props), { initialProps: makeOptions() });
    const { shared, onRowHeight } = result.current.controls;
    onRowHeight(58.5);

    onRowHeight(58.9);
    onRowHeight(0);

    expect(shared.rowHeight.value).toBe(58.5);
  });

  it('moves a row one slot per row height as measured now, so a shorter row needs a shorter drag', () => {
    const { result } = renderHook((props: Options) => useQueueDrag(props), { initialProps: makeOptions() });
    const { shared, onRowHeight, makeHandleGesture } = result.current.controls;
    makeHandleGesture(3, 'climb-a', 3);

    // 50pt is under half of a 112.5pt row: it has not reached the next slot.
    onRowHeight(112.5);
    dragRowThree(50);
    expect(shared.targetRowIndex.value).toBe(3);
    act(() => pan.handlers.onFinalize());

    // The same 50pt is most of a 58.5pt row: one slot down.
    onRowHeight(58.5);
    dragRowThree(50);
    expect(shared.targetRowIndex.value).toBe(4);

    act(() => {
      pan.handlers.onEnd();
      pan.handlers.onFinalize();
    });
    expect(reorderQueue).toHaveBeenCalledTimes(1);
    expect(reorderQueue).toHaveBeenCalledWith('climb-a', 3, 4);
  });

  it('keeps a long drag inside the future window whatever the row height', () => {
    const { result } = renderHook((props: Options) => useQueueDrag(props), { initialProps: makeOptions() });
    const { shared, onRowHeight, makeHandleGesture } = result.current.controls;
    makeHandleGesture(3, 'climb-a', 3);
    onRowHeight(44.5);

    // Twenty rows' worth of travel; the window ends at row 6.
    dragRowThree(900);

    expect(shared.targetRowIndex.value).toBe(6);
  });
});
