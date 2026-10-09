// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  return {
    useSharedValue: (initial: unknown) => {
      const ref = useRef<{ value: unknown } | null>(null);
      if (ref.current === null) ref.current = { value: initial };
      return ref.current;
    },
    runOnJS: (callback: () => void) => callback,
  };
});

type RecordedHandlers = Record<string, (...args: unknown[]) => unknown>;
const recordedBuilders: { handlers: RecordedHandlers; settings: Record<string, unknown> }[] = [];
vi.mock('react-native-gesture-handler', () => ({
  Gesture: {
    Pan: () => {
      const handlers: RecordedHandlers = {};
      const settings: Record<string, unknown> = {};
      recordedBuilders.push({ handlers, settings });
      const builder: Record<string, (...args: unknown[]) => unknown> = {};
      const proxy: typeof builder = new Proxy(builder, {
        get: (_target, method: string) => (argument: unknown) => {
          if (method.startsWith('on') && typeof argument === 'function') {
            handlers[method] = argument as RecordedHandlers[string];
          } else {
            settings[method] = argument;
          }
          return proxy;
        },
      });
      return proxy;
    },
  },
}));

import { useDeliberateScrollGesture } from '../use-deliberate-scroll-gesture';

type Options = Parameters<typeof useDeliberateScrollGesture>[0];
function makeOptions(overrides: Partial<Options> = {}): Options {
  return {
    scrollRef: { current: null },
    scrollYSV: { value: 40 } as Options['scrollYSV'],
    isPane: false,
    ...overrides,
  };
}
function latestBuilder() {
  const builder = recordedBuilders.at(-1);
  if (!builder) throw new Error('No Pan gesture composed');
  return builder;
}
function makeState() {
  return { activate: vi.fn(), fail: vi.fn() };
}
function touches(deltaX = 0, deltaY = 0) {
  return { allTouches: [{ absoluteX: 100 + deltaX, absoluteY: 100 + deltaY }] };
}

describe('useDeliberateScrollGesture', () => {
  beforeEach(() => {
    recordedBuilders.length = 0;
  });

  it('holds native scrolling through 23 points and releases at 24 without activating', () => {
    const onScrollIntent = vi.fn();
    const options = makeOptions({ onScrollIntent });
    renderHook(() => useDeliberateScrollGesture(options));
    const { handlers, settings } = latestBuilder();
    const state = makeState();
    expect(settings.blocksExternalGesture).toBe(options.scrollRef);
    expect(settings.manualActivation).toBe(true);
    expect(settings.maxPointers).toBe(1);
    handlers.onTouchesDown(touches(), state);
    handlers.onTouchesMove(touches(0, -10), state);
    handlers.onTouchesMove(touches(0, -23), state);
    expect(state.fail).not.toHaveBeenCalled();
    expect(onScrollIntent).not.toHaveBeenCalled();
    handlers.onTouchesMove(touches(0, -24), state);
    expect(state.fail).toHaveBeenCalledTimes(1);
    expect(state.activate).not.toHaveBeenCalled();
    expect(onScrollIntent).toHaveBeenCalledTimes(1);
  });

  it('reports scroll intent once per deliberate drag, including after cancellation', () => {
    const onScrollIntent = vi.fn();
    renderHook(() => useDeliberateScrollGesture(makeOptions({ onScrollIntent })));
    const { handlers } = latestBuilder();
    const state = makeState();
    handlers.onTouchesDown(touches(), state);
    handlers.onTouchesMove(touches(0, -24), state);
    handlers.onTouchesMove(touches(0, -40), state);
    expect(onScrollIntent).toHaveBeenCalledTimes(1);
    handlers.onTouchesCancelled({ allTouches: [] }, state);
    handlers.onFinalize();
    handlers.onTouchesDown(touches(0, 100), state);
    handlers.onTouchesMove(touches(0, 76), state);
    expect(onScrollIntent).toHaveBeenCalledTimes(2);
  });

  it('calls the latest scroll-intent callback without rebuilding the gesture', () => {
    const firstCallback = vi.fn();
    const nextCallback = vi.fn();
    const options = makeOptions({ onScrollIntent: firstCallback });
    const { result, rerender } = renderHook((props: Options) => useDeliberateScrollGesture(props), {
      initialProps: options,
    });
    const initialGesture = result.current;
    const { handlers } = latestBuilder();
    rerender({ ...options, onScrollIntent: nextCallback });
    const state = makeState();
    handlers.onTouchesDown(touches(), state);
    handlers.onTouchesMove(touches(0, -24), state);
    expect(firstCallback).not.toHaveBeenCalled();
    expect(nextCallback).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(initialGesture);
    expect(recordedBuilders).toHaveLength(1);
  });

  it('does not report intent for horizontal, pinch, dismissal, tiny drags or cancellation', () => {
    const onScrollIntent = vi.fn();
    const options = makeOptions({ onScrollIntent });
    options.scrollYSV.value = 0;
    renderHook(() => useDeliberateScrollGesture(options));
    const { handlers } = latestBuilder();
    const state = makeState();
    for (const event of [
      touches(30, 12),
      { allTouches: [...touches(0, -30).allTouches, ...touches(20, -30).allTouches] },
      touches(0, 30),
      touches(0, -23),
    ]) {
      handlers.onTouchesDown(touches(), state);
      handlers.onTouchesMove(event, state);
      handlers.onTouchesUp({ allTouches: [] }, state);
      handlers.onFinalize();
    }
    handlers.onTouchesDown(touches(), state);
    handlers.onTouchesMove(touches(0, -15), state);
    handlers.onTouchesCancelled({ allTouches: [] }, state);
    handlers.onFinalize();
    expect(onScrollIntent).not.toHaveBeenCalled();
  });

  it('yields promptly to horizontal and slightly diagonal carousel swipes', () => {
    renderHook(() => useDeliberateScrollGesture(makeOptions()));
    const { handlers } = latestBuilder();
    for (const [deltaX, deltaY] of [
      [11, 0],
      [10, 12],
    ]) {
      const state = makeState();
      handlers.onTouchesDown(touches(), state);
      handlers.onTouchesMove(touches(deltaX, deltaY), state);
      expect(state.fail).toHaveBeenCalledTimes(1);
      expect(state.activate).not.toHaveBeenCalled();
      handlers.onFinalize();
    }
  });

  it('uses the existing vertical ratio and keeps a clear vertical lock through drift', () => {
    renderHook(() => useDeliberateScrollGesture(makeOptions()));
    const { handlers } = latestBuilder();
    const state = makeState();
    handlers.onTouchesDown(touches(), state);
    handlers.onTouchesMove(touches(10, -15), state);
    handlers.onTouchesMove(touches(40, -23), state);
    expect(state.fail).not.toHaveBeenCalled();
    handlers.onTouchesMove(touches(40, -24), state);
    expect(state.fail).toHaveBeenCalledTimes(1);
  });

  it('releases downward dismissal at the top but keeps upward scrolling gated', () => {
    const options = makeOptions();
    options.scrollYSV.value = 0;
    renderHook(() => useDeliberateScrollGesture(options));
    const { handlers } = latestBuilder();
    const dismissState = makeState();
    handlers.onTouchesDown(touches(), dismissState);
    handlers.onTouchesMove(touches(0, 11), dismissState);
    expect(dismissState.fail).toHaveBeenCalledTimes(1);
    handlers.onFinalize();
    const scrollState = makeState();
    handlers.onTouchesDown(touches(), scrollState);
    handlers.onTouchesMove(touches(0, -23), scrollState);
    expect(scrollState.fail).not.toHaveBeenCalled();
  });

  it('captures scroll position at touch-down so reaching the top cannot turn scrolling into dismissal', () => {
    const options = makeOptions();
    renderHook(() => useDeliberateScrollGesture(options));
    const { handlers } = latestBuilder();
    const state = makeState();
    handlers.onTouchesDown(touches(), state);
    options.scrollYSV.value = 0;
    handlers.onTouchesMove(touches(0, 23), state);
    expect(state.fail).not.toHaveBeenCalled();
    handlers.onTouchesMove(touches(0, 24), state);
    expect(state.fail).toHaveBeenCalledTimes(1);
  });

  it('keeps the gesture graph stable while pane changes update dismissal eligibility', () => {
    const options = makeOptions();
    options.scrollYSV.value = 0;
    const { result, rerender } = renderHook((props: Options) => useDeliberateScrollGesture(props), {
      initialProps: options,
    });
    const initialGesture = result.current;
    const { handlers } = latestBuilder();
    rerender({ ...options, isPane: true });
    const state = makeState();
    handlers.onTouchesDown(touches(), state);
    handlers.onTouchesMove(touches(0, 23), state);
    expect(state.fail).not.toHaveBeenCalled();
    handlers.onTouchesMove(touches(0, 24), state);
    expect(state.fail).toHaveBeenCalledTimes(1);
    handlers.onFinalize();
    rerender(options);
    state.fail.mockClear();
    handlers.onTouchesDown(touches(), state);
    handlers.onTouchesMove(touches(0, 11), state);
    expect(state.fail).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(initialGesture);
    expect(recordedBuilders).toHaveLength(1);
  });

  it('releases two-finger input both at touch-down and during a waiting drag', () => {
    renderHook(() => useDeliberateScrollGesture(makeOptions()));
    const { handlers } = latestBuilder();
    const multiTouch = { allTouches: [...touches().allTouches, ...touches(20, 20).allTouches] };
    const state = makeState();
    handlers.onTouchesDown(multiTouch, state);
    expect(state.fail).toHaveBeenCalledTimes(1);
    handlers.onFinalize();
    handlers.onTouchesDown(touches(), state);
    handlers.onTouchesMove(touches(0, -15), state);
    handlers.onTouchesMove(multiTouch, state);
    expect(state.fail).toHaveBeenCalledTimes(2);
    expect(state.activate).not.toHaveBeenCalled();
  });

  it('releases every finger-up and cancellation and starts the next drag with fresh state', () => {
    renderHook(() => useDeliberateScrollGesture(makeOptions()));
    const { handlers } = latestBuilder();
    for (const terminalCallback of ['onTouchesUp', 'onTouchesCancelled', 'onTouchesCancelled']) {
      const state = makeState();
      handlers.onTouchesDown(touches(), state);
      handlers.onTouchesMove(touches(0, -15), state);
      handlers[terminalCallback]({ allTouches: [] }, state);
      expect(state.fail).toHaveBeenCalledTimes(1);
      handlers.onFinalize();
      state.fail.mockClear();
      handlers.onTouchesDown(touches(200, 200), state);
      handlers.onTouchesMove(touches(211, 200), state);
      expect(state.fail).toHaveBeenCalledTimes(1);
      handlers.onFinalize();
    }
  });
});
