// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { SharedValue } from 'react-native-reanimated';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handlers = Map<string, (...args: unknown[]) => void>;
const installed = vi.hoisted(() => ({ gestures: [] as { kind: string; handlers: Handlers }[] }));
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
    const handlers: Handlers = new Map();
    installed.gestures.push({ kind, handlers });
    const gesture: Record<string, unknown> = {};
    const chain = () => gesture;
    for (const config of [
      'maxDuration',
      'maxDistance',
      'minDuration',
      'minPointers',
      'manualActivation',
      'simultaneousWithExternalGesture',
    ]) {
      gesture[config] = chain;
    }
    for (const event of [
      'onTouchesDown',
      'onTouchesMove',
      'onTouchesUp',
      'onBegin',
      'onStart',
      'onUpdate',
      'onEnd',
      'onFinalize',
    ]) {
      gesture[event] = (callback: (...args: unknown[]) => void) => {
        handlers.set(event, callback);
        return gesture;
      };
    }
    return gesture;
  };
  return {
    Gesture: {
      Tap: () => builder('tap'),
      LongPress: () => builder('longPress'),
      Pan: () => builder('pan'),
      Hover: () => builder('hover'),
      Race: (...members: unknown[]) => ({ race: members }),
      Simultaneous: (...members: unknown[]) => ({ simultaneous: members }),
    },
    GestureDetector: ({ children }: { children: ReactNode }) => children,
    PointerType: { TOUCH: 0, STYLUS: 1, MOUSE: 2 },
  };
});
import { SprayEditGestureOverlay } from '../SprayEditGestureOverlay';

const FINGER = 0;
const STYLUS = 1;
const MOUSE = 2;

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

type Options = { hover?: boolean; onStylusSeen?: () => void; onTwoFingerTap?: () => void };

// An unzoomed 100 x 100 board drawn at one board px per point: screen and
// board coordinates are the same, so the rows below read directly.
function mount(options: Options = {}) {
  const onTap = vi.fn();
  const hoverSV = options.hover ? shared<number[]>([]) : undefined;
  render(
    <SprayEditGestureOverlay
      scaleSV={shared(1)}
      translateXSV={shared(0)}
      translateYSV={shared(0)}
      containerWidthSV={shared(100)}
      containerHeightSV={shared(100)}
      isPinchingSV={shared(false)}
      pinchRef={{ current: undefined }}
      boardScale={1}
      hitHoldsSV={shared([3, 30, 30, 5])}
      selectedHoldSV={shared<number[]>([])}
      dragOffsetXSV={shared(0)}
      dragOffsetYSV={shared(0)}
      dragHoldIdSV={shared(0)}
      canMove
      canAdd
      medianRadiusSV={shared(12)}
      placeHoldSV={shared<number[]>([])}
      accessibility={{ label: '', value: '', hint: '', actions: [], onAction: vi.fn() }}
      onTap={onTap}
      onPickUp={vi.fn()}
      onMoveEnd={vi.fn()}
      onPlaceStart={vi.fn()}
      onPlace={vi.fn()}
      hoverSV={hoverSV}
      hoverRadiusSV={options.hover ? shared(12) : undefined}
      onStylusSeen={options.onStylusSeen}
      onTwoFingerTap={options.onTwoFingerTap}
    />,
  );
  const of = (kind: string, index = 0) => installed.gestures.filter((gesture) => gesture.kind === kind)[index];
  const fire = (kind: string, event: string, ...args: unknown[]) => of(kind)?.handlers.get(event)?.(...args);
  return { onTap, hoverSV, of, fire };
}

beforeEach(() => {
  installed.gestures = [];
});

describe('SprayEditGestureOverlay stylus taps', () => {
  it('says whether a tap was the Pencil', () => {
    const overlay = mount();
    overlay.fire('tap', 'onStart', { x: 30, y: 30, pointerType: STYLUS });
    overlay.fire('tap', 'onStart', { x: 60, y: 60, pointerType: FINGER });
    expect(overlay.onTap).toHaveBeenNthCalledWith(1, 30, 30, 1, true);
    expect(overlay.onTap).toHaveBeenNthCalledWith(2, 60, 60, 1, false);
  });

  it('reports a quick Pencil touch on the selected ring as a Pencil tap', () => {
    const onTap = vi.fn();
    const selected = shared([3, 30, 30, 5]);
    installed.gestures = [];
    render(
      <SprayEditGestureOverlay
        scaleSV={shared(1)}
        translateXSV={shared(0)}
        translateYSV={shared(0)}
        containerWidthSV={shared(100)}
        containerHeightSV={shared(100)}
        isPinchingSV={shared(false)}
        pinchRef={{ current: undefined }}
        boardScale={1}
        hitHoldsSV={shared([3, 30, 30, 5])}
        selectedHoldSV={selected}
        dragOffsetXSV={shared(0)}
        dragOffsetYSV={shared(0)}
        dragHoldIdSV={shared(0)}
        canMove
        canAdd
        medianRadiusSV={shared(12)}
        placeHoldSV={shared<number[]>([])}
        accessibility={{ label: '', value: '', hint: '', actions: [], onAction: vi.fn() }}
        onTap={onTap}
        onPickUp={vi.fn()}
        onMoveEnd={vi.fn()}
        onPlaceStart={vi.fn()}
        onPlace={vi.fn()}
      />,
    );
    const drag = installed.gestures.find((gesture) => gesture.kind === 'pan')!;
    const manager = { activate: vi.fn(), fail: vi.fn(), end: vi.fn() };
    drag.handlers.get('onTouchesDown')?.(
      { numberOfTouches: 1, allTouches: [{ x: 30, y: 30 }], pointerType: STYLUS },
      manager,
    );
    expect(manager.activate).toHaveBeenCalledTimes(1);
    drag.handlers.get('onEnd')?.({ translationX: 0, translationY: 0 });
    expect(onTap).toHaveBeenCalledExactlyOnceWith(30, 30, 1, true);
  });
});

describe('SprayEditGestureOverlay Pencil hover', () => {
  it('is not built at all without the opt-in', () => {
    const overlay = mount();
    expect(overlay.of('hover')).toBeUndefined();
  });

  it('writes the ring under a hovering Pencil, and a ghost of the tap size on bare wall', () => {
    const overlay = mount({ hover: true });
    overlay.fire('hover', 'onUpdate', { x: 31, y: 29, pointerType: STYLUS });
    expect(overlay.hoverSV!.value).toEqual([3, 30, 30, 5]);
    overlay.fire('hover', 'onUpdate', { x: 80, y: 70, pointerType: STYLUS });
    expect(overlay.hoverSV!.value).toEqual([0, 80, 70, 12]);
    overlay.fire('hover', 'onFinalize', {});
    expect(overlay.hoverSV!.value).toEqual([]);
  });

  it('ignores a mouse or trackpad pointer', () => {
    const overlay = mount({ hover: true });
    overlay.fire('hover', 'onUpdate', { x: 80, y: 70, pointerType: STYLUS });
    overlay.fire('hover', 'onUpdate', { x: 30, y: 30, pointerType: MOUSE });
    expect(overlay.hoverSV!.value).toEqual([]);
  });

  it('reports the first Pencil hover once, and never a mouse', () => {
    const onStylusSeen = vi.fn();
    const overlay = mount({ hover: true, onStylusSeen });
    overlay.fire('hover', 'onBegin', { pointerType: MOUSE });
    expect(onStylusSeen).not.toHaveBeenCalled();
    overlay.fire('hover', 'onBegin', { pointerType: STYLUS });
    overlay.fire('hover', 'onBegin', { pointerType: STYLUS });
    expect(onStylusSeen).toHaveBeenCalledTimes(1);
  });
});

describe('SprayEditGestureOverlay two-finger tap', () => {
  it('fires on a successful two-finger tap only', () => {
    const onTwoFingerTap = vi.fn();
    const overlay = mount({ onTwoFingerTap });
    const twoFinger = overlay.of('tap', 1);
    twoFinger.handlers.get('onEnd')?.({}, false);
    expect(onTwoFingerTap).not.toHaveBeenCalled();
    twoFinger.handlers.get('onEnd')?.({}, true);
    expect(onTwoFingerTap).toHaveBeenCalledTimes(1);
  });

  it('is not built without the opt-in', () => {
    const overlay = mount();
    expect(overlay.of('tap', 1)).toBeUndefined();
  });
});
