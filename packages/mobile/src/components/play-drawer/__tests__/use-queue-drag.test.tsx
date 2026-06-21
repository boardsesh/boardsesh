// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

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
vi.mock('react-native-gesture-handler', () => {
  const makeBuilder = () => {
    const builder: Record<string, (...args: unknown[]) => unknown> = {};
    const proxy: typeof builder = new Proxy(builder, { get: () => () => proxy });
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
