// @vitest-environment jsdom
import { createElement, type ComponentProps, type ReactNode } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Quad } from '@boardsesh/spray-wall-geometry';
import type { SprayLookPreviewSource } from '../../../lib/spray/spray-look-preview';

type Event = {
  translationX: number;
  translationY: number;
  focalX: number;
  focalY: number;
  scale: number;
  numberOfTouches: number;
  numberOfPointers: number;
  changedTouches: { x: number; y: number }[];
  x: number;
  y: number;
};
type Manager = { activate: () => void; fail: () => void };
type GestureRecord = {
  kind: 'pan' | 'pinch' | 'tap';
  handlers: Record<string, (event: Event, manager: Manager) => void>;
  options: Record<string, unknown[]>;
};
type Shape = { d?: string; cx?: number; cy?: number; strokeDasharray?: number[] };
const runtime = vi.hoisted(() => ({
  gestures: [] as GestureRecord[],
  shapes: [] as { compute: () => Shape }[],
  styles: [] as { compute: () => Record<string, unknown> }[],
  bridges: 0,
}));
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
}));
vi.mock('expo-image', () => ({ Image: () => createElement('img') }));
const photoRenderer = vi.hoisted(() => vi.fn());
vi.mock('../FlattenedSprayPhoto', () => ({
  FlattenedSprayPhoto: (props: unknown) => {
    photoRenderer(props);
    return createElement('div', { 'data-testid': 'rectified-photo' });
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../theme/colors', () => ({ brandColorsDark: { tint: '#A78BFA', error: '#F87171' } }));
vi.mock('react-native-svg', () => ({
  default: ({ children }: { children?: ReactNode }) => createElement('svg', null, children),
  Path: () => createElement('path'),
  Circle: () => createElement('circle'),
}));
vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  return {
    default: {
      View: ({ children, accessibilityLabel }: { children?: ReactNode; accessibilityLabel?: string }) =>
        createElement(
          'div',
          { role: accessibilityLabel ? 'slider' : undefined, 'aria-label': accessibilityLabel },
          children,
        ),
      createAnimatedComponent: (component: unknown) => component,
    },
    useSharedValue: (initial: unknown) => {
      const state = useRef({
        value: initial,
        modify: (fn: (value: unknown) => unknown) => {
          state.current.value = fn(state.current.value);
        },
      });
      return state.current;
    },
    useAnimatedStyle: (compute: () => Record<string, unknown>) => {
      const entry = useRef<{ compute: () => Record<string, unknown> } | null>(null);
      if (!entry.current) {
        entry.current = { compute };
        runtime.styles.push(entry.current);
      }
      entry.current.compute = compute;
      return {};
    },
    useAnimatedProps: (compute: () => Shape) => {
      const entry = useRef<{ compute: () => Shape } | null>(null);
      if (!entry.current) {
        entry.current = { compute };
        runtime.shapes.push(entry.current);
      }
      entry.current.compute = compute;
      return {};
    },
    runOnJS:
      (callback: (...args: unknown[]) => void) =>
      (...args: unknown[]) => {
        runtime.bridges++;
        callback(...args);
      },
  };
});
vi.mock('react-native-gesture-handler', () => {
  const create = (kind: 'pan' | 'pinch' | 'tap') => {
    const record: GestureRecord = { kind, handlers: {}, options: {} };
    runtime.gestures.push(record);
    const builder: Record<string, (...args: unknown[]) => unknown> = {};
    for (const name of [
      'onBegin',
      'onStart',
      'onUpdate',
      'onEnd',
      'onFinalize',
      'onTouchesMove',
      'onTouchesDown',
      'onTouchesUp',
      'onTouchesCancelled',
    ]) {
      builder[name] = (callback) => {
        record.handlers[name] = callback as (event: Event, manager: Manager) => void;
        return builder;
      };
    }
    for (const name of [
      'withRef',
      'maxPointers',
      'minDistance',
      'manualActivation',
      'simultaneousWithExternalGesture',
      'requireExternalGestureToFail',
      'enabled',
    ]) {
      builder[name] = (...args) => {
        record.options[name] = args;
        return builder;
      };
    }
    return builder;
  };
  return {
    GestureDetector: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    Gesture: {
      Pan: () => create('pan'),
      Pinch: () => create('pinch'),
      Tap: () => create('tap'),
      Simultaneous: (...gestures: unknown[]) => gestures,
      Exclusive: (...gestures: unknown[]) => gestures,
    },
  };
});

import { ZoomableTnutMarker } from '../ZoomableTnutMarker';
import { SprayPhotoCanvas, type SprayPhotoCanvasProps } from '../SprayPhotoCanvas';

const quad: Quad = [
  [300, 450],
  [700, 450],
  [700, 1050],
  [300, 1050],
];
function props(
  overrides: Partial<ComponentProps<typeof ZoomableTnutMarker>> = {},
): ComponentProps<typeof ZoomableTnutMarker> {
  return {
    photo: { uri: 'file:///wall.jpg', width: 1000, height: 1500 },
    value: quad,
    onChange: vi.fn(),
    renderWidth: 300,
    renderHeight: 450,
    maxWidth: 300,
    maxHeight: 450,
    edgeToEdge: true,
    tnutGrid: { pattern: 'grid', rows: 8, columns: 8, firstRowOffset: false },
    ...overrides,
  };
}
const event = (overrides: Partial<Event> = {}): Event => ({
  translationX: 0,
  translationY: 0,
  focalX: 150,
  focalY: 225,
  scale: 1,
  numberOfTouches: 1,
  numberOfPointers: 1,
  changedTouches: [{ x: 150, y: 225 }],
  x: 150,
  y: 225,
  ...overrides,
});
const manager = () => ({ activate: vi.fn(), fail: vi.fn() });
function fire(gesture: GestureRecord, name: string, overrides: Partial<Event> = {}, state = manager()) {
  act(() =>
    gesture.handlers[name]?.(event({ numberOfPointers: gesture.kind === 'pinch' ? 2 : 1, ...overrides }), state),
  );
  return state;
}
function pinchTo(scale: number) {
  const pinch = runtime.gestures.find((gesture) => gesture.kind === 'pinch');
  if (!pinch) throw new Error('No pinch');
  fire(pinch, 'onStart');
  fire(pinch, 'onUpdate', { scale });
  fire(pinch, 'onFinalize');
}
function end(gesture: GestureRecord, overrides: Partial<Event> = {}, success = true) {
  const callback = gesture.handlers.onEnd as unknown as (event: Event, success: boolean) => void;
  act(() => callback(event(overrides), success));
}
afterEach(() => {
  cleanup();
  runtime.gestures.length = 0;
  runtime.shapes.length = 0;
  runtime.styles.length = 0;
  runtime.bridges = 0;
  photoRenderer.mockClear();
});

const source: SprayLookPreviewSource = {
  layoutId: 1,
  versionId: 2,
  photoUrl: 'https://example.invalid/wall.jpg',
  photoExpiresAt: '2030-01-01',
  photo: { width: 2000, height: 3000 },
  homography: [0.5, 0, 0, 0, 0.5, 0, 0, 0, 1],
  frame: { width: 1000, height: 1500 },
  holds: [],
};
function canvasProps(overrides: Partial<SprayPhotoCanvasProps> = {}): SprayPhotoCanvasProps {
  return { source, photoUri: 'file:///cached-wall.jpg', maxWidth: 300, maxHeight: 450, ...overrides };
}

describe('SprayPhotoCanvas', () => {
  it('fits the canonical frame and shares the cached rectified backdrop with overlays', () => {
    const renderOverlay = vi.fn<NonNullable<SprayPhotoCanvasProps['renderOverlay']>>(() => createElement('div'));
    render(createElement(SprayPhotoCanvas, canvasProps({ renderOverlay })));
    expect(photoRenderer).toHaveBeenLastCalledWith({
      source,
      photoUri: 'file:///cached-wall.jpg',
      tile: { width: 300, height: 450 },
    });
    expect(renderOverlay).toHaveBeenCalledWith(
      300,
      450,
      expect.objectContaining({ value: 1 }),
      expect.objectContaining({ value: 0 }),
      expect.objectContaining({ value: 0 }),
    );
    pinchTo(2);
    expect(renderOverlay.mock.calls[0][2].value).toBe(2);
  });

  it('inverts zoom and pan for taps and keeps screen-distance hit tolerance', () => {
    const onTap = vi.fn();
    render(createElement(SprayPhotoCanvas, canvasProps({ mode: 'tap', onTap })));
    pinchTo(2);
    const pan = runtime.gestures[1];
    fire(pan, 'onStart');
    fire(pan, 'onUpdate', { translationX: 60, translationY: 90 });
    fire(pan, 'onFinalize');
    const tap = runtime.gestures.find((gesture) => gesture.kind === 'tap')!;
    expect(onTap).not.toHaveBeenCalled();
    end(tap, { x: 150, y: 225 });
    expect(onTap).toHaveBeenCalledExactlyOnceWith({ x: 0.4, y: 0.4 }, 600, 900);
  });

  it('collects a normalized trace on the UI thread and commits only once at release', () => {
    const onTrace = vi.fn();
    const lock = vi.fn();
    render(createElement(SprayPhotoCanvas, canvasProps({ mode: 'draw', onTrace, onInteractionChange: lock })));
    pinchTo(2);
    const pan = runtime.gestures[1];
    expect(pan.options.requireExternalGestureToFail).toHaveLength(1);
    const draw = runtime.gestures.find((gesture) => gesture.options.enabled?.[0] === true)!;
    fire(draw, 'onStart', { x: 90, y: 135 });
    const bridges = runtime.bridges;
    fire(draw, 'onUpdate', { x: 210, y: 315 });
    expect(runtime.bridges).toBe(bridges);
    expect(onTrace).not.toHaveBeenCalled();
    end(draw, { x: 270, y: 405 });
    expect(onTrace).toHaveBeenCalledExactlyOnceWith(
      [
        { x: 0.4, y: 0.4 },
        { x: 0.6, y: 0.6 },
        { x: 0.7, y: 0.7 },
      ],
      14 / 900,
    );
    fire(draw, 'onFinalize');
    expect(lock).toHaveBeenLastCalledWith(false);
  });

  it('does not add a hole when a pinch finishes before the tap callback', () => {
    const onTap = vi.fn();
    render(createElement(SprayPhotoCanvas, canvasProps({ mode: 'tap', onTap })));
    const tap = runtime.gestures.find((gesture) => gesture.kind === 'tap')!;
    fire(tap, 'onBegin');
    fire(tap, 'onTouchesDown', { numberOfTouches: 2 });
    pinchTo(2);
    end(tap);
    expect(onTap).not.toHaveBeenCalled();
    fire(tap, 'onBegin');
    fire(tap, 'onTouchesDown', { numberOfTouches: 1 });
    end(tap);
    expect(onTap).toHaveBeenCalledExactlyOnceWith({ x: 0.5, y: 0.5 }, 600, 900);
  });

  it('moves a marker in normalized coordinates after zoom and pan, committing only at release', () => {
    const onMove = vi.fn();
    render(
      createElement(
        SprayPhotoCanvas,
        canvasProps({ mode: 'move', onMove, dragPoints: [{ x: 0.4, y: 0.4 }], draftColor: '#0891B2' }),
      ),
    );
    pinchTo(2);
    const pan = runtime.gestures[1];
    fire(pan, 'onStart');
    fire(pan, 'onUpdate', { translationX: 60, translationY: 90 });
    fire(pan, 'onFinalize');
    const move = runtime.gestures.find((gesture) => gesture.options.enabled?.[0] === true)!;
    expect(fire(move, 'onTouchesDown', { changedTouches: [{ x: 150, y: 225 }] }).fail).not.toHaveBeenCalled();
    fire(move, 'onStart', { x: 156, y: 231 });
    const bridges = runtime.bridges;
    fire(move, 'onUpdate', { x: 270, y: 405 });
    expect(runtime.bridges).toBe(bridges);
    expect(onMove).not.toHaveBeenCalled();
    expect(runtime.shapes[0].compute().d).toBe('M264 405a6 6 0 1 0 12 0a6 6 0 1 0 -12 0');
    end(move, { x: 270, y: 405 });
    expect(onMove).toHaveBeenCalledExactlyOnceWith({ x: 0.4, y: 0.4 }, { x: 0.6, y: 0.6 }, 600, 900);
    fire(move, 'onFinalize');
    expect(runtime.shapes[0].compute().d).toBe('');
  });

  it.each(['move', 'draw'] as const)('gives empty-space %s drags to the photo pan', (mode) => {
    const onMove = vi.fn(),
      onTrace = vi.fn();
    render(createElement(SprayPhotoCanvas, canvasProps({ mode, onMove, onTrace, dragPoints: [{ x: 0.5, y: 0.5 }] })));
    pinchTo(2);
    const pan = runtime.gestures[1];
    const edit = runtime.gestures.find((gesture) => gesture.options.enabled?.[0] === true)!;
    expect(pan.options.requireExternalGestureToFail).toEqual(edit.options.withRef);
    expect(fire(edit, 'onTouchesDown', { changedTouches: [{ x: 30, y: 45 }] }).fail).toHaveBeenCalledOnce();
    fire(edit, 'onFinalize');
    expect(fire(pan, 'onTouchesMove').activate).toHaveBeenCalledOnce();
    fire(pan, 'onStart');
    fire(pan, 'onUpdate', { translationX: 10, translationY: 15 });
    fire(pan, 'onFinalize');
    expect(runtime.styles[0].compute()).toEqual({ transform: [{ translateX: 10 }, { translateY: 15 }, { scale: 2 }] });
    expect(onMove).not.toHaveBeenCalled();
    expect(onTrace).not.toHaveBeenCalled();
  });

  it('cancels a cable trace interrupted by pinching and balances overlapping scroll locks', () => {
    const onTrace = vi.fn();
    const lock = vi.fn();
    render(createElement(SprayPhotoCanvas, canvasProps({ mode: 'draw', onTrace, onInteractionChange: lock })));
    const pinch = runtime.gestures[0];
    const draw = runtime.gestures.find((gesture) => gesture.options.enabled?.[0] === true)!;
    fire(draw, 'onStart', { x: 90, y: 135 });
    fire(pinch, 'onStart');
    fire(draw, 'onUpdate', { x: 210, y: 315 });
    fire(pinch, 'onFinalize');
    end(draw, { x: 270, y: 405 });
    fire(draw, 'onFinalize');
    expect(onTrace).not.toHaveBeenCalled();
    expect(lock.mock.calls).toEqual([[true], [false]]);
  });

  it('retains viewport state and gesture identity across parent callback rerenders', () => {
    const { rerender } = render(createElement(SprayPhotoCanvas, canvasProps({ onInteractionChange: vi.fn() })));
    pinchTo(2);
    const gestureCount = runtime.gestures.length;
    const before = runtime.styles[0].compute();
    rerender(createElement(SprayPhotoCanvas, canvasProps({ onInteractionChange: vi.fn() })));
    expect(runtime.gestures).toHaveLength(gestureCount);
    expect(runtime.styles[0].compute()).toEqual(before);
  });

  it('cancels a cable trace when the second finger lands without any intervening draw update', () => {
    const onTrace = vi.fn();
    render(createElement(SprayPhotoCanvas, canvasProps({ mode: 'draw', onTrace })));
    const pinch = runtime.gestures[0];
    const draw = runtime.gestures.find((gesture) => gesture.options.enabled?.[0] === true)!;
    fire(draw, 'onStart', { x: 90, y: 135 });
    fire(draw, 'onTouchesDown', { numberOfTouches: 2 });
    fire(pinch, 'onStart');
    fire(pinch, 'onFinalize');
    end(draw, { x: 270, y: 405 });
    fire(draw, 'onFinalize');
    expect(onTrace).not.toHaveBeenCalled();
  });
});

describe('ZoomableTnutMarker', () => {
  it('preserves the current viewport at non-unit pinch start and after successive pinches', () => {
    render(createElement(ZoomableTnutMarker, props()));
    pinchTo(2);
    const pan = runtime.gestures[1];
    fire(pan, 'onStart', { translationX: 15, translationY: 20 });
    fire(pan, 'onUpdate', { translationX: 75, translationY: 110 });
    fire(pan, 'onFinalize');
    const before = runtime.styles[0].compute();
    expect(before).toEqual({ transform: [{ translateX: 60 }, { translateY: 90 }, { scale: 2 }] });
    const pinch = runtime.gestures[0];
    fire(pinch, 'onStart', { scale: 1.2, focalX: 120, focalY: 180 });
    fire(pinch, 'onUpdate', { scale: 1.2, focalX: 120, focalY: 180 });
    expect(runtime.styles[0].compute()).toEqual(before);
    fire(pinch, 'onUpdate', { scale: 1.8, focalX: 120, focalY: 180 });
    expect(runtime.styles[0].compute()).toEqual({
      transform: [{ translateX: 105 }, { translateY: 157.5 }, { scale: 3 }],
    });
    fire(pinch, 'onFinalize');
    fire(pinch, 'onStart', { scale: 1, focalX: 160, focalY: 200 });
    fire(pinch, 'onUpdate', { scale: 1, focalX: 160, focalY: 200 });
    expect(runtime.styles[0].compute()).toEqual({
      transform: [{ translateX: 105 }, { translateY: 157.5 }, { scale: 3 }],
    });
  });

  it('does not jump to the remaining finger when Android keeps a pinch active after a pointer lifts', () => {
    render(createElement(ZoomableTnutMarker, props()));
    const pinch = runtime.gestures[0];
    fire(pinch, 'onStart');
    fire(pinch, 'onUpdate', { scale: 2 });
    const before = runtime.styles[0].compute();
    fire(pinch, 'onUpdate', { scale: 2, numberOfPointers: 1, focalX: 250, focalY: 350 });
    expect(runtime.styles[0].compute()).toEqual(before);
    fire(pinch, 'onUpdate', { scale: 2, numberOfPointers: 2, focalX: 190, focalY: 290 });
    expect(runtime.styles[0].compute()).toEqual(before);
    fire(pinch, 'onUpdate', { scale: 3, numberOfPointers: 2, focalX: 190, focalY: 290 });
    expect(runtime.styles[0].compute()).toEqual({
      transform: [{ translateX: -20 }, { translateY: -32.5 }, { scale: 3 }],
    });
  });

  it('moves a corner in canonical coordinates after zoom and pan, without per-frame JS commits', () => {
    const onChange = vi.fn();
    const backdrop = vi.fn(() => createElement('div'));
    render(createElement(ZoomableTnutMarker, props({ onChange, renderBackdrop: backdrop })));
    expect(backdrop).toHaveBeenCalledWith(300, 450);
    pinchTo(2);
    const viewportPan = runtime.gestures[1];
    expect(fire(viewportPan, 'onTouchesMove').activate).toHaveBeenCalledOnce();
    fire(viewportPan, 'onStart');
    fire(viewportPan, 'onUpdate', { translationX: 60, translationY: 90 });
    fire(viewportPan, 'onFinalize');
    const topLeft = runtime.gestures[2];
    fire(topLeft, 'onBegin');
    const bridges = runtime.bridges;
    fire(topLeft, 'onUpdate', { translationX: 60, translationY: 90 });
    expect(runtime.bridges).toBe(bridges);
    expect(onChange).not.toHaveBeenCalled();
    expect(runtime.shapes[0].compute().d).toContain('M150 225');
    expect(runtime.shapes[1].compute().d).toContain('M146.00 225.00a4 4');
    fire(topLeft, 'onFinalize');
    expect(onChange).toHaveBeenCalledExactlyOnceWith([[400, 600], ...quad.slice(1)]);
  });

  it('lets the page scroll at fit scale and prioritizes corner handlers over viewport panning', () => {
    render(createElement(ZoomableTnutMarker, props()));
    const viewportPan = runtime.gestures[1];
    expect(fire(viewportPan, 'onTouchesMove').fail).toHaveBeenCalledOnce();
    expect(viewportPan.options.requireExternalGestureToFail).toHaveLength(4);
    for (const handle of runtime.gestures.slice(2)) {
      expect(handle.options.maxPointers).toEqual([1]);
      expect(handle.options.simultaneousWithExternalGesture).toHaveLength(1);
    }
  });

  it('balances overlapping pinch/handle interaction locks and ignores movement during pinch', () => {
    const lock = vi.fn();
    const onChange = vi.fn();
    render(createElement(ZoomableTnutMarker, props({ onDragActiveChange: lock, onChange })));
    const pinch = runtime.gestures[0];
    const handle = runtime.gestures[2];
    fire(handle, 'onBegin');
    fire(pinch, 'onTouchesDown', { numberOfTouches: 2 });
    fire(pinch, 'onStart');
    fire(handle, 'onUpdate', { translationX: 100 });
    fire(handle, 'onFinalize');
    expect(lock.mock.calls).toEqual([[true]]);
    expect(onChange).not.toHaveBeenCalled();
    fire(pinch, 'onFinalize');
    expect(lock.mock.calls).toEqual([[true], [false]]);
  });

  describe('a two-finger tap that never pinches (iOS sends it no onFinalize)', () => {
    function touchDown() {
      const lock = vi.fn();
      render(createElement(ZoomableTnutMarker, props({ onDragActiveChange: lock })));
      const pinch = runtime.gestures[0];
      fire(pinch, 'onTouchesDown', { numberOfTouches: 2 });
      expect(lock.mock.calls).toEqual([[true]]);
      return { lock, pinch };
    }

    it('hands the lock back when the last finger lifts, not before', () => {
      const { lock, pinch } = touchDown();
      fire(pinch, 'onTouchesUp', { numberOfTouches: 1 });
      expect(lock.mock.calls).toEqual([[true]]);
      fire(pinch, 'onTouchesUp', { numberOfTouches: 0 });
      expect(lock.mock.calls).toEqual([[true], [false]]);
    });

    it('hands the lock back on a cancel, whose touch count iOS has not cleared yet', () => {
      const { lock, pinch } = touchDown();
      fire(pinch, 'onTouchesCancelled', { numberOfTouches: 1 });
      expect(lock.mock.calls).toEqual([[true], [false]]);
    });

    it('can take the lock again for the next tap', () => {
      const { lock, pinch } = touchDown();
      fire(pinch, 'onTouchesUp', { numberOfTouches: 0 });
      fire(pinch, 'onTouchesDown', { numberOfTouches: 2 });
      fire(pinch, 'onTouchesUp', { numberOfTouches: 0 });
      expect(lock.mock.calls).toEqual([[true], [false], [true], [false]]);
    });

    it('releases once when Android follows up with onFinalize', () => {
      const { lock, pinch } = touchDown();
      fire(pinch, 'onTouchesUp', { numberOfTouches: 0 });
      fire(pinch, 'onFinalize');
      expect(lock.mock.calls).toEqual([[true], [false]]);
    });

    it('leaves a pinch that did start to onFinalize', () => {
      const { lock, pinch } = touchDown();
      fire(pinch, 'onStart');
      fire(pinch, 'onTouchesUp', { numberOfTouches: 0 });
      fire(pinch, 'onTouchesCancelled', { numberOfTouches: 0 });
      expect(lock.mock.calls).toEqual([[true]]);
      fire(pinch, 'onFinalize');
      expect(lock.mock.calls).toEqual([[true], [false]]);
      fire(pinch, 'onTouchesDown', { numberOfTouches: 2 });
      fire(pinch, 'onTouchesUp', { numberOfTouches: 0 });
      expect(lock.mock.calls).toEqual([[true], [false], [true], [false]]);
    });
  });

  it('restores hidden corners unchanged and draws just the active one-dimensional segment', () => {
    const { rerender } = render(
      createElement(
        ZoomableTnutMarker,
        props({ tnutGrid: { pattern: 'grid', rows: 1, columns: 8, firstRowOffset: false } }),
      ),
    );
    expect(screen.getAllByRole('slider').map((element) => element.getAttribute('aria-label'))).toEqual([
      'sprayWizard.anchors.cornerTopLeft',
      'sprayWizard.anchors.cornerTopRight',
    ]);
    expect(runtime.shapes[0].compute().d).toBe('M90 135L210 135');
    expect(runtime.shapes[1].compute().d?.match(/M/g)).toHaveLength(8);
    rerender(
      createElement(
        ZoomableTnutMarker,
        props({ tnutGrid: { pattern: 'grid', rows: 8, columns: 1, firstRowOffset: false } }),
      ),
    );
    expect(screen.getAllByRole('slider').map((element) => element.getAttribute('aria-label'))).toEqual([
      'sprayWizard.anchors.cornerTopLeft',
      'sprayWizard.anchors.cornerBottomLeft',
    ]);
    expect(runtime.shapes[0].compute().d).toBe('M90 135L90 315');
    rerender(createElement(ZoomableTnutMarker, props()));
    expect(screen.getAllByRole('slider')).toHaveLength(4);
    expect(runtime.shapes[0].compute().d).toBe('M90 135L210 135L210 315L90 315Z');
  });

  it('keeps corner coordinates on rotation while resetting the zoomed viewport', () => {
    const onChange = vi.fn();
    const { rerender } = render(createElement(ZoomableTnutMarker, props({ onChange })));
    pinchTo(3);
    rerender(createElement(ZoomableTnutMarker, props({ onChange, renderWidth: 450, renderHeight: 675 })));
    expect(runtime.styles[0].compute()).toEqual({ transform: [{ translateX: 0 }, { translateY: 0 }, { scale: 1 }] });
    const coordinates = runtime.shapes[0]
      .compute()
      .d?.match(/[\d.]+/g)
      ?.map(Number);
    expect(coordinates).toHaveLength(8);
    [135, 202.5, 315, 202.5, 315, 472.5, 135, 472.5].forEach((coordinate, index) =>
      expect(coordinates?.[index]).toBeCloseTo(coordinate, 8),
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it('caps zoom, keeps offscreen handles offscreen, and releases the scroll lock on unmount', () => {
    const lock = vi.fn();
    const { unmount } = render(createElement(ZoomableTnutMarker, props({ onDragActiveChange: lock })));
    pinchTo(100);
    expect(runtime.styles[0].compute()).toEqual({ transform: [{ translateX: 0 }, { translateY: 0 }, { scale: 6 }] });
    expect(Number(runtime.styles[1].compute().left)).toBeLessThan(-44);
    const handle = runtime.gestures[2];
    fire(handle, 'onBegin');
    unmount();
    expect(lock).toHaveBeenLastCalledWith(false);
    const calls = lock.mock.calls.length;
    fire(handle, 'onFinalize');
    expect(lock).toHaveBeenCalledTimes(calls);
  });
});
