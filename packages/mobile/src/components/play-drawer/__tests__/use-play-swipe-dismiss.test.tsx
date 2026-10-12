// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SharedValue } from 'react-native-reanimated';

const router = vi.hoisted(() => ({ dismiss: vi.fn() }));
const navigation = vi.hoisted(() => ({
  setOptions: vi.fn(),
  isFocused: vi.fn(() => true),
  addListener: vi.fn(() => () => {}),
}));
const bridge = vi.hoisted(() => ({
  queued: [] as Array<() => void>,
  springs: [] as Array<(finished: boolean) => void>,
  gestures: [] as Array<Record<string, (...args: unknown[]) => void>>,
  cancelAnimation: vi.fn(),
}));
vi.mock('react-native', () => ({ useWindowDimensions: () => ({ height: 900, width: 400 }) }));
vi.mock('expo-router', () => ({ useNavigation: () => navigation, useRouter: () => router }));
vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  return {
    useSharedValue: (initial: unknown) => useRef({ value: initial }).current,
    useAnimatedStyle: (factory: () => unknown) => factory(),
    withSpring: (target: number, _config?: unknown, complete?: (finished: boolean) => void) => {
      if (complete) bridge.springs.push(complete);
      return target;
    },
    cancelAnimation: bridge.cancelAnimation,
    runOnUI:
      (callback: (...args: unknown[]) => void) =>
      (...args: unknown[]) =>
        callback(...args),
    runOnJS:
      (callback: (...args: unknown[]) => void) =>
      (...args: unknown[]) =>
        bridge.queued.push(() => callback(...args)),
  };
});
vi.mock('react-native-gesture-handler', () => ({
  Gesture: {
    Pan: () => {
      const handlers: Record<string, (...args: unknown[]) => void> = {};
      bridge.gestures.push(handlers);
      const builder: Record<string, (...args: unknown[]) => unknown> = {};
      const proxy = new Proxy(builder, {
        get: (_target, property: string) => (handler: unknown) => {
          if (property.startsWith('on') && typeof handler === 'function')
            handlers[property] = handler as (...args: unknown[]) => void;
          return proxy;
        },
      });
      return proxy;
    },
  },
}));

import { useDrawerDismissGesture } from '../use-drawer-dismiss-gesture';
import { usePlaySwipeDismiss } from '../use-play-swipe-dismiss';

const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
function flushFrame() {
  const callbacks = [...frames.values()];
  frames.clear();
  act(() => callbacks.forEach((callback) => callback(0)));
}
function flushBridge() {
  const callbacks = bridge.queued.splice(0);
  act(() => callbacks.forEach((callback) => callback()));
}
function releaseGesture() {
  const handlers = bridge.gestures.at(-1);
  if (!handlers) throw new Error('dismiss gesture was not mounted');
  act(() => {
    handlers.onBegin();
    handlers.onUpdate({ translationY: 180 });
    handlers.onEnd({ velocityY: 800 });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  bridge.queued.length = bridge.springs.length = bridge.gestures.length = 0;
  frames.clear();
  nextFrame = 0;
  navigation.isFocused.mockReturnValue(true);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => frames.delete(handle));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('play swipe dismissal target ownership', () => {
  it('rejects updates and release from a drag that began before a fresh opening', () => {
    const scrollY = { value: 0 } as SharedValue<number>;
    const { result, rerender } = renderHook(
      ({ nonce }) => {
        const motion = usePlaySwipeDismiss(nonce);
        useDrawerDismissGesture({ onDismiss: motion.close, swipeDismiss: motion.swipeDismiss, scrollYSV: scrollY });
        return motion;
      },
      { initialProps: { nonce: 1 } },
    );
    const oldDrag = bridge.gestures.at(-1);
    if (!oldDrag) throw new Error('dismiss gesture was not mounted');
    act(() => {
      oldDrag.onBegin();
      oldDrag.onUpdate({ translationY: 80 });
    });
    expect(result.current.swipeDismiss.translateY.value).toBe(80);
    rerender({ nonce: 2 });
    act(() => {
      oldDrag.onUpdate({ translationY: 180 });
      oldDrag.onEnd({ velocityY: 800 });
      oldDrag.onFinalize({}, true);
    });
    expect(result.current.swipeDismiss.translateY.value).toBe(0);
    expect(result.current.swipeDismiss.isDismissing.value).toBe(false);
    expect(bridge.springs).toHaveLength(0);
    expect(bridge.queued).toHaveLength(0);
    flushFrame();
    flushFrame();
    expect(router.dismiss).not.toHaveBeenCalled();

    releaseGesture();
    expect(result.current.swipeDismiss.isDismissing.value).toBe(true);
    act(() => bridge.springs[0](true));
    flushBridge();
    flushFrame();
    flushFrame();
    expect(router.dismiss).toHaveBeenCalledTimes(1);
  });

  it('rejects an old queued gesture completion even after the fresh target starts its own dismissal', () => {
    const scrollY = { value: 0 } as SharedValue<number>;
    const { result, rerender } = renderHook(
      ({ nonce }) => {
        const motion = usePlaySwipeDismiss(nonce);
        useDrawerDismissGesture({ onDismiss: motion.close, swipeDismiss: motion.swipeDismiss, scrollYSV: scrollY });
        return motion;
      },
      { initialProps: { nonce: 1 } },
    );
    releaseGesture();
    act(() => bridge.springs[0](true));
    expect(bridge.queued).toHaveLength(1);
    rerender({ nonce: 2 });
    expect(result.current.swipeDismiss.translateY.value).toBe(0);
    expect(result.current.swipeDismiss.isDismissing.value).toBe(false);
    releaseGesture();
    expect(result.current.swipeDismiss.isDismissing.value).toBe(true);
    flushBridge();
    flushFrame();
    flushFrame();
    expect(router.dismiss).not.toHaveBeenCalled();
    act(() => bridge.springs[1](true));
    flushBridge();
    flushFrame();
    flushFrame();
    expect(router.dismiss).toHaveBeenCalledTimes(1);
  });

  it('ignores an old canceled spring after a fresh target starts another close', () => {
    const scrollY = { value: 0 } as SharedValue<number>;
    const { result, rerender } = renderHook(
      ({ nonce }) => {
        const motion = usePlaySwipeDismiss(nonce);
        useDrawerDismissGesture({ onDismiss: motion.close, swipeDismiss: motion.swipeDismiss, scrollYSV: scrollY });
        return motion;
      },
      { initialProps: { nonce: 1 } },
    );
    releaseGesture();
    rerender({ nonce: 2 });
    releaseGesture();
    act(() => bridge.springs[0](false));
    expect(result.current.swipeDismiss.isDismissing.value).toBe(true);
    expect(result.current.swipeDismiss.translateY.value).toBe(900);
    act(() => bridge.springs[1](true));
    flushBridge();
    flushFrame();
    flushFrame();
    expect(router.dismiss).toHaveBeenCalledTimes(1);
  });

  it('fences an old queued native chevron close against a fresh target', () => {
    const { result, rerender } = renderHook(({ nonce }) => usePlaySwipeDismiss(nonce), { initialProps: { nonce: 1 } });
    act(() => result.current.close());
    expect(bridge.queued).toHaveLength(1);
    rerender({ nonce: 2 });
    flushBridge();
    expect(router.dismiss).not.toHaveBeenCalled();
    expect(result.current.swipeDismiss.isDismissing.value).toBe(false);
  });

  it('rejects a queued gesture completion after an aborted native close restores the same opener', async () => {
    const scrollY = { value: 0 } as SharedValue<number>;
    const { result } = renderHook(() => {
      const motion = usePlaySwipeDismiss(1);
      useDrawerDismissGesture({ onDismiss: motion.close, swipeDismiss: motion.swipeDismiss, scrollYSV: scrollY });
      return motion;
    });
    releaseGesture();
    act(() => bridge.springs[0](true));
    await act(async () => {
      await result.current.dismissAndWait(async () => ({ status: 'aborted' }));
    });
    expect(result.current.swipeDismiss.translateY.value).toBe(0);
    releaseGesture();
    flushBridge();
    flushFrame();
    flushFrame();
    expect(router.dismiss).not.toHaveBeenCalled();
    expect(result.current.swipeDismiss.isDismissing.value).toBe(true);
    act(() => bridge.springs[1](true));
    flushBridge();
    flushFrame();
    flushFrame();
    expect(router.dismiss).toHaveBeenCalledTimes(1);
  });
});
