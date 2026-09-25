// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { LayoutChangeEvent } from 'react-native';

type Box = { width: number; height: number };
type ViewProps = {
  children?: ReactNode;
  onLayout?: (event: LayoutChangeEvent) => void;
  testID?: string;
  style?: unknown;
};

const recorded = vi.hoisted(() => ({
  onLayout: undefined as ViewProps['onLayout'],
  prefetch: vi.fn(),
}));

vi.mock('react-native', () => {
  const flattenStyle = (style: unknown): Record<string, unknown> => {
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
    return style && typeof style === 'object' ? (style as Record<string, unknown>) : {};
  };
  return {
    View: ({ children, onLayout, testID, style }: ViewProps) => {
      if (testID === 'play-drawer-board-container') recorded.onLayout = onLayout;
      const dimensions = flattenStyle(style);
      return createElement(
        'div',
        {
          'data-testid': testID,
          'data-width': dimensions.width,
          'data-height': dimensions.height,
        },
        children,
      );
    },
    StyleSheet: { create: (styles: unknown) => styles },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
    PixelRatio: { get: () => 3 },
  };
});
vi.mock('react-native-reanimated', async () => {
  const { View } = await import('react-native');
  return {
    default: { View },
    useAnimatedStyle: (factory: () => unknown) => factory(),
    useDerivedValue: (factory: () => unknown) => ({ value: factory() }),
    useAnimatedReaction: () => undefined,
    runOnJS: (callback: unknown) => callback,
  };
});
vi.mock('react-native-gesture-handler', () => ({
  Gesture: { Simultaneous: () => ({}) },
  GestureDetector: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../use-carousel-gesture', () => ({
  useCarouselGesture: () => ({ gesture: {}, translateX: { value: 0 } }),
}));
vi.mock('../use-zoom-pan-gesture', () => ({
  useZoomPanGesture: () => ({
    pinchGesture: {},
    zoomPanGesture: {},
    isZoomed: false,
    isZoomedSV: { value: false },
    resetZoom: () => {},
    animatedZoomStyle: {},
  }),
}));
vi.mock('../../BoardImageNative', () => ({
  // Paint synchronously, like an image whose photo and overlay are already cached.
  BoardImageNative: ({ frames, style, renderWidth }: { frames: string; style: Box; renderWidth: number }) =>
    createElement('div', {
      'data-testid': `board-${frames}`,
      'data-width': style?.width,
      'data-height': style?.height,
      'data-render-width': renderWidth,
    }),
}));
vi.mock('../UpcomingBoardPrefetch', () => ({
  UpcomingBoardPrefetch: (props: unknown) => {
    recorded.prefetch(props);
    return null;
  },
}));
vi.mock('../../board-controls/ResetZoomButton', () => ({ ResetZoomButton: () => null }));

import { SwipeBoardCarousel } from '../SwipeBoardCarousel';

const baseProps = {
  boardName: 'kilter' as const,
  boardRenderData: { boardWidth: 1000, boardHeight: 2000 },
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
  currentFrames: 'current',
  nextFrames: 'next',
  prevFrames: null,
  mirrored: false,
  canSwipeNext: true,
  canSwipePrevious: false,
  onSwipeNext: vi.fn(),
  onSwipePrevious: vi.fn(),
};

function measure(width: number, height: number) {
  const onLayout = recorded.onLayout;
  if (!onLayout) throw new Error('Carousel measurement container is missing');
  act(() => onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height } } } as LayoutChangeEvent));
}

function expectDimensions(element: HTMLElement, width: number, height: number) {
  expect(element.dataset.width).toBe(String(width));
  expect(element.dataset.height).toBe(String(height));
}

beforeEach(() => {
  recorded.onLayout = undefined;
  recorded.prefetch.mockClear();
  vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '0');
});
afterEach(() => vi.unstubAllEnvs());

describe.each(['0', '1'])('SwipeBoardCarousel layout (screenshot mode %s)', (screenshotMode) => {
  it('withholds cached images and prefetch until both dimensions are positive', () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', screenshotMode);
    const { queryAllByTestId, getByTestId } = render(createElement(SwipeBoardCarousel, baseProps));
    expect(getByTestId('play-drawer-board-container')).toBeTruthy();
    expect(queryAllByTestId(/^board-/)).toHaveLength(0);
    expect(recorded.prefetch).not.toHaveBeenCalled();

    measure(350, 0);
    expect(queryAllByTestId(/^board-/)).toHaveLength(0);
    expect(recorded.prefetch).not.toHaveBeenCalled();

    measure(350, 500);
    expectDimensions(getByTestId('board-current'), 250, 500);
    expectDimensions(getByTestId('board-next'), 250, 500);
    expect(getByTestId('board-current').dataset.renderWidth).toBe('750');
    if (screenshotMode === '0') {
      expect(recorded.prefetch).toHaveBeenLastCalledWith(expect.objectContaining({ renderWidth: 750 }));
      const zoomWrapper = getByTestId('board-current').parentElement!;
      expectDimensions(zoomWrapper, 250, 500);
      expectDimensions(zoomWrapper.parentElement!, 250, 500);
    } else {
      expect(recorded.prefetch).not.toHaveBeenCalled();
    }
  });

  it('resizes a mounted board for rotation or a narrower iPad pane without a placeholder', () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', screenshotMode);
    const { getByTestId } = render(createElement(SwipeBoardCarousel, baseProps));
    measure(350, 500);
    const currentImage = getByTestId('board-current');

    measure(200, 600);
    expect(getByTestId('board-current')).toBe(currentImage);
    expectDimensions(currentImage, 200, 400);
    expectDimensions(getByTestId('board-next'), 200, 400);
    expect(currentImage.dataset.renderWidth).toBe('600');
  });
});

it('contains a wide board and updates climbs without remounting the current image', () => {
  const props = { ...baseProps, boardRenderData: { boardWidth: 2000, boardHeight: 1000 } };
  const { getByTestId, rerender } = render(createElement(SwipeBoardCarousel, props));
  measure(350, 500);
  const currentImage = getByTestId('board-current');
  expectDimensions(currentImage, 350, 175);

  rerender(createElement(SwipeBoardCarousel, { ...props, currentFrames: 'another-climb' }));
  expect(getByTestId('board-another-climb')).toBe(currentImage);
  expectDimensions(currentImage, 350, 175);
});
