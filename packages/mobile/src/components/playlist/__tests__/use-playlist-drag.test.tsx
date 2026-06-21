// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// `usePlaylistDrag` reaches for reanimated shared values, gesture-handler
// gestures, and haptics — all UI-thread / native concerns. Stub them so the hook
// runs in node and we can assert what matters: the returned controls keep a
// stable identity across re-renders (so memoized rows don't churn), and
// `isDragging` starts false.

// Mirror reanimated's real contract: useSharedValue returns the SAME mutable ref
// across re-renders (backed by useRef). That stable identity is what lets the
// memoized `shared` bag and `controls` keep a stable identity.
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

import { usePlaylistDrag } from '../use-playlist-drag';

type Options = Parameters<typeof usePlaylistDrag>[0];

// A single stable reorder ref across re-renders — mirrors the screen's
// `useCallback`'d handler.
const reorder = vi.fn();

function makeOptions(overrides: Partial<Options> = {}): Options {
  return { reorder, itemCount: 5, ...overrides };
}

describe('usePlaylistDrag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the result and controls identity stable across unrelated re-renders', () => {
    const { result, rerender } = renderHook((props: Options) => usePlaylistDrag(props), {
      initialProps: makeOptions(),
    });

    const firstResult = result.current;
    const firstControls = result.current.controls;
    const firstShared = result.current.controls.shared;
    const firstMakeHandle = result.current.controls.makeHandleGesture;
    const firstOnRowHeight = result.current.controls.onRowHeight;

    rerender(makeOptions());

    expect(result.current).toBe(firstResult);
    expect(result.current.controls).toBe(firstControls);
    expect(result.current.controls.shared).toBe(firstShared);
    expect(result.current.controls.makeHandleGesture).toBe(firstMakeHandle);
    expect(result.current.controls.onRowHeight).toBe(firstOnRowHeight);
  });

  it('keeps the row-facing controls stable when the item count changes', () => {
    const { result, rerender } = renderHook((props: Options) => usePlaylistDrag(props), {
      initialProps: makeOptions({ itemCount: 5 }),
    });

    const firstControls = result.current.controls;

    // A remove (which changes itemCount) must not churn the controls identity —
    // rows would needlessly re-render otherwise.
    rerender(makeOptions({ itemCount: 4 }));

    expect(result.current.controls).toBe(firstControls);
  });

  it('starts not-dragging and builds a handle gesture without flipping isDragging', () => {
    const { result } = renderHook((props: Options) => usePlaylistDrag(props), { initialProps: makeOptions() });

    expect(result.current.isDragging).toBe(false);
    const controlsBeforeDrag = result.current.controls;

    const gesture = result.current.controls.makeHandleGesture(2, 'climb-c');
    expect(gesture).toBeDefined();
    expect(result.current.isDragging).toBe(false);
    expect(result.current.controls).toBe(controlsBeforeDrag);
  });

  it('exposes a shared bag with the five drag coordinate values at rest', () => {
    const { result } = renderHook((props: Options) => usePlaylistDrag(props), { initialProps: makeOptions() });
    const { shared } = result.current.controls;

    expect(shared.activeUuid.value).toBeNull();
    expect(shared.dragTranslateY.value).toBe(0);
    expect(shared.activeRowIndex.value).toBe(-1);
    expect(shared.targetRowIndex.value).toBe(-1);
    expect(typeof shared.rowHeight.value).toBe('number');
  });
});
