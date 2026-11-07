// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect, type ReactNode } from 'react';
import { BackHandler } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';

const router = vi.hoisted(() => ({ dismiss: vi.fn() }));
const navigation = vi.hoisted(() => ({
  setOptions: vi.fn(),
  isFocused: vi.fn(() => true),
  addListener: vi.fn(() => () => {}),
}));
const hardwareBack = vi.hoisted(() => ({
  listeners: [] as Array<() => boolean>,
  get listener(): (() => boolean) | null {
    return this.listeners.at(-1) ?? null;
  },
  dispatch(): boolean {
    return this.listeners.toReversed().some((listener) => listener());
  },
  remove: vi.fn(),
}));
const bridge = vi.hoisted(() => ({
  timings: [] as Array<{ target: number; config: Record<string, unknown>; complete?: (finished: boolean) => void }>,
  queued: [] as Array<() => void>,
  springs: [] as Array<(finished: boolean) => void>,
  gestures: [] as Array<Record<string, (...args: unknown[]) => void>>,
  cancelAnimation: vi.fn(),
}));
const platform = vi.hoisted(() => ({ OS: 'ios' }));
vi.mock('react-native', () => ({
  Platform: platform,
  BackHandler: {
    addEventListener: (_event: string, listener: () => boolean) => {
      hardwareBack.listeners.push(listener);
      return {
        remove: () => {
          hardwareBack.remove();
          const index = hardwareBack.listeners.indexOf(listener);
          if (index >= 0) hardwareBack.listeners.splice(index, 1);
        },
      };
    },
  },
  useWindowDimensions: () => ({ height: 900, width: 400 }),
}));
vi.mock('expo-router', () => ({ useNavigation: () => navigation, useRouter: () => router }));
vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  return {
    Easing: { cubic: 'cubic', out: (curve: unknown) => curve },
    ReduceMotion: { System: 'system' },
    withTiming: (target: number, config: Record<string, unknown>, complete?: (finished: boolean) => void) => {
      bridge.timings.push({ target, config, complete });
      return target;
    },
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
  platform.OS = 'ios';
  bridge.timings.length = 0;
  hardwareBack.listeners.length = 0;
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

// #5924: a second pop after the player is gone lands on the navigator under it,
// which pops the playlist and shows the page before it. One close is one pop.
describe('closing the player pops only the player', () => {
  function renderPlayer() {
    const scrollY = { value: 0 } as SharedValue<number>;
    return renderHook(() => {
      const motion = usePlaySwipeDismiss(1);
      useDrawerDismissGesture({ onDismiss: motion.close, swipeDismiss: motion.swipeDismiss, scrollYSV: scrollY });
      return motion;
    });
  }

  it('ignores a chevron tap while a released swipe slides the player away', () => {
    const { result } = renderPlayer();
    releaseGesture();
    act(() => result.current.close());
    act(() => bridge.springs[0](true));
    flushBridge();
    flushFrame();
    flushFrame();
    act(() => result.current.close());
    flushBridge();
    expect(router.dismiss).toHaveBeenCalledTimes(1);
  });

  it('ignores a swipe and a second chevron tap after the chevron closed it', () => {
    const { result } = renderPlayer();
    act(() => result.current.close());
    flushBridge();
    expect(router.dismiss).toHaveBeenCalledTimes(1);
    releaseGesture();
    act(() => result.current.close());
    flushBridge();
    flushFrame();
    flushFrame();
    expect(bridge.springs).toHaveLength(0);
    expect(router.dismiss).toHaveBeenCalledTimes(1);
  });
});

describe.each(['android', 'ios', 'web'])('player animation on %s', (platformName) => {
  const expectedAnimation = platformName === 'android' ? 'none' : 'slide_from_bottom';

  it('restores platform motion when a new target reopens the player', () => {
    platform.OS = platformName;
    const { rerender } = renderHook(({ nonce }) => usePlaySwipeDismiss(nonce), { initialProps: { nonce: 1 } });
    rerender({ nonce: 2 });
    expect(navigation.setOptions).toHaveBeenLastCalledWith({ animation: expectedAnimation });
  });

  it('restores platform motion after an aborted native dismissal', async () => {
    platform.OS = platformName;
    const { result } = renderHook(() => usePlaySwipeDismiss(1));
    await act(async () => {
      await result.current.dismissAndWait(async () => ({ status: 'aborted' }));
    });
    expect(navigation.setOptions).toHaveBeenLastCalledWith({ animation: expectedAnimation });
  });

  it('restores platform motion when another route covers a completed swipe', () => {
    platform.OS = platformName;
    const { result } = renderHook(() => usePlaySwipeDismiss(1));
    act(() => result.current.swipeDismiss.onComplete());
    expect(navigation.setOptions).toHaveBeenLastCalledWith({ animation: 'none' });
    navigation.isFocused.mockReturnValue(false);
    flushFrame();
    flushFrame();
    expect(navigation.setOptions).toHaveBeenLastCalledWith({ animation: expectedAnimation });
    expect(router.dismiss).not.toHaveBeenCalled();
  });

  it('removes an offscreen player without a second native animation', () => {
    platform.OS = platformName;
    const { result } = renderHook(() => usePlaySwipeDismiss(1));
    act(() => result.current.swipeDismiss.onComplete());
    flushFrame();
    flushFrame();
    expect(navigation.setOptions).toHaveBeenLastCalledWith({ animation: 'none' });
    expect(router.dismiss).toHaveBeenCalledTimes(1);
  });
});

describe('Android quick sheet motion', () => {
  beforeEach(() => {
    platform.OS = 'android';
  });

  it('opens upward in 200 ms and follows the system reduced-motion setting', () => {
    const { result } = renderHook(() => usePlaySwipeDismiss(1));
    expect(result.current.animatedStyle).toEqual({ transform: [{ translateY: 900 }] });
    expect(bridge.timings).toHaveLength(1);
    expect(bridge.timings[0]).toMatchObject({ target: 0, config: { duration: 200, reduceMotion: 'system' } });
  });

  it('finishes button closing before removing the route', () => {
    const { result } = renderHook(() => usePlaySwipeDismiss(1));
    act(() => result.current.close());
    expect(bridge.timings.at(-1)).toMatchObject({ target: 900, config: { duration: 200 } });
    expect(router.dismiss).not.toHaveBeenCalled();
    act(() => bridge.timings.at(-1)?.complete?.(true));
    flushBridge();
    flushFrame();
    flushFrame();
    expect(router.dismiss).toHaveBeenCalledTimes(1);
    expect(navigation.setOptions).toHaveBeenLastCalledWith({ animation: 'none' });
  });

  it('handles hardware Back only while the player is focused', async () => {
    renderHook(() => usePlaySwipeDismiss(1));
    await act(async () => {});
    navigation.isFocused.mockReturnValue(false);
    expect(hardwareBack.listener?.()).toBe(false);
    expect(bridge.timings).toHaveLength(1);
    navigation.isFocused.mockReturnValue(true);
    act(() => expect(hardwareBack.listener?.()).toBe(true));
    expect(bridge.timings.at(-1)?.target).toBe(900);
  });

  it('ignores canceled and stale close completions after a fresh target', () => {
    const { result, rerender } = renderHook(({ nonce }) => usePlaySwipeDismiss(nonce), { initialProps: { nonce: 1 } });
    act(() => result.current.close());
    const oldCompletion = bridge.timings.at(-1)?.complete;
    act(() => oldCompletion?.(false));
    flushBridge();
    flushFrame();
    flushFrame();
    expect(router.dismiss).not.toHaveBeenCalled();
    rerender({ nonce: 2 });
    act(() => oldCompletion?.(true));
    flushBridge();
    flushFrame();
    flushFrame();
    expect(router.dismiss).not.toHaveBeenCalled();
    expect(result.current.swipeDismiss.translateY.value).toBe(0);
  });

  it('releases the Back handler and cancels opening motion on unmount', async () => {
    const { unmount } = renderHook(() => usePlaySwipeDismiss(1));
    await act(async () => {});
    unmount();
    expect(hardwareBack.remove).toHaveBeenCalled();
    expect(bridge.cancelAnimation).toHaveBeenCalled();
  });
});

it('does not let a drag cancel Android entry, and accepts a fresh drag afterward', () => {
  platform.OS = 'android';
  const scrollY = { value: 0 } as SharedValue<number>;
  const { result } = renderHook(() => {
    const motion = usePlaySwipeDismiss(1);
    useDrawerDismissGesture({ onDismiss: motion.close, swipeDismiss: motion.swipeDismiss, scrollYSV: scrollY });
    return motion;
  });
  bridge.cancelAnimation.mockClear();
  releaseGesture();
  expect(bridge.cancelAnimation).not.toHaveBeenCalled();
  expect(bridge.springs).toHaveLength(0);
  act(() => bridge.timings[0].complete?.(true));
  releaseGesture();
  expect(bridge.springs).toHaveLength(1);
  expect(result.current.swipeDismiss.isDismissing.value).toBe(true);
});

it('registers Android Back after the navigator effects on a cold mount', async () => {
  platform.OS = 'android';
  const rootBack = vi.fn(() => true);
  function Navigator({ children }: { children: ReactNode }) {
    useEffect(() => {
      const subscription = BackHandler.addEventListener('hardwareBackPress', rootBack);
      return () => subscription.remove();
    }, []);
    return children;
  }
  renderHook(() => usePlaySwipeDismiss(1), { wrapper: Navigator });
  expect(hardwareBack.listener).toBe(rootBack);
  await act(async () => {});
  expect(hardwareBack.listener).not.toBe(rootBack);
  act(() => expect(hardwareBack.dispatch()).toBe(true));
  expect(rootBack).not.toHaveBeenCalled();
  expect(bridge.timings.at(-1)?.target).toBe(900);
});
