// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// Issue #4279: the zoomed board's pan blocks the drawer's pull-down-to-dismiss
// Pan (see zoomed-pan-blocks-drawer-dismiss.test.ts). That relation is only safe
// because the detector carrying it is mounted ONLY while zoomed — at 1x there is
// no zoom-pan gesture in the tree, so nothing is holding the dismiss back and a
// downward drag still pulls the drawer away. Mount it unconditionally (the easy
// mistake) and pull-to-dismiss dies everywhere on the board.

type ViewProps = { children?: ReactNode; testID?: string; onLayout?: unknown };

// vi.mock factories are hoisted above module scope, so anything they close over
// has to be hoisted with them.
const { renderView, zoomState } = vi.hoisted(() => ({
  renderView: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  zoomState: { isZoomed: false },
}));

vi.mock('react-native', () => ({
  View: renderView,
  Pressable: ({ children }: ViewProps) => createElement('button', null, children),
  Text: ({ children }: ViewProps) => createElement('span', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  PixelRatio: { get: () => 2 },
  // The theme tokens the carousel imports resolve iOS system colours at module load.
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  PlatformColor: (name: string) => name,
}));

vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  return {
    default: { View: renderView },
    useSharedValue: (initial: unknown) => {
      const ref = useRef<{ value: unknown } | null>(null);
      if (ref.current === null) ref.current = { value: initial };
      return ref.current;
    },
    useAnimatedStyle: (factory: () => unknown) => factory(),
    useDerivedValue: (factory: () => unknown) => ({ value: factory() }),
    useAnimatedReaction: () => {},
    withTiming: (toValue: unknown) => toValue,
    runOnJS:
      (fn: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) =>
        fn(...args),
  };
});

// Each GestureDetector reports which gesture it was handed, so a test can tell
// the always-on pinch+swipe composition apart from the zoomed-only pan overlay.
vi.mock('react-native-gesture-handler', () => ({
  Gesture: { Simultaneous: (...parts: unknown[]) => ({ kind: 'simultaneous', parts }) },
  GestureDetector: ({ gesture, children }: { gesture: { kind?: string }; children?: ReactNode }) =>
    createElement('div', { 'data-testid': 'gesture-detector', 'data-gesture': gesture?.kind ?? 'unknown' }, children),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../BoardImageNative', () => ({ BoardImageNative: () => createElement('div') }));
vi.mock('../../Icon', () => ({ Icon: () => createElement('div') }));
vi.mock('../use-carousel-gesture', () => ({
  useCarouselGesture: () => ({ gesture: { kind: 'swipe' }, translateX: { value: 0 } }),
}));

vi.mock('../use-zoom-pan-gesture', () => ({
  useZoomPanGesture: () => ({
    pinchGesture: { kind: 'pinch' },
    zoomPanGesture: { kind: 'zoom-pan' },
    isZoomed: zoomState.isZoomed,
    isZoomedSV: { value: zoomState.isZoomed },
    isPinchingSV: { value: false },
    scaleSV: { value: 1 },
    translateXSV: { value: 0 },
    translateYSV: { value: 0 },
    containerWidthSV: { value: 390 },
    containerHeightSV: { value: 600 },
    resetZoom: () => {},
    animatedZoomStyle: {},
  }),
}));

import { SwipeBoardCarousel } from '../SwipeBoardCarousel';

const baseProps = {
  boardName: 'kilter' as const,
  boardRenderData: { boardWidth: 1080, boardHeight: 1920 },
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
  currentFrames: 'p1145r15',
  nextFrames: null,
  prevFrames: null,
  mirrored: false,
  canSwipeNext: true,
  canSwipePrevious: false,
  onSwipeNext: vi.fn(),
  onSwipePrevious: vi.fn(),
};

function mountedGestures(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-testid="gesture-detector"]')).map(
    (node) => node.getAttribute('data-gesture') ?? '',
  );
}

describe('SwipeBoardCarousel zoom-pan overlay mounting', () => {
  beforeEach(() => {
    zoomState.isZoomed = false;
  });

  it('mounts no zoom-pan detector at 1x, so pull-to-dismiss keeps the whole board', () => {
    const { container } = render(createElement(SwipeBoardCarousel, baseProps));

    expect(mountedGestures(container)).toEqual(['simultaneous']);
  });

  it('mounts the zoom-pan detector once zoomed, so its block on the dismiss goes live', () => {
    zoomState.isZoomed = true;
    const { container } = render(createElement(SwipeBoardCarousel, baseProps));

    expect(mountedGestures(container)).toContain('zoom-pan');
  });
});
