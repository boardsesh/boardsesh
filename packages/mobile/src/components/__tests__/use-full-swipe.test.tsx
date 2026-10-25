// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({
  trackers: [] as { start?: () => void; end?: (event: { translationX: number }, success?: boolean) => void }[],
}));
vi.mock('react-native-gesture-handler', async () => {
  const { useRef } = await import('react');
  return {
    usePanGesture: (config: {
      onActivate: () => void;
      onDeactivate: (event: { translationX: number; canceled?: boolean }) => void;
    }) => {
      const latestConfig = useRef(config);
      latestConfig.current = config;
      const tracker = useRef<(typeof native.trackers)[number] | null>(null);
      if (!tracker.current) {
        tracker.current = {
          start: () => latestConfig.current.onActivate(),
          end: (event, success) => latestConfig.current.onDeactivate({ ...event, canceled: success === false }),
        };
        native.trackers.push(tracker.current);
      }
      return tracker.current;
    },
  };
});
vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  return {
    runOnJS: (callback: (...args: unknown[]) => unknown) => callback,
    useSharedValue: (value: string) => useRef({ value }).current,
  };
});
import { useFullSwipe } from '../use-full-swipe';
beforeEach(() => {
  native.trackers = [];
});
describe('full swipe release contract', () => {
  it('leaves partial reveal open and commits each full release once', () => {
    const onCommit = vi.fn();
    const close = vi.fn();
    const { result } = renderHook(() => useFullSwipe({ scope: 'climb', enabled: true, onCommit, close }));
    act(() => {
      native.trackers[0].start?.();
      native.trackers[0].end?.({ translationX: -210 }, false);
      native.trackers[0].end?.({ translationX: 90 });
      result.current.onOpened();
    });
    expect(onCommit).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    act(() => {
      native.trackers[0].start?.();
      native.trackers[0].end?.({ translationX: -210 });
      native.trackers[0].end?.({ translationX: -210 });
      result.current.onOpened();
    });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('left');
    expect(close).toHaveBeenCalledOnce();
  });
  it('closes a full swipe when Reduce Motion settles open before the release callback', () => {
    const onCommit = vi.fn();
    const close = vi.fn();
    const { result } = renderHook(() => useFullSwipe({ scope: 'climb', enabled: true, onCommit, close }));
    act(() => {
      native.trackers[0].start?.();
      result.current.onOpened();
      native.trackers[0].end?.({ translationX: 210 });
    });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('right');
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects a late event from a recycled row', () => {
    const onCommit = vi.fn();
    const { rerender } = renderHook(({ scope }) => useFullSwipe({ scope, enabled: true, onCommit, close: vi.fn() }), {
      initialProps: { scope: 'old' },
    });
    const old = native.trackers[0];
    act(() => old.start?.());
    rerender({ scope: 'new' });
    act(() => old.end?.({ translationX: 210 }));
    expect(onCommit).not.toHaveBeenCalled();
    act(() => {
      native.trackers[0].start?.();
      native.trackers[0].end?.({ translationX: 210 });
    });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('right');
  });
});
