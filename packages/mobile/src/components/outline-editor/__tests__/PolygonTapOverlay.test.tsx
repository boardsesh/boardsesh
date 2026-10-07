// @vitest-environment jsdom
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
      simultaneousWithExternalGesture: () => gesture,
      onTouchesDown: (callback: unknown) => register('down', callback),
      onTouchesMove: (callback: unknown) => register('move', callback),
      onTouchesUp: (callback: unknown) => register('up', callback),
      onTouchesCancelled: (callback: unknown) => register('cancel', callback),
      onFinalize: (callback: unknown) => register('finalize', callback),
    };
    function register(name: string, callback: unknown) {
      installed.callbacks.set(name, callback);
      return gesture;
    }
    return gesture;
  };
  return {
    Gesture: { Manual: () => builder('manual') },
    GestureDetector: ({ children }: { children: ReactNode }) => children,
    PointerType: { TOUCH: 0, STYLUS: 1 },
  };
});
import { PolygonTapOverlay } from '../PolygonTapOverlay';
import type { SprayLoupeFeed } from '../spray-loupe-feed';

const touch = (id = 7, x = 40, y = 60) => ({ id, x, y, absoluteX: x, absoluteY: y });
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
function upEvent(changedTouches = [touch()], remainingTouches: ReturnType<typeof touch>[] = []): GestureTouchEvent {
  return {
    ...event(changedTouches, [...remainingTouches, ...changedTouches]),
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
function mount(initialVertices: number[] = [], maxVertices = 24, stylusOnly?: boolean) {
  const vertices = shared<number[]>(initialVertices);
  const loupe: SprayLoupeFeed = {
    touchDownAtSV: shared(0),
    xSV: shared(0),
    ySV: shared(0),
    renderXSV: shared(0),
    renderYSV: shared(0),
    zoomSV: shared(1),
  };
  const added = vi.fn();
  const limit = vi.fn();
  const close = vi.fn();
  const manager = { begin: vi.fn(), activate: vi.fn(), end: vi.fn(), fail: vi.fn() };
  render(
    <PolygonTapOverlay
      verticesSV={vertices}
      scaleSV={shared(2)}
      translateXSV={shared(10)}
      translateYSV={shared(20)}
      containerWidthSV={shared(100)}
      containerHeightSV={shared(100)}
      boardScale={2}
      pinchRef={{ current: undefined }}
      maxVertices={maxVertices}
      onVertexAdded={added}
      onVertexLimit={limit}
      onClose={close}
      loupe={loupe}
      stylusOnlySV={stylusOnly === undefined ? undefined : shared(stylusOnly)}
    />,
  );
  function send(name: string, payload: unknown = event()) {
    const callback = installed.callbacks.get(name) as
      | ((payload: unknown, managerState: typeof manager) => void)
      | undefined;
    callback?.(payload, manager);
  }
  return { vertices, loupe, added, limit, close, manager, send };
}

beforeEach(() => installed.callbacks.clear());

describe('Corners: touch, slide, lift', () => {
  it('claims the touch at touch-down, so a slide positions the corner instead of panning', () => {
    const corners = mount();
    expect(installed.kind).toBe('manual');
    corners.send('down');
    expect(corners.manager.begin).toHaveBeenCalledTimes(1);
    expect(corners.manager.activate).toHaveBeenCalledTimes(1);
    expect(corners.added).not.toHaveBeenCalled();
  });

  it('places the corner where the finger lifts, through the live zoom transform', () => {
    const corners = mount();
    corners.send('down');
    corners.send('move', event([touch(7, 44, 60)]));
    corners.send('up', upEvent([touch(7, 48, 60)]));
    // (48, 60) on screen → render ((48 − 10 − 50) / 2 + 50, (60 − 20 − 50) / 2 + 50) → ×2 board px.
    expect(corners.vertices.value).toEqual([88, 90]);
    expect(corners.added).toHaveBeenCalledTimes(1);
    expect(corners.manager.end).toHaveBeenCalledTimes(1);
  });

  it('still drops a corner for a quick still tap', () => {
    const corners = mount();
    corners.send('down');
    corners.send('up', upEvent());
    expect(corners.vertices.value).toEqual([80, 90]);
  });

  it('closes on a lift over the first corner, emptying the corners before JS hears', () => {
    const square = [80, 90, 180, 90, 180, 190];
    const corners = mount(square);
    corners.send('down', event([touch(7, 60, 60)]));
    // Slid back onto the first corner (80, 90 board px is screen 40, 60).
    corners.send('up', upEvent([touch(7, 40, 60)]));
    expect(corners.close).toHaveBeenCalledExactlyOnceWith(square);
    expect(corners.vertices.value).toEqual([]);
    expect(corners.added).not.toHaveBeenCalled();
  });

  it('refuses a corner past the cap', () => {
    const corners = mount([0, 0, 400, 0], 2);
    corners.send('down');
    corners.send('up', upEvent());
    expect(corners.limit).toHaveBeenCalledTimes(1);
    expect(corners.vertices.value).toEqual([0, 0, 400, 0]);
  });

  it('drops the corner when a second finger lands: that is a pinch', () => {
    const corners = mount();
    corners.manager.fail.mockImplementation(() => corners.send('finalize'));
    corners.send('down');
    corners.send('down', event([touch(8)], [touch(), touch(8)]));
    corners.send('up', upEvent([touch()], [touch(8)]));
    expect(corners.manager.fail).toHaveBeenCalledTimes(1);
    expect(corners.vertices.value).toEqual([]);
    expect(corners.added).not.toHaveBeenCalled();
    expect(corners.loupe.touchDownAtSV.value).toBe(0);
  });

  it('declines two fingers landing together', () => {
    const corners = mount();
    corners.send('down', event([touch(), touch(8)]));
    expect(corners.manager.fail).toHaveBeenCalledTimes(1);
    expect(corners.manager.activate).not.toHaveBeenCalled();
  });

  it('ignores the lift of a pointer it does not own', () => {
    const corners = mount();
    corners.send('down');
    corners.send('up', upEvent([touch(8)], [touch()]));
    expect(corners.added).not.toHaveBeenCalled();
    corners.send('up', upEvent());
    expect(corners.added).toHaveBeenCalledTimes(1);
  });

  it('places nothing when the system cancels the touch', () => {
    const corners = mount();
    corners.send('down');
    corners.send('cancel', event([touch()], []));
    corners.send('up', upEvent());
    expect(corners.vertices.value).toEqual([]);
    expect(corners.manager.fail).toHaveBeenCalledTimes(1);
  });
});

describe('Corners: the loupe', () => {
  it('follows a finger from touch-down and lets go on the lift', () => {
    const corners = mount();
    corners.send('down');
    expect(corners.loupe.touchDownAtSV.value).toBeGreaterThan(0);
    corners.send('move', event([touch(7, 44, 66)]));
    expect([corners.loupe.xSV.value, corners.loupe.ySV.value]).toEqual([44, 66]);
    expect([corners.loupe.renderXSV.value, corners.loupe.renderYSV.value]).toEqual([42, 48]);
    corners.send('up', upEvent([touch(7, 44, 66)]));
    expect(corners.loupe.touchDownAtSV.value).toBe(0);
  });

  it('is never fed for a stylus', () => {
    const corners = mount();
    corners.send('down', event([touch()], [touch()], 1));
    expect(corners.loupe.touchDownAtSV.value).toBe(0);
    corners.send('up', upEvent());
    expect(corners.vertices.value).toEqual([80, 90]);
  });
});

const FINGER = 0;
const STYLUS = 1;

describe('Corners: Pencil only (stylusOnlySV)', () => {
  it('fails a finger at touch-down while Pencil only is on, so it pans instead', () => {
    const corners = mount([], 24, true);
    corners.send('down', event([touch()], [touch()], FINGER));
    expect(corners.manager.fail).toHaveBeenCalledTimes(1);
    expect(corners.manager.activate).not.toHaveBeenCalled();
    // A finger turned away never feeds the loupe either.
    expect(corners.loupe.touchDownAtSV.value).toBe(0);
  });

  it('lets the Pencil touch, slide and lift a corner while Pencil only is on', () => {
    const corners = mount([], 24, true);
    corners.send('down', event([touch()], [touch()], STYLUS));
    expect(corners.manager.fail).not.toHaveBeenCalled();
    corners.send('up', upEvent());
    expect(corners.vertices.value).toEqual([80, 90]);
    expect(corners.added).toHaveBeenCalledTimes(1);
  });

  it('takes any one finger when off or omitted, and never two', () => {
    for (const stylusOnly of [false, undefined]) {
      installed.callbacks.clear();
      const corners = mount([], 24, stylusOnly);
      corners.send('down', event([touch()], [touch()], FINGER));
      expect(corners.manager.fail).not.toHaveBeenCalled();
      expect(corners.manager.activate).toHaveBeenCalledTimes(1);
      corners.send('up', upEvent());
      corners.send('down', event([touch(), touch(8)]));
      expect(corners.manager.fail).toHaveBeenCalledTimes(1);
    }
  });
});
