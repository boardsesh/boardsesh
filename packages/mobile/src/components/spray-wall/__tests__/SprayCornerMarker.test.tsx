// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// What is under test is the marker's wiring: how many gesture objects it builds
// and what a released drag reports. The gesture builder is a recorder — every
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
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
  DynamicColorIOS: (pair: { light: string }) => pair.light,
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {} },
}));
vi.mock('expo-image', () => ({ Image: () => createElement('img') }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native-svg', () => ({
  default: ({ children }: { children?: ReactNode }) => createElement('svg', null, children),
  Path: ({ stroke }: { stroke?: string }) => createElement('path', { 'data-stroke': stroke }),
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

import { SPRAY_GUIDE_COLORS, SprayCornerMarker, type SprayCornerMarkerProps } from '../SprayCornerMarker';

/** A portrait photo in a box that limits it by height: scale 420 / 2048. */
const PHOTO = { uri: 'file:///wall.jpg', width: 1536, height: 2048 };

function props(overrides: Partial<SprayCornerMarkerProps> = {}): SprayCornerMarkerProps {
  return { photo: PHOTO, maxWidth: 370, maxHeight: 420, value: null, onChange: vi.fn(), ...overrides };
}

afterEach(() => {
  cleanup();
  pans.built.length = 0;
});

describe('SprayCornerMarker', () => {
  it('draws photo guides in scheme-independent light tints over a dark halo', () => {
    const { container, rerender } = render(createElement(SprayCornerMarker, props()));
    const strokes = () =>
      Array.from(container.querySelectorAll('path')).map((path) => path.getAttribute('data-stroke'));
    expect(SPRAY_GUIDE_COLORS.valid).toBe('#A78BFA');
    expect(SPRAY_GUIDE_COLORS.invalid).toBe('#F87171');
    expect(strokes()).toEqual([SPRAY_GUIDE_COLORS.halo, SPRAY_GUIDE_COLORS.valid]);
    rerender(createElement(SprayCornerMarker, props({ invalid: true })));
    expect(strokes()).toEqual([SPRAY_GUIDE_COLORS.halo, SPRAY_GUIDE_COLORS.invalid]);
  });

  it('builds no gestures until it has a box to fit the photo in', () => {
    render(createElement(SprayCornerMarker, props({ maxWidth: 0, maxHeight: 0 })));
    expect(pans.built).toHaveLength(0);
  });

  it('does not rebuild a gesture when its parent re-renders with new callbacks', () => {
    // The page's scroll lock is a state change on finger-down and the screens
    // pass `onChange` as a fresh closure every render. Either would swap all
    // four pans out from under a held finger if the gestures depended on them.
    const { rerender } = render(createElement(SprayCornerMarker, props({ onDragActiveChange: vi.fn() })));
    expect(pans.built).toHaveLength(4);

    rerender(createElement(SprayCornerMarker, props({ onChange: vi.fn(), onDragActiveChange: vi.fn() })));
    rerender(createElement(SprayCornerMarker, props({ onChange: vi.fn(), invalid: true })));
    expect(pans.built).toHaveLength(4);
  });

  it('reports to the callbacks of the latest render, through the gestures of the first', () => {
    const firstChange = vi.fn();
    const latestChange = vi.fn();
    const latestDrag = vi.fn();
    const { rerender } = render(createElement(SprayCornerMarker, props({ onChange: firstChange })));
    rerender(createElement(SprayCornerMarker, props({ onChange: latestChange, onDragActiveChange: latestDrag })));

    const [topLeft] = pans.built;
    topLeft.onBegin?.();
    topLeft.onEnd?.();
    topLeft.onFinalize?.();

    expect(firstChange).not.toHaveBeenCalled();
    expect(latestChange).toHaveBeenCalledTimes(1);
    expect(latestDrag.mock.calls).toEqual([[true], [false]]);
  });

  it('reports a dragged corner in photo pixels, clamped to the photo', () => {
    const onChange = vi.fn();
    render(createElement(SprayCornerMarker, props({ onChange })));
    const scale = 420 / 2048;

    // Top-left starts a tenth of the way in. Move it 20 points right, 10 down.
    const [topLeft, , bottomRight] = pans.built;
    topLeft.onBegin?.();
    topLeft.onUpdate?.({ translationX: 20, translationY: 10 });
    topLeft.onEnd?.();

    const [[afterTopLeft]] = onChange.mock.calls;
    expect(afterTopLeft[0][0]).toBeCloseTo(153.6 + 20 / scale, 6);
    expect(afterTopLeft[0][1]).toBeCloseTo(204.8 + 10 / scale, 6);
    // The other three are where they were seeded.
    expect(afterTopLeft[2][0]).toBeCloseTo(1382.4, 6);
    expect(afterTopLeft[2][1]).toBeCloseTo(1843.2, 6);

    // Bottom-right, dragged far past the frame, stops on the photo's own corner.
    bottomRight.onBegin?.();
    bottomRight.onUpdate?.({ translationX: 5000, translationY: 5000 });
    bottomRight.onEnd?.();

    const afterBottomRight = onChange.mock.calls[1][0];
    expect(afterBottomRight[2][0]).toBeCloseTo(1536, 6);
    expect(afterBottomRight[2][1]).toBeCloseTo(2048, 6);
  });
});
