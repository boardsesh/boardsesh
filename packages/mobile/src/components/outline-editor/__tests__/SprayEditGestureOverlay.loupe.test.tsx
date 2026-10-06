// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { SharedValue } from 'react-native-reanimated';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Each gesture the overlay builds, by kind, with the callbacks it registered. */
const installed = vi.hoisted(() => ({ gestures: new Map<string, Map<string, unknown>>() }));
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
    const callbacks = new Map<string, unknown>();
    installed.gestures.set(kind, callbacks);
    const chain = () => gesture;
    const register = (name: string) => (callback: unknown) => {
      callbacks.set(name, callback);
      return gesture;
    };
    const gesture = {
      maxDuration: chain,
      maxDistance: chain,
      minDuration: chain,
      manualActivation: chain,
      simultaneousWithExternalGesture: chain,
      onTouchesDown: register('down'),
      onTouchesMove: register('move'),
      onTouchesUp: register('up'),
      onStart: register('start'),
      onUpdate: register('update'),
      onEnd: register('end'),
      onFinalize: register('finalize'),
    };
    return gesture;
  };
  return {
    Gesture: {
      Tap: () => builder('tap'),
      LongPress: () => builder('longPress'),
      Pan: () => builder('drag'),
      Race: () => ({}),
      Simultaneous: () => ({}),
    },
    GestureDetector: ({ children }: { children: ReactNode }) => children,
    PointerType: { TOUCH: 0, STYLUS: 1 },
  };
});
import { SprayEditGestureOverlay, type SprayWallAccessibility } from '../SprayEditGestureOverlay';
import type { SprayLoupeFeed } from '../spray-loupe-feed';

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

const ACCESSIBILITY: SprayWallAccessibility = { label: '', value: '', hint: '', actions: [], onAction: () => {} };
/**
 * One hold, id 5, at board (100, 100) with radius 20. At zoom 1 and board scale 1, screen = board.
 * A selection is always passed as a copy: the hit test tells the live selection from the
 * list by identity, as the screen's two separate arrays do.
 */
const HOLD = [5, 100, 100, 20];

function touchEvent(x: number, y: number, touches = 1, pointerType = 0) {
  const points = Array.from({ length: touches }, (_unused, index) => ({ id: index, x: x + index * 50, y }));
  return { numberOfTouches: touches, allTouches: points, changedTouches: points.slice(-1), pointerType };
}

function mount(selected: number[] = []) {
  const loupe: SprayLoupeFeed = {
    touchDownAtSV: shared(0),
    xSV: shared(0),
    ySV: shared(0),
    renderXSV: shared(0),
    renderYSV: shared(0),
    zoomSV: shared(1),
  };
  const manager = { activate: vi.fn(), fail: vi.fn(), end: vi.fn() };
  const onPlaceStart = vi.fn();
  const { unmount } = render(
    <SprayEditGestureOverlay
      scaleSV={shared(1)}
      translateXSV={shared(0)}
      translateYSV={shared(0)}
      containerWidthSV={shared(400)}
      containerHeightSV={shared(400)}
      isPinchingSV={shared(false)}
      pinchRef={{ current: undefined }}
      boardScale={1}
      hitHoldsSV={shared(HOLD)}
      selectedHoldSV={shared(selected)}
      dragOffsetXSV={shared(0)}
      dragOffsetYSV={shared(0)}
      dragHoldIdSV={shared(0)}
      canMove
      canAdd
      medianRadiusSV={shared(20)}
      placeHoldSV={shared<number[]>([])}
      loupe={loupe}
      accessibility={ACCESSIBILITY}
      onTap={vi.fn()}
      onPickUp={vi.fn()}
      onMoveEnd={vi.fn()}
      onPlaceStart={onPlaceStart}
      onPlace={vi.fn()}
    />,
  );
  function send(kind: string, name: string, payload: unknown = {}) {
    const callback = installed.gestures.get(kind)?.get(name) as
      | ((payload: unknown, managerState: typeof manager) => void)
      | undefined;
    callback?.(payload, manager);
  }
  /** One touch-down, delivered to both gestures that see it, in the order RNGH happens to use. */
  function down(x: number, y: number, pointerType = 0) {
    send('longPress', 'down', touchEvent(x, y, 1, pointerType));
    send('drag', 'down', touchEvent(x, y, 1, pointerType));
  }
  return { loupe, manager, send, down, onPlaceStart, unmount };
}

beforeEach(() => installed.gestures.clear());

describe('SprayEditGestureOverlay feeds the loupe', () => {
  it('arms it at touch-down on the selected ring, so a move shows it once the delay is up', () => {
    const overlay = mount([...HOLD]);
    overlay.down(105, 100);
    expect(overlay.manager.activate).toHaveBeenCalled();
    expect(overlay.loupe.touchDownAtSV.value).toBeGreaterThan(0);
    expect([overlay.loupe.xSV.value, overlay.loupe.ySV.value]).toEqual([105, 100]);
    overlay.send('drag', 'move', touchEvent(130, 110));
    expect([overlay.loupe.renderXSV.value, overlay.loupe.renderYSV.value]).toEqual([130, 110]);
    overlay.send('drag', 'finalize');
    expect(overlay.loupe.touchDownAtSV.value).toBe(0);
  });

  it('does not arm it for a touch on bare wall that has not been held', () => {
    const overlay = mount([...HOLD]);
    overlay.down(300, 300);
    overlay.send('drag', 'move', touchEvent(303, 300));
    expect(overlay.loupe.touchDownAtSV.value).toBe(0);
  });

  it('shows it for a press and hold that places a hold, and follows the slide', () => {
    const overlay = mount();
    overlay.down(300, 300);
    overlay.send('longPress', 'start', { x: 300, y: 300 });
    expect(overlay.onPlaceStart).toHaveBeenCalledTimes(1);
    expect(overlay.loupe.touchDownAtSV.value).toBeGreaterThan(0);
    overlay.send('drag', 'move', touchEvent(320, 300));
    expect(overlay.loupe.xSV.value).toBe(320);
    overlay.send('drag', 'finalize');
    expect(overlay.loupe.touchDownAtSV.value).toBe(0);
  });

  it('shows it for a pick-up of a ring', () => {
    const overlay = mount();
    overlay.down(100, 100);
    overlay.send('longPress', 'start', { x: 100, y: 100 });
    expect(overlay.loupe.touchDownAtSV.value).toBeGreaterThan(0);
  });

  it('lets go the moment a second finger lands mid-drag', () => {
    const overlay = mount([...HOLD]);
    overlay.down(100, 100);
    overlay.send('drag', 'down', touchEvent(100, 100, 2));
    expect(overlay.loupe.touchDownAtSV.value).toBe(0);
  });

  it('never feeds it for a stylus', () => {
    const overlay = mount([...HOLD]);
    overlay.down(100, 100, 1);
    overlay.send('longPress', 'start', { x: 100, y: 100 });
    overlay.send('drag', 'move', touchEvent(120, 100, 1, 1));
    expect(overlay.loupe.touchDownAtSV.value).toBe(0);
  });

  // The Pencil adds by tapping or drawing on its own surface (iPad), so a
  // Pencil resting on bare wall must never drop a median circle as well.
  it('never places a hold for a Pencil resting on bare wall', () => {
    const overlay = mount();
    overlay.down(300, 300, 1);
    expect(overlay.manager.fail).toHaveBeenCalled();
    overlay.send('longPress', 'start', { x: 300, y: 300 });
    expect(overlay.onPlaceStart).not.toHaveBeenCalled();
    expect(overlay.loupe.touchDownAtSV.value).toBe(0);
  });

  it('still picks up a ring under a Pencil, since that is a move and not an add', () => {
    const overlay = mount();
    overlay.send('longPress', 'down', touchEvent(100, 100, 1, 1));
    expect(overlay.manager.fail).not.toHaveBeenCalled();
  });

  it('lets go if the overlay unmounts mid-drag, which never finalizes the touch', () => {
    const overlay = mount([...HOLD]);
    overlay.down(105, 100);
    expect(overlay.loupe.touchDownAtSV.value).toBeGreaterThan(0);
    overlay.unmount();
    expect(overlay.loupe.touchDownAtSV.value).toBe(0);
  });

  it('leaves a loupe another overlay is feeding when it unmounts', () => {
    const overlay = mount([...HOLD]);
    overlay.loupe.touchDownAtSV.value = 12345;
    overlay.unmount();
    expect(overlay.loupe.touchDownAtSV.value).toBe(12345);
  });
});
