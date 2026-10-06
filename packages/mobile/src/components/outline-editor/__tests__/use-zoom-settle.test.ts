// @vitest-environment jsdom
import { useEffect, useRef } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A small reactive stand-in for reanimated: shared values notify reactions on
// write, and a `withDelay(withTiming(...))` write runs its callback after the
// delay unless another write lands first (then with `finished` false), which is
// how reanimated treats an animation that is replaced.
type Animation = { animation: true; to: number; delay: number; callback?: (finished: boolean) => void };
const listeners = new Set<() => void>();

class MockSharedValue {
  private current: number;
  private pending: { timer: ReturnType<typeof setTimeout>; callback?: (finished: boolean) => void } | null = null;
  constructor(initial: number) {
    this.current = initial;
  }
  get value(): number {
    return this.current;
  }
  set value(next: number | Animation) {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      const cancelled = this.pending.callback;
      this.pending = null;
      cancelled?.(false);
    }
    if (typeof next === 'number') {
      this.current = next;
      for (const listener of listeners) listener();
      return;
    }
    const timer = setTimeout(() => {
      this.pending = null;
      this.current = next.to;
      next.callback?.(true);
    }, next.delay);
    this.pending = { timer, callback: next.callback };
  }
}

vi.mock('react-native-reanimated', () => ({
  runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
  useSharedValue: (initial: number) => {
    const ref = useRef<MockSharedValue | null>(null);
    if (!ref.current) ref.current = new MockSharedValue(initial);
    return ref.current;
  },
  useAnimatedReaction: (
    prepare: () => number,
    react: (next: number, previous: number | null) => void,
    deps: unknown[],
  ) => {
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- mirrors reanimated's own deps contract
    useEffect(() => {
      let previous = prepare();
      react(previous, null);
      const listener = () => {
        const next = prepare();
        if (next === previous) return;
        const before = previous;
        previous = next;
        react(next, before);
      };
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }, deps);
  },
  withTiming: (to: number, _config: unknown, callback?: (finished: boolean) => void) => ({
    animation: true,
    to,
    delay: 0,
    callback,
  }),
  withDelay: (delay: number, animation: Animation) => ({ ...animation, delay }),
}));

import { ZOOM_SETTLE_MS, useZoomSettle } from '../use-zoom-settle';

function mount(onSettle: ((zoom: number) => void) | undefined) {
  const zoomSV = new MockSharedValue(1);
  const hook = renderHook(() => useZoomSettle(zoomSV as never, onSettle));
  return { zoomSV, hook };
}

describe('useZoomSettle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    listeners.clear();
  });

  it('reports the zoom once after mount', () => {
    const onSettle = vi.fn();
    mount(onSettle);
    act(() => {
      vi.advanceTimersByTime(ZOOM_SETTLE_MS - 1);
    });
    expect(onSettle).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(onSettle).toHaveBeenLastCalledWith(1);
  });

  it('waits for the zoom to hold still, then reports it once', () => {
    const onSettle = vi.fn();
    const { zoomSV } = mount(onSettle);
    act(() => {
      vi.advanceTimersByTime(ZOOM_SETTLE_MS);
    });
    onSettle.mockClear();
    // A pinch: a new zoom every 16 ms for half a second.
    for (let frame = 1; frame <= 30; frame += 1) {
      act(() => {
        zoomSV.value = 1 + frame * 0.1;
        vi.advanceTimersByTime(16);
      });
    }
    expect(onSettle).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(ZOOM_SETTLE_MS);
    });
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(onSettle).toHaveBeenLastCalledWith(4);
  });

  it('schedules nothing while idle, and does not re-report the same zoom', () => {
    const onSettle = vi.fn();
    const { zoomSV } = mount(onSettle);
    act(() => {
      vi.advanceTimersByTime(ZOOM_SETTLE_MS);
    });
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      zoomSV.value = 2;
      zoomSV.value = 1;
      vi.advanceTimersByTime(ZOOM_SETTLE_MS);
    });
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never schedules without a listener', () => {
    const { zoomSV } = mount(undefined);
    act(() => {
      zoomSV.value = 3;
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
