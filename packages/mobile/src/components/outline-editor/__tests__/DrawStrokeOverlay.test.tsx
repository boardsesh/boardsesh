// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { SharedValue } from 'react-native-reanimated';
import type { GestureTouchEvent } from 'react-native-gesture-handler';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const installed = vi.hoisted(() => ({ callbacks: new Map<string, unknown>(), kind: '' }));
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
  StyleSheet: { absoluteFill: {} },
}));
vi.mock('react-native-reanimated', () => ({
  useSharedValue: <T,>(initial: T) => ({ value: initial }),
  runOnJS: <T,>(callback: T) => callback,
}));
vi.mock('react-native-gesture-handler', () => {
  const builder = (kind: string) => {
    installed.kind = kind;
    const gesture = {
      minPointers: () => gesture,
      manualActivation: () => gesture,
      simultaneousWithExternalGesture: () => gesture,
      onTouchesDown: (callback: unknown) => register('down', callback),
      onTouchesMove: (callback: unknown) => register('move', callback),
      onTouchesUp: (callback: unknown) => register('up', callback),
      onTouchesCancelled: (callback: unknown) => register('cancel', callback),
      onStart: (callback: unknown) => register('start', callback),
      onUpdate: (callback: unknown) => register('update', callback),
      onEnd: (callback: unknown) => register('end', callback),
      onFinalize: (callback: unknown) => register('finalize', callback),
    };
    function register(name: string, callback: unknown) {
      installed.callbacks.set(name, callback);
      return gesture;
    }
    return gesture;
  };
  return {
    Gesture: { Manual: () => builder('manual'), Pan: () => builder('pan') },
    GestureDetector: ({ children }: { children: ReactNode }) => children,
    PointerType: { TOUCH: 0, STYLUS: 1 },
  };
});
import { DrawStrokeOverlay } from '../DrawStrokeOverlay';

const touch = (id = 7, x = 40, y = 60) => ({ id, x, y, absoluteX: x, absoluteY: y });
// Never synthesize Pan onStart for stationary touches. iOS snapshots
// allTouches before unregistering UP pointers; numberOfTouches is already reduced.
function event(changedTouches = [touch()], allTouches = changedTouches, pointerType = 0): GestureTouchEvent {
  return {
    handlerTag: 1,
    state: 4,
    eventType: 1,
    numberOfTouches: allTouches.length,
    changedTouches,
    allTouches,
    pointerType,
  };
}
function upEvent(
  changedTouches = [touch()],
  remainingTouches: ReturnType<typeof touch>[] = [],
  pointerType = 0,
): GestureTouchEvent {
  return {
    ...event(changedTouches, [...remainingTouches, ...changedTouches], pointerType),
    eventType: 3,
    numberOfTouches: remainingTouches.length,
  };
}
function shared<T>(initial: T): SharedValue<T> {
  return {
    value: initial,
    get() {
      return this.value;
    },
    set(next) {
      this.value = typeof next === 'function' ? (next as (current: T) => T)(this.value) : next;
    },
    addListener() {},
    removeListener() {},
    modify(modifier) {
      if (modifier) this.value = modifier(this.value);
    },
  };
}
function mount(acceptStationaryTaps = true, fingerDraw = true) {
  const points = shared<number[]>([]);
  const start = vi.fn();
  const end = vi.fn();
  const cancel = vi.fn();
  const manager = { begin: vi.fn(), activate: vi.fn(), end: vi.fn(), fail: vi.fn() };
  render(
    <DrawStrokeOverlay
      acceptStationaryTaps={acceptStationaryTaps}
      pointsSV={points}
      fingerDrawSV={shared(fingerDraw)}
      scaleSV={shared(2)}
      translateXSV={shared(10)}
      translateYSV={shared(20)}
      containerWidthSV={shared(100)}
      containerHeightSV={shared(100)}
      boardScale={2}
      pinchRef={{ current: undefined }}
      onStrokeStart={start}
      onStrokeEnd={end}
      onStrokeCancel={cancel}
    />,
  );
  function send(name: string, payload: unknown = event(), success?: boolean) {
    const callback = installed.callbacks.get(name) as
      | ((payload: unknown, managerState: typeof manager | boolean) => void)
      | undefined;
    callback?.(payload, success ?? manager);
  }
  return { points, start, end, cancel, manager, send };
}
beforeEach(() => installed.callbacks.clear());
describe('Add Draw pointer lifecycle', () => {
  it.each(['stationary tap', 'stationary long press'])('commits a %s without a Pan start event', (kind) => {
    const stroke = mount();
    stroke.send('down');
    expect(stroke.start).toHaveBeenCalledTimes(1);
    expect(stroke.manager.begin).toHaveBeenCalledTimes(1);
    expect(stroke.manager.activate).toHaveBeenCalledTimes(1);
    if (kind === 'stationary long press') {
      vi.useFakeTimers();
      vi.advanceTimersByTime(60_000);
      vi.useRealTimers();
    }
    stroke.send('up', upEvent([touch()], []));
    stroke.send('finalize');
    expect(stroke.end).toHaveBeenCalledExactlyOnceWith([80, 90]);
    expect(stroke.cancel).not.toHaveBeenCalled();
    expect(stroke.manager.end).toHaveBeenCalledTimes(1);
  });
  it('samples the owned pointer and final UP through the live zoom transform', () => {
    const stroke = mount();
    stroke.send('down');
    stroke.send('move', event([touch(7, 44, 60)]));
    stroke.send('up', upEvent([touch(7, 48, 60)], []));
    expect(stroke.end).toHaveBeenCalledExactlyOnceWith([80, 90, 84, 90, 88, 90]);
  });
  it('ignores mismatched UP and late UP from the preceding pointer', () => {
    const stroke = mount();
    stroke.send('down');
    stroke.send('up', upEvent([touch(8)], [touch()]));
    stroke.send('cancel', event([touch(8)], [touch()]));
    expect(stroke.end).not.toHaveBeenCalled();
    stroke.send('up', upEvent([touch()], []));
    stroke.send('down', event([touch(9)]));
    stroke.send('up', upEvent([touch()], [touch(9)]));
    expect(stroke.end).toHaveBeenCalledTimes(1);
    stroke.send('up', upEvent([touch(9)], []));
    expect(stroke.end).toHaveBeenCalledTimes(2);
  });
  it.each(['second finger', 'cancel'])('cancels once on %s before late UP/finalize', (reason) => {
    const stroke = mount();
    stroke.send('down');
    stroke.manager.fail.mockImplementation(() => stroke.send('finalize'));
    stroke.send(
      reason === 'cancel' ? 'cancel' : 'down',
      reason === 'cancel' ? event([touch()], []) : event([touch(8)], [touch(), touch(8)]),
    );
    stroke.send('up', upEvent([touch()], []));
    stroke.send('finalize');
    expect(stroke.cancel).toHaveBeenCalledTimes(1);
    expect(stroke.points.value).toEqual([]);
    expect(stroke.end).not.toHaveBeenCalled();
    expect(stroke.manager.fail).toHaveBeenCalledTimes(1);
  });
  it('cancels a system interruption with no changed pointers before late UP/finalize', () => {
    const stroke = mount();
    stroke.send('down');
    stroke.manager.fail.mockImplementation(() => stroke.send('finalize'));
    stroke.send('cancel', event([], []));
    stroke.send('up', upEvent([touch()], []));
    stroke.send('finalize');
    expect(stroke.cancel).toHaveBeenCalledTimes(1);
    expect(stroke.points.value).toEqual([]);
    expect(stroke.end).not.toHaveBeenCalled();
    expect(stroke.manager.fail).toHaveBeenCalledTimes(1);
  });
  it('declines two fingers together and disabled finger drawing without starting', () => {
    const stroke = mount();
    stroke.send('down', event([touch(), touch(8)]));
    stroke.send('finalize');
    expect(stroke.start).not.toHaveBeenCalled();
    expect(stroke.cancel).not.toHaveBeenCalled();
    const disabled = mount(true, false);
    disabled.send('down');
    expect(disabled.start).not.toHaveBeenCalled();
  });
  it('ignores a palm DOWN/MOVE/UP during a stylus stroke', () => {
    const stroke = mount(true, false);
    stroke.send('down', event([touch()], [touch()], 1));
    stroke.send('down', event([touch(8, 90, 90)], [touch(), touch(8)]));
    stroke.send('move', event([touch(8, 95, 95)], [touch(), touch(8)]));
    stroke.send('up', upEvent([touch(8)], [touch()]));
    stroke.send('cancel', event([touch(8)], [touch()]));
    expect(stroke.end).not.toHaveBeenCalled();
    stroke.send('up', upEvent([touch()], [], 1));
    expect(stroke.end).toHaveBeenCalledExactlyOnceWith([80, 90]);
    expect(stroke.cancel).not.toHaveBeenCalled();
  });
  it('clears ownership before synchronous end finalization and cancels interruptions once', () => {
    const stroke = mount();
    stroke.manager.end.mockImplementation(() => stroke.send('finalize'));
    stroke.send('down');
    stroke.send('up', upEvent([touch()], []));
    expect(stroke.end).toHaveBeenCalledTimes(1);
    expect(stroke.cancel).not.toHaveBeenCalled();
    stroke.send('down');
    stroke.send('finalize');
    stroke.send('finalize');
    stroke.send('up', upEvent([touch()], []));
    expect(stroke.cancel).toHaveBeenCalledTimes(1);
    expect(stroke.end).toHaveBeenCalledTimes(1);
  });
  it('opts Add into stationary taps while leaving Trace on its default path', () => {
    const source = readFileSync(
      `${process.cwd()}/packages/mobile/src/components/outline-editor/SprayHoldEditorScreen.tsx`,
      'utf8',
    );
    const addSection = source.slice(source.indexOf("if (tool === 'add')"), source.indexOf("if (tool === 'trace')"));
    expect(addSection).toContain('acceptStationaryTaps');
    const traceSection = source.slice(source.indexOf("if (tool === 'trace')"));
    expect(traceSection).not.toContain('acceptStationaryTaps');
  });
  it('retains the Trace pan stroke path', () => {
    const stroke = mount(false);
    expect(installed.kind).toBe('pan');
    stroke.send('down');
    stroke.send('start', { x: 40, y: 60 });
    stroke.send('update', { x: 48, y: 60 });
    stroke.send('end', {}, true);
    stroke.send('finalize', {}, true);
    expect(stroke.end).toHaveBeenCalledExactlyOnceWith([80, 90, 88, 90]);
    expect(stroke.cancel).not.toHaveBeenCalled();
  });
});
