// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// What is under test is the crop marker's wiring, as for `SprayCornerMarker`:
// how many gesture objects it builds and what a released drag reports. The gesture builder is a recorder — every
// `Gesture.Pan()` is counted and keeps the handlers it was given, so a test can
// "lift the finger" by calling them.
type PanHandlers = {
  onBegin?: () => void;
  onUpdate?: (event: { translationX: number; translationY: number }) => void;
  onEnd?: () => void;
  onFinalize?: () => void;
};
const pans = vi.hoisted(() => ({ built: [] as PanHandlers[] }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {} },
}));
vi.mock('expo-image', () => ({ Image: () => createElement('img') }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native-svg', () => ({
  default: ({ children }: { children?: ReactNode }) => createElement('svg', null, children),
  Path: () => createElement('path'),
}));
vi.mock('../../../theme/tokens', () => ({ borderRadius: { lg: 12 } }));

vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  return {
    default: {
      View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
      createAnimatedComponent: (component: unknown) => component,
    },
    useAnimatedStyle: () => ({}),
    useAnimatedProps: () => ({}),
    // One object for the life of the component, as the real hook gives.
    useSharedValue: (initial: number) => useRef({ value: initial }).current,
    runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
  };
});

vi.mock('react-native-gesture-handler', () => ({
  GestureDetector: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Gesture: {
    Pan: () => {
      const handlers: PanHandlers = {};
      pans.built.push(handlers);
      const builder = {
        onBegin: (handler: PanHandlers['onBegin']) => ((handlers.onBegin = handler), builder),
        onUpdate: (handler: PanHandlers['onUpdate']) => ((handlers.onUpdate = handler), builder),
        onEnd: (handler: PanHandlers['onEnd']) => ((handlers.onEnd = handler), builder),
        onFinalize: (handler: PanHandlers['onFinalize']) => ((handlers.onFinalize = handler), builder),
      };
      return builder;
    },
  },
}));

import { SprayCropMarker, type SprayCropMarkerProps } from '../SprayCropMarker';

/** A landscape photo limited by its width: drawn 400 x 300. */
const PHOTO = { uri: 'file:///wall.jpg', width: 4096, height: 3072 };
const WHOLE = { left: 0, top: 0, right: 1, bottom: 1 };

function props(overrides: Partial<SprayCropMarkerProps> = {}): SprayCropMarkerProps {
  return {
    photo: PHOTO,
    maxWidth: 400,
    maxHeight: 600,
    value: WHOLE,
    onChange: vi.fn(),
    minSize: { width: 0.25, height: 0.3 },
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  pans.built.length = 0;
});

/** The pans in build order: the box first, then the eight handles in `CROP_RESIZE_HANDLES` order. */
function pan(
  name: 'move' | 'top' | 'right' | 'bottom' | 'left' | 'topLeft' | 'topRight' | 'bottomRight' | 'bottomLeft',
) {
  const order = ['move', 'top', 'right', 'bottom', 'left', 'topLeft', 'topRight', 'bottomRight', 'bottomLeft'];
  return pans.built[order.indexOf(name)];
}

describe('SprayCropMarker', () => {
  it('builds no gestures until it has a box to fit the photo in', () => {
    render(createElement(SprayCropMarker, props({ maxWidth: 0, maxHeight: 0 })));
    expect(pans.built).toHaveLength(0);
  });

  it('builds one gesture per handle plus the box, and keeps them through a parent re-render', () => {
    const { rerender } = render(createElement(SprayCropMarker, props({ onDragActiveChange: vi.fn() })));
    expect(pans.built).toHaveLength(9);
    rerender(createElement(SprayCropMarker, props({ onChange: vi.fn(), onDragActiveChange: vi.fn() })));
    expect(pans.built).toHaveLength(9);
  });

  it('reports a dragged edge as fractions of the photo', () => {
    const onChange = vi.fn();
    const onDragActiveChange = vi.fn();
    render(createElement(SprayCropMarker, props({ onChange, onDragActiveChange })));

    // 100 points across a 400-point frame is a quarter of the photo.
    const left = pan('left');
    left.onBegin?.();
    left.onUpdate?.({ translationX: 100, translationY: 37 });
    left.onEnd?.();
    left.onFinalize?.();

    expect(onChange).toHaveBeenLastCalledWith({ left: 0.25, top: 0, right: 1, bottom: 1 });
    expect(onDragActiveChange.mock.calls).toEqual([[true], [false]]);
  });

  it('stops a corner at the minimum and at the photo edge', () => {
    const onChange = vi.fn();
    render(createElement(SprayCropMarker, props({ onChange })));

    const corner = pan('bottomRight');
    corner.onBegin?.();
    corner.onUpdate?.({ translationX: -5000, translationY: 5000 });
    corner.onEnd?.();

    const [rect] = onChange.mock.calls[0];
    expect(rect.right).toBeCloseTo(0.25, 12);
    expect(rect.bottom).toBe(1);
  });

  it('moves the box without resizing it', () => {
    const onChange = vi.fn();
    render(
      createElement(SprayCropMarker, props({ onChange, value: { left: 0.2, top: 0.2, right: 0.6, bottom: 0.6 } })),
    );

    const box = pan('move');
    box.onBegin?.();
    box.onUpdate?.({ translationX: 1000, translationY: -30 });
    box.onEnd?.();

    const [rect] = onChange.mock.calls[0];
    expect(rect.left).toBeCloseTo(0.6, 12);
    expect(rect.right).toBeCloseTo(1, 12);
    expect(rect.top).toBeCloseTo(0.1, 12);
    expect(rect.bottom).toBeCloseTo(0.5, 12);
  });
});
