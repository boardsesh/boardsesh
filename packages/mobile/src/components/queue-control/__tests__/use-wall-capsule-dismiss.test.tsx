// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayoutChangeEvent } from 'react-native';

type PanEvent = { translationX: number; velocityX: number; canceled?: boolean };
type PanConfig = {
  enabled: boolean;
  onBegin: () => void;
  onActivate: () => void;
  onUpdate: (event: PanEvent) => void;
  onDeactivate: (event: PanEvent & { canceled: boolean }) => void;
  onFinalize: () => void;
};
const native = vi.hoisted(() => ({
  config: null as PanConfig | null,
  animationEnds: [] as ((finished: boolean) => void)[],
  animatedStyle: null as (() => { transform: { translateX: number }[] }) | null,
  queueJs: false,
  jsCallbacks: [] as (() => void)[],
}));
vi.mock('react-native-gesture-handler', () => ({
  usePanGesture: (config: PanConfig) => {
    native.config = config;
    return { config };
  },
}));
vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  return {
    useSharedValue: <T,>(value: T) => useRef({ value }).current,
    useAnimatedStyle: (read: () => { transform: { translateX: number }[] }) => {
      native.animatedStyle = read;
      return {};
    },
    cancelAnimation: vi.fn(),
    runOnJS:
      (callback: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) => {
        if (native.queueJs) native.jsCallbacks.push(() => callback(...args));
        else callback(...args);
      },
    withSpring: (to: number) => to,
    withTiming: (to: number, _config: unknown, done: (finished: boolean) => void) => {
      native.animationEnds.push(done);
      return to;
    },
  };
});

import { useWallCapsuleDismiss, type WallCapsuleDismissOptions } from '../use-wall-capsule-dismiss';

const WIDTH = 200;
function setup(overrides: Partial<WallCapsuleDismissOptions> = {}) {
  const onDismiss = vi.fn();
  const initial = { occurrenceKey: 'board:1:climb', onDismiss, reduceMotion: false, ...overrides };
  const hook = renderHook((options: WallCapsuleDismissOptions) => useWallCapsuleDismiss(options), {
    initialProps: initial,
  });
  act(() => hook.result.current.onLayout({ nativeEvent: { layout: { width: WIDTH } } } as LayoutChangeEvent));
  return { hook, initial, onDismiss };
}
function pan() {
  if (!native.config) throw new Error('No capsule pan');
  return native.config;
}
function drag(translationX: number, velocityX = 0, canceled = false) {
  const gesture = pan();
  act(() => {
    gesture.onBegin();
    gesture.onActivate();
    gesture.onUpdate({ translationX, velocityX });
    gesture.onDeactivate({ translationX, velocityX, canceled });
    gesture.onFinalize();
  });
}
function finishAnimation(index = 0, finished = true) {
  act(() => native.animationEnds[index]?.(finished));
}
function translation() {
  return native.animatedStyle?.().transform[0].translateX;
}
function flushJs() {
  act(() => {
    while (native.jsCallbacks.length > 0) native.jsCallbacks.shift()?.();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  native.config = null;
  native.animatedStyle = null;
  native.animationEnds = [];
  native.queueJs = false;
  native.jsCallbacks = [];
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

describe('useWallCapsuleDismiss', () => {
  it('claims only deliberate leftward intent and yields to vertical scrolling', () => {
    setup();
    expect(native.config).toMatchObject({ enabled: true, activeOffsetX: -10, failOffsetY: [-14, 14], maxPointers: 1 });
  });

  it('finishes sliding before dismissing the captured occurrence exactly once', () => {
    const { hook, onDismiss } = setup();
    drag(-WIDTH * 0.55);
    expect(translation()).toBe(-WIDTH);
    expect(onDismiss).not.toHaveBeenCalled();
    finishAnimation();
    finishAnimation();
    act(() => hook.result.current.dismiss());
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith('board:1:climb');
  });

  it.each([
    [-WIDTH * 0.54, 0],
    [-WIDTH * 0.24, -1500],
    [-WIDTH * 0.3, -799],
    [WIDTH * 0.8, -1500],
  ])('springs back below the release threshold (%spt, %spt/s)', (distance, velocity) => {
    const { onDismiss } = setup();
    drag(distance, velocity);
    expect(translation()).toBe(0);
    expect(native.animationEnds).toHaveLength(0);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('allows a leftward fling only after one quarter of the capsule', () => {
    const { onDismiss } = setup();
    drag(-WIDTH * 0.25, -800);
    finishAnimation();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('never dismisses a system-cancelled drag, even beyond the threshold', () => {
    const { onDismiss } = setup();
    drag(-WIDTH, -1500, true);
    expect(translation()).toBe(0);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it.each([false, true])('swallows the release tap after an activated pan (cancelled: %s)', (canceled) => {
    const { hook } = setup();
    drag(-20, 0, canceled);
    expect(hook.result.current.consumePanned()).toBe(true);
    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(hook.result.current.consumePanned()).toBe(false);
  });

  it('keeps an ordinary tap available when the pan never activates', () => {
    const { hook } = setup();
    act(() => {
      pan().onBegin();
      pan().onFinalize();
    });
    expect(hook.result.current.consumePanned()).toBe(false);
  });

  it('commits immediately under Reduce Motion with no release animation', () => {
    const { onDismiss } = setup({ reduceMotion: true });
    drag(-WIDTH * 0.6);
    expect(native.animationEnds).toHaveLength(0);
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith('board:1:climb');
  });

  it('does not dismiss a new occurrence when the previous drag releases late', () => {
    const { hook, initial, onDismiss } = setup();
    const oldPan = pan();
    act(() => {
      oldPan.onBegin();
      oldPan.onActivate();
      oldPan.onUpdate({ translationX: -120, velocityX: 0 });
    });
    hook.rerender({ ...initial, occurrenceKey: 'board:2:climb' });
    expect(translation()).toBe(0);
    act(() => {
      oldPan.onDeactivate({ translationX: -150, velocityX: -900, canceled: false });
      oldPan.onFinalize();
    });
    expect(onDismiss).not.toHaveBeenCalled();
    drag(-120);
    finishAnimation();
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith('board:2:climb');
  });

  it('ignores an old animation completion and leaves its replacement at rest', () => {
    const { hook, initial, onDismiss } = setup();
    drag(-120);
    hook.rerender({ ...initial, occurrenceKey: 'other-board:1:climb' });
    finishAnimation();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(translation()).toBe(0);
  });

  it('rejects completion already queued on JS when a newer lighting event arrives', () => {
    const { hook, initial, onDismiss } = setup();
    native.queueJs = true;
    drag(-120);
    finishAnimation();
    expect(native.jsCallbacks.length).toBeGreaterThan(0);
    hook.rerender({ ...initial, occurrenceKey: 'board:2:climb' });
    flushJs();
    expect(onDismiss).not.toHaveBeenCalled();
    drag(-120);
    flushJs();
    expect(hook.result.current.consumePanned()).toBe(true);
    finishAnimation(1);
    flushJs();
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith('board:2:climb');
  });

  it('cannot let an old release adopt a new occurrence’s active gesture', () => {
    const { hook, initial, onDismiss } = setup();
    const oldPan = pan();
    act(() => oldPan.onBegin());
    hook.rerender({ ...initial, occurrenceKey: 'board:2:climb' });
    const newPan = pan();
    act(() => {
      newPan.onBegin();
      newPan.onActivate();
      newPan.onUpdate({ translationX: -20, velocityX: 0 });
      oldPan.onUpdate({ translationX: -180, velocityX: -1500 });
      oldPan.onDeactivate({ translationX: -180, velocityX: -1500, canceled: false });
      oldPan.onFinalize();
    });
    expect(translation()).toBe(-20);
    expect(native.animationEnds).toHaveLength(0);
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      newPan.onUpdate({ translationX: -120, velocityX: 0 });
      newPan.onDeactivate({ translationX: -120, velocityX: 0, canceled: false });
      newPan.onFinalize();
    });
    finishAnimation();
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith('board:2:climb');
  });

  it('ignores an old accessibility action after the occurrence changes', () => {
    const { hook, initial, onDismiss } = setup();
    const oldDismiss = hook.result.current.dismiss;
    hook.rerender({ ...initial, occurrenceKey: 'board:2:climb' });
    act(() => oldDismiss());
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => hook.result.current.dismiss());
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith('board:2:climb');
  });

  it('ignores animation completion after unmount', () => {
    const { hook, onDismiss } = setup();
    drag(-120);
    hook.unmount();
    finishAnimation();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('disables the gesture when no dismiss action exists', () => {
    const { hook } = setup({ onDismiss: undefined });
    expect(native.config?.enabled).toBe(false);
    expect(() => act(() => hook.result.current.dismiss())).not.toThrow();
  });
});
