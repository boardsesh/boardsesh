// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { URL as FileURL } from 'node:url';
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
import { fallbackRadiusAt, selectedDragIdAt } from '../spray-gesture-math';
import type { SprayLoupeFeed } from '../spray-loupe-feed';

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
function loupeFeed(): SprayLoupeFeed {
  return {
    touchDownAtSV: shared(0),
    xSV: shared(0),
    ySV: shared(0),
    renderXSV: shared(0),
    renderYSV: shared(0),
    zoomSV: shared(1),
  };
}
type OptIns = {
  declineOnSelection?: number[];
  declineHitHolds?: number[];
  onStylusSeen?: () => void;
  loupe?: SprayLoupeFeed;
};
function mount(acceptStationaryTaps = true, fingerDraw = true, optIns: OptIns = {}) {
  const points = shared<number[]>([]);
  const start = vi.fn();
  const end = vi.fn();
  const cancel = vi.fn();
  const selection = optIns.declineOnSelection ? shared<number[]>(optIns.declineOnSelection) : undefined;
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
      loupe={optIns.loupe}
      declineOnSelectionSV={selection}
      declineHitHoldsSV={optIns.declineHitHolds ? shared<number[]>(optIns.declineHitHolds) : undefined}
      onStylusSeen={optIns.onStylusSeen}
    />,
  );
  function send(name: string, payload: unknown = event(), success?: boolean) {
    const callback = installed.callbacks.get(name) as
      | ((payload: unknown, managerState: typeof manager | boolean) => void)
      | undefined;
    callback?.(payload, success ?? manager);
  }
  return { points, start, end, cancel, manager, send, selection };
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
    const source = readFileSync(new FileURL('../SprayHoldEditorScreen.tsx', import.meta.url), 'utf8');
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
describe('the loupe feed', () => {
  it('follows a finger stroke in clip points and unzoomed render px, then lets go on UP', () => {
    const loupe = loupeFeed();
    const stroke = mount(true, true, { loupe });
    stroke.send('down');
    expect(loupe.touchDownAtSV.value).toBeGreaterThan(0);
    // Clip (40, 60) through scale 2, translate (10, 20) about the 100 pt container's centre.
    expect([loupe.xSV.value, loupe.ySV.value]).toEqual([40, 60]);
    expect([loupe.renderXSV.value, loupe.renderYSV.value]).toEqual([40, 45]);
    expect(loupe.zoomSV.value).toBe(2);
    const touchDownAt = loupe.touchDownAtSV.value;
    stroke.send('move', event([touch(7, 48, 60)]));
    expect(loupe.xSV.value).toBe(48);
    // The same touch: the delay still runs from touch-down.
    expect(loupe.touchDownAtSV.value).toBe(touchDownAt);
    stroke.send('up', upEvent([touch(7, 48, 60)], []));
    expect(loupe.touchDownAtSV.value).toBe(0);
  });
  it('lets go when a second finger turns the stroke into a pinch', () => {
    const loupe = loupeFeed();
    const stroke = mount(true, true, { loupe });
    stroke.send('down');
    stroke.send('down', event([touch(8)], [touch(), touch(8)]));
    expect(loupe.touchDownAtSV.value).toBe(0);
  });
  it('is never fed for a stylus', () => {
    const loupe = loupeFeed();
    const stroke = mount(true, false, { loupe });
    stroke.send('down', event([touch()], [touch()], 1));
    stroke.send('move', event([touch(7, 48, 60)], [touch(7, 48, 60)], 1));
    expect(loupe.touchDownAtSV.value).toBe(0);
    expect(loupe.xSV.value).toBe(0);
  });
  it('follows a Trace finger stroke and lets go on finalize', () => {
    const loupe = loupeFeed();
    const stroke = mount(false, true, { loupe });
    stroke.send('down');
    stroke.send('start', { x: 40, y: 60 });
    expect(loupe.touchDownAtSV.value).toBeGreaterThan(0);
    stroke.send('update', { x: 48, y: 60 });
    expect(loupe.xSV.value).toBe(48);
    stroke.send('end', {}, true);
    stroke.send('finalize', {}, true);
    expect(loupe.touchDownAtSV.value).toBe(0);
  });
  it('is opt-in: the catalogue editor passes no loupe', () => {
    const source = readFileSync(new FileURL('../OutlineCanvasScreen.tsx', import.meta.url), 'utf8');
    expect(source).not.toContain('loupe');
  });
});

// The spray editor's iPad Pencil surface: Add's Manual recognizer, finger draw
// off, stepping aside for the selected hold. The default touch (40, 60) lands
// on board (80, 90) through the mounted zoom transform.
const STYLUS = 1;
describe('Pencil surface opt-ins', () => {
  it('draws with a stylus while finger draw is off, and fails a finger at touch-down', () => {
    const stroke = mount(true, false);
    stroke.send('down');
    expect(stroke.manager.fail).toHaveBeenCalledTimes(1);
    expect(stroke.start).not.toHaveBeenCalled();
    stroke.send('down', event([touch()], [touch()], STYLUS));
    stroke.send('up', upEvent([touch()], [], STYLUS));
    expect(stroke.start).toHaveBeenCalledTimes(1);
    expect(stroke.end).toHaveBeenCalledExactlyOnceWith([80, 90]);
  });

  it('declines a stylus touch on the selected hold so the move underneath can take it', () => {
    const stroke = mount(true, false, { declineOnSelection: [5, 80, 90, 10] });
    stroke.send('down', event([touch()], [touch()], STYLUS));
    expect(stroke.manager.fail).toHaveBeenCalledTimes(1);
    expect(stroke.manager.activate).not.toHaveBeenCalled();
    expect(stroke.start).not.toHaveBeenCalled();
    expect(stroke.points.value).toEqual([]);
  });

  it('still draws a stylus touch off the selection, and with no selection at all', () => {
    // (80, 60) lands on board (120, 90): 40 px from the selection's centre, radius 10.
    const stroke = mount(true, false, { declineOnSelection: [5, 80, 90, 10] });
    stroke.send('down', event([touch(7, 80, 60)], [touch(7, 80, 60)], STYLUS));
    expect(stroke.manager.activate).toHaveBeenCalledTimes(1);
    stroke.send('up', upEvent([touch(7, 80, 60)], [], STYLUS));
    expect(stroke.end).toHaveBeenCalledExactlyOnceWith([120, 90]);
    stroke.selection!.value = [];
    stroke.send('down', event([touch()], [touch()], STYLUS));
    expect(stroke.manager.activate).toHaveBeenCalledTimes(2);
  });

  it('declines a stylus a fingertip from a ring smaller than a fingertip', () => {
    // The move claims within max(r, 22 pt) at touch-down; at this mount's zoom
    // 22 pt is 22 board px. (55, 60) lands on board (95, 90): r + 5 from a
    // radius-10 ring, inside the fingertip.
    const stroke = mount(true, false, { declineOnSelection: [5, 80, 90, 10] });
    stroke.send('down', event([touch(7, 55, 60)], [touch(7, 55, 60)], STYLUS));
    expect(stroke.manager.fail).toHaveBeenCalledTimes(1);
    expect(stroke.manager.activate).not.toHaveBeenCalled();
    expect(stroke.start).not.toHaveBeenCalled();
  });

  it('draws a stylus on a smaller neighbour inside the selection fingertip, which the move never claims', () => {
    // (55, 60) lands on board (95, 90): inside the radius-10 selection's 22 px
    // fingertip, but ON the radius-4 neighbour at (97, 90). The move's claim
    // (`selectedDragIdAt`) gives that touch to the neighbour, so declining it
    // here would leave a Pencil stroke claimed by nothing.
    const selection = [5, 80, 90, 10];
    const hitHolds = [...selection, 9, 97, 90, 4];
    const fallbackRadius = fallbackRadiusAt(2, 2);
    expect(selectedDragIdAt(hitHolds, selection, 95, 90, fallbackRadius)).toBe(0);
    const stroke = mount(true, false, { declineOnSelection: selection, declineHitHolds: hitHolds });
    stroke.send('down', event([touch(7, 55, 60)], [touch(7, 55, 60)], STYLUS));
    expect(stroke.manager.fail).not.toHaveBeenCalled();
    expect(stroke.manager.activate).toHaveBeenCalledTimes(1);
    stroke.send('up', upEvent([touch(7, 55, 60)], [], STYLUS));
    expect(stroke.end).toHaveBeenCalledExactlyOnceWith([95, 90]);
  });

  it('still declines the selection itself, and its fingertip off any neighbour, with the hit list', () => {
    const selection = [5, 80, 90, 10];
    const hitHolds = [...selection, 9, 97, 90, 4];
    const fallbackRadius = fallbackRadiusAt(2, 2);
    // The default touch lands on board (80, 90), the selection's centre.
    expect(selectedDragIdAt(hitHolds, selection, 80, 90, fallbackRadius)).toBe(5);
    const stroke = mount(true, false, { declineOnSelection: selection, declineHitHolds: hitHolds });
    stroke.send('down', event([touch()], [touch()], STYLUS));
    expect(stroke.manager.fail).toHaveBeenCalledTimes(1);
    // (40, 80) lands on board (80, 110): 10 px off the ring's edge, inside its
    // fingertip and nowhere near the neighbour, so the move claims it.
    expect(selectedDragIdAt(hitHolds, selection, 80, 110, fallbackRadius)).toBe(5);
    stroke.send('down', event([touch(8, 40, 80)], [touch(8, 40, 80)], STYLUS));
    expect(stroke.manager.fail).toHaveBeenCalledTimes(2);
    expect(stroke.start).not.toHaveBeenCalled();
  });

  it('declines on the selection on the Trace pan path too', () => {
    const stroke = mount(false, false, { declineOnSelection: [5, 80, 90, 10] });
    stroke.send('down', event([touch()], [touch()], STYLUS));
    expect(stroke.manager.fail).toHaveBeenCalledTimes(1);
    expect(stroke.manager.activate).not.toHaveBeenCalled();
  });

  it('reports the first stylus once, declined or not, and never a finger', () => {
    const onStylusSeen = vi.fn();
    const stroke = mount(true, false, { declineOnSelection: [5, 80, 90, 10], onStylusSeen });
    stroke.send('down');
    expect(onStylusSeen).not.toHaveBeenCalled();
    stroke.send('down', event([touch()], [touch()], STYLUS));
    expect(onStylusSeen).toHaveBeenCalledTimes(1);
    stroke.send('down', event([touch(7, 80, 60)], [touch(7, 80, 60)], STYLUS));
    stroke.send('up', upEvent([touch(7, 80, 60)], [], STYLUS));
    expect(onStylusSeen).toHaveBeenCalledTimes(1);
  });

  it('leaves a stroke without the opt-ins exactly as it was', () => {
    const stroke = mount(true, true);
    stroke.send('down', event([touch()], [touch()], STYLUS));
    stroke.send('up', upEvent([touch()], [], STYLUS));
    expect(stroke.end).toHaveBeenCalledExactlyOnceWith([80, 90]);
    expect(stroke.manager.fail).not.toHaveBeenCalled();
  });
});
