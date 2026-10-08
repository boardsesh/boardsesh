// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createElement, useEffect, useRef, type ReactNode } from 'react';

type GestureHandler = (...args: unknown[]) => void;
type TestGesture = { enabled: boolean; handlers: Record<string, GestureHandler> };
const control = vi.hoisted(() => ({
  gestures: [] as TestGesture[],
  queue: [] as (() => void)[],
  track: null as null | {
    style: { height?: number }[];
    accessibilityActions?: unknown[];
    accessibilityState: { disabled: boolean };
    onAccessibilityAction: (event: { nativeEvent: { actionName: string } }) => void;
  },
}));
vi.mock('react-native', () => ({
  View: (props: { children?: ReactNode; onLayout?: (event: unknown) => void; accessibilityRole?: string }) => {
    useEffect(() => {
      props.onLayout?.({ nativeEvent: { layout: { width: 220 } } });
    }, []);
    if (props.accessibilityRole === 'adjustable') control.track = props as unknown as typeof control.track;
    return createElement('div', null, props.children);
  },
  StyleSheet: { create: (styles: unknown) => styles },
  Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec.ios },
  PlatformColor: (color: string) => color,
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: { children?: ReactNode }) => createElement('div', null, children) },
  useSharedValue: (initial: number | boolean) => {
    const reference = useRef({
      value: initial,
      get() {
        return this.value;
      },
    });
    return reference.current;
  },
  useAnimatedStyle: (callback: () => unknown) => callback(),
  withSpring: (candidate: number) => candidate,
  runOnJS:
    (callback: GestureHandler) =>
    (...args: unknown[]) =>
      control.queue.push(() => callback(...args)),
}));
vi.mock('react-native-gesture-handler', () => {
  function builder() {
    const gesture: TestGesture = { enabled: true, handlers: {} };
    control.gestures.push(gesture);
    const fluent: Record<string, (...args: unknown[]) => unknown> = {};
    for (const name of ['activeOffsetX', 'failOffsetY', 'enabled', 'onBegin', 'onUpdate', 'onEnd', 'onFinalize']) {
      fluent[name] = (...args: unknown[]) => {
        if (name === 'enabled') gesture.enabled = !!args[0];
        else if (name.startsWith('on')) gesture.handlers[name] = args[0] as GestureHandler;
        return fluent;
      };
    }
    return fluent;
  }
  return {
    Gesture: { Pan: builder, Tap: builder, Race: (...gestures: unknown[]) => gestures },
    GestureDetector: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  };
});
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { fill: '#eee' }, brandColors: { primary: '#000' } }),
}));
vi.mock('../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
const { ValueSlider } = await import('../ValueSlider');
const round = (index: number) => Math.round(index);
const adjust = (index: number, direction: 1 | -1) => Math.max(0, Math.min(2, index + direction));
const format = (index: number) => ['Outline', 'Soft', 'Classic'][index] ?? '';
function sliderProps() {
  return {
    value: 0,
    min: 0,
    max: 2,
    round,
    notch: round,
    adjust,
    format,
    accessibilityLabel: 'Look',
    onLiveChange: vi.fn(),
    onCommit: vi.fn(),
    onCancel: vi.fn(),
  };
}
beforeEach(() => {
  control.gestures = [];
  control.queue = [];
  control.track = null;
});
afterEach(cleanup);
describe('ValueSlider optional picker geometry and disabling', () => {
  it('keeps existing 28pt geometry and supports a real 44pt gesture target', () => {
    const props = sliderProps();
    const { rerender } = render(<ValueSlider {...props} />);
    expect(control.track?.style.at(-1)?.height).toBe(28);
    rerender(<ValueSlider {...props} touchTargetHeight={44} />);
    expect(control.track?.style.at(-1)?.height).toBe(44);
  });
  it('supports named accessibility changes and rejects unknown or disabled actions', () => {
    const props = sliderProps();
    const { rerender } = render(<ValueSlider {...props} />);
    act(() => control.track?.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } }));
    expect(props.onCommit).toHaveBeenCalledExactlyOnceWith(1);
    act(() => control.track?.onAccessibilityAction({ nativeEvent: { actionName: 'activate' } }));
    expect(props.onCommit).toHaveBeenCalledOnce();
    const queuedAX = control.track?.onAccessibilityAction;
    rerender(<ValueSlider {...props} disabled />);
    act(() => queuedAX?.({ nativeEvent: { actionName: 'increment' } }));
    expect(props.onCommit).toHaveBeenCalledOnce();
    expect(control.track?.accessibilityState.disabled).toBe(true);
    expect(control.track?.accessibilityActions).toBeUndefined();
    expect(control.gestures.slice(-2).every((gesture) => !gesture.enabled)).toBe(true);
  });
  it('rejects callbacks from before disable/re-enable, while fresh gestures work', () => {
    const props = sliderProps();
    const { rerender } = render(<ValueSlider {...props} />);
    const oldPan = control.gestures.find((gesture) => gesture.handlers.onUpdate);
    const oldAX = control.track?.onAccessibilityAction;
    act(() => {
      oldPan?.handlers.onBegin?.();
      oldPan?.handlers.onUpdate?.({ translationX: 100 });
      oldPan?.handlers.onEnd?.();
      oldPan?.handlers.onFinalize?.({}, false);
    });
    rerender(<ValueSlider {...props} disabled />);
    rerender(<ValueSlider {...props} />);
    act(() => {
      for (const callback of control.queue) callback();
      oldAX?.({ nativeEvent: { actionName: 'increment' } });
    });
    expect(props.onLiveChange).not.toHaveBeenCalled();
    expect(props.onCommit).not.toHaveBeenCalled();
    expect(props.onCancel).not.toHaveBeenCalled();
    control.queue = [];
    const newPan = control.gestures.findLast((gesture) => gesture.handlers.onUpdate);
    act(() => {
      newPan?.handlers.onBegin?.();
      newPan?.handlers.onUpdate?.({ translationX: 100 });
      newPan?.handlers.onEnd?.();
      for (const callback of control.queue) callback();
    });
    expect(props.onLiveChange).toHaveBeenCalled();
    expect(props.onCommit).toHaveBeenCalled();
  });
  it('blocks already queued live, commit, and cancellation callbacks after disabling', () => {
    const props = sliderProps();
    const { rerender } = render(<ValueSlider {...props} />);
    const pan = control.gestures.find((gesture) => gesture.handlers.onUpdate);
    act(() => {
      pan?.handlers.onBegin?.();
      pan?.handlers.onUpdate?.({ translationX: 100 });
      pan?.handlers.onEnd?.();
      pan?.handlers.onFinalize?.({}, false);
    });
    expect(control.queue.length).toBeGreaterThanOrEqual(3);
    rerender(<ValueSlider {...props} disabled />);
    act(() => {
      for (const callback of control.queue) callback();
    });
    expect(props.onLiveChange).not.toHaveBeenCalled();
    expect(props.onCommit).not.toHaveBeenCalled();
    expect(props.onCancel).not.toHaveBeenCalled();
  });
});
