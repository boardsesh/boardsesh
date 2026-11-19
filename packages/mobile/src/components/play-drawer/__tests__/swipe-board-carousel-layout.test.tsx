// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement, StrictMode, useLayoutEffect, type ReactNode } from 'react';
import type { LayoutChangeEvent, ViewStyle } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';
import type { BoardArtReadiness } from '../../../lib/board-render/ready-board-art';

type ViewProps = {
  children?: ReactNode;
  onLayout?: (event: LayoutChangeEvent) => void;
  testID?: string;
  style?: unknown;
  accessible?: boolean;
  importantForAccessibility?: string;
  pointerEvents?: string;
  accessibilityRole?: string;
  accessibilityActions?: { name: string; label: string }[];
  accessibilityValue?: { text?: string };
  onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
  needsOffscreenAlphaCompositing?: boolean;
};

const recorded = vi.hoisted(() => ({
  motionNative: false,
  gpuEnabled: true,
  pngWallFade: true,
  apiVersion: 5,
  renderSettings: { mode: 'aura', boardsesh: { softDisc: false } },
  onLayout: undefined as ViewProps['onLayout'],
  prefetch: vi.fn(),
  swipeOptions: vi.fn(),
  zoomOptions: vi.fn(),
  boardProps: vi.fn(),
  synchronousArtReadiness: undefined as BoardArtReadiness | undefined,
  accessibility: undefined as
    | Pick<ViewProps, 'accessibilityRole' | 'accessibilityActions' | 'accessibilityValue' | 'onAccessibilityAction'>
    | undefined,
}));

vi.mock('../../../lib/board-render/gpu-native-capability', () => ({
  get climbOverlayGpuApiVersion() {
    return recorded.apiVersion;
  },
  // No swap look: the board runs the shipped wall swap (player-swap-look.test.tsx covers the look).
  climbOverlaySwapCommandApi: 0,
  climbOverlaySwapLookVersion: 0,
}));
vi.mock('../../../../modules/climb-overlay-gpu/src', () => ({
  climbOverlayGpuApiVersion: 5,
  get NativeMotionClimbOverlayGPU() {
    return recorded.motionNative ? 'NativeMotionClimbOverlayGPU' : null;
  },
}));
vi.mock('../../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => false }));
vi.mock('../../../lib/board-render-settings', () => ({
  useBoardRenderSettings: () => ({ settings: recorded.renderSettings }),
}));
vi.mock('../../../providers/feature-flags-provider', () => ({
  useGpuClimbOverlayEnabled: () => recorded.gpuEnabled,
  usePlayerSwapLookEnabled: () => true,
  usePngWallFadeEnabled: () => recorded.pngWallFade,
}));

// The platform the board's spoken value is decided for.
const platform = vi.hoisted(() => ({ OS: 'android' as 'android' | 'ios' }));

const sharedThreads = vi.hoisted(() => ({
  asynchronous: false,
  onUiThread: false,
  uiJobs: [] as (() => void)[],
  synchronizeJsReads: [] as (() => void)[],
}));

vi.mock('react-native', () => {
  const flattenStyle = (style: unknown): Record<string, unknown> => {
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
    return style && typeof style === 'object' ? (style as Record<string, unknown>) : {};
  };
  return {
    View: ({
      children,
      onLayout,
      testID,
      style,
      accessible,
      importantForAccessibility,
      pointerEvents,
      accessibilityRole,
      accessibilityActions,
      accessibilityValue,
      onAccessibilityAction,
      needsOffscreenAlphaCompositing,
    }: ViewProps) => {
      if (testID === 'play-drawer-board-container') recorded.onLayout = onLayout;
      if (testID === 'play-drawer-board-accessibility') {
        recorded.accessibility = { accessibilityRole, accessibilityActions, accessibilityValue, onAccessibilityAction };
      }
      const dimensions = flattenStyle(style);
      const transform = dimensions.transform as { translateX?: number }[] | undefined;
      return createElement(
        'div',
        {
          'data-testid': testID,
          'data-width': dimensions.width,
          'data-height': dimensions.height,
          'data-opacity': dimensions.opacity,
          'data-z-index': dimensions.zIndex,
          'data-accessible': accessible,
          'data-important-for-accessibility': importantForAccessibility,
          'data-pointer-events': pointerEvents,
          'data-zoomed': dimensions.zoomMarker,
          'data-translate-x': transform?.[0]?.translateX,
          'data-offscreen-alpha': needsOffscreenAlphaCompositing,
        },
        children,
      );
    },
    StyleSheet: { create: (styles: unknown) => styles },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
    PixelRatio: { get: () => 3 },
    Platform: platform,
  };
});
vi.mock('react-native-reanimated', async () => {
  const { View } = await import('react-native');
  const { useRef } = await import('react');
  return {
    default: { View },
    useAnimatedStyle: (factory: () => unknown) => factory(),
    // The wall swap's UI-thread reaction; its step is covered by wall-swap.test.ts.
    useAnimatedReaction: () => {},
    useDerivedValue: (factory: () => unknown) => ({
      get value() {
        return factory();
      },
    }),
    useSharedValue: (initial: unknown) => {
      const shared = useRef<{ value: unknown } | null>(null);
      if (shared.current === null) {
        let uiContents = initial;
        let jsCachedContents = initial;
        shared.current = {
          get value() {
            return !sharedThreads.asynchronous || sharedThreads.onUiThread ? uiContents : jsCachedContents;
          },
          set value(nextContents: unknown) {
            if (sharedThreads.asynchronous && !sharedThreads.onUiThread) {
              sharedThreads.uiJobs.push(() => {
                uiContents = nextContents;
              });
            } else {
              uiContents = nextContents;
              if (!sharedThreads.asynchronous) jsCachedContents = nextContents;
            }
          },
        };
        sharedThreads.synchronizeJsReads.push(() => {
          jsCachedContents = uiContents;
        });
      }
      return shared.current;
    },
    runOnUI:
      (worklet: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) => {
        const executeWorklet = () => {
          const previousThread = sharedThreads.onUiThread;
          sharedThreads.onUiThread = true;
          try {
            worklet(...args);
          } finally {
            sharedThreads.onUiThread = previousThread;
          }
        };
        if (sharedThreads.asynchronous) sharedThreads.uiJobs.push(executeWorklet);
        else executeWorklet();
      },
  };
});
vi.mock('react-native-gesture-handler', () => ({
  Gesture: { Simultaneous: () => ({}) },
  GestureDetector: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../use-carousel-gesture', () => ({
  useCarouselGesture: (options: unknown) => {
    recorded.swipeOptions(options);
    return { gesture: {} };
  },
}));
vi.mock('../use-zoom-pan-gesture', () => ({
  useZoomPanGesture: (options: unknown) => {
    recorded.zoomOptions(options);
    return {
      pinchGesture: {},
      zoomPanGesture: {},
      isZoomed: false,
      isZoomedSV: { value: false },
      resetZoom: () => {},
      // A marker the mocked View surfaces, standing in for the animated zoom transform.
      animatedZoomStyle: { zoomMarker: 'yes' },
    };
  },
}));
vi.mock('../../BoardImageNative', () => ({
  // Paint synchronously, like an image whose photo and overlay are already cached.
  BoardImageNative: (props: {
    frames: string;
    bareWall?: boolean;
    style: ViewStyle;
    renderWidth: number;
    overlayTestID?: string;
    onArtReadinessChange?: (readiness: BoardArtReadiness) => void;
  }) => {
    recorded.boardProps(props);
    const { frames, style, renderWidth, overlayTestID } = props;
    useLayoutEffect(() => {
      if (recorded.synchronousArtReadiness !== undefined) {
        props.onArtReadinessChange?.(recorded.synchronousArtReadiness);
      }
    }, [frames, props.onArtReadinessChange]);
    return createElement('div', {
      'data-testid': props.bareWall ? 'bare-wall' : `board-${frames}`,
      'data-width': style?.width,
      'data-height': style?.height,
      'data-render-width': renderWidth,
      'data-overlay-testid': overlayTestID,
    });
  },
}));
vi.mock('../UpcomingBoardPrefetch', () => ({
  UpcomingBoardPrefetch: (props: unknown) => {
    recorded.prefetch(props);
    return null;
  },
}));
vi.mock('../../board-controls/ResetZoomButton', () => ({ ResetZoomButton: () => null }));

import { SwipeBoardCarousel } from '../SwipeBoardCarousel';
import type { SwipePager } from '../use-swipe-pager';
import type { ReadyBoardArtSnapshot } from '../../../lib/board-render/ready-board-art';
import { _resetPlayBoardPrewarmForTests, rememberPlayOverlayWidth } from '../../../lib/board-render/play-board-prewarm';

/** A pager at rest on page 0, as plain values: these tests never move it. */
function restingPager(): SwipePager {
  return {
    translateX: { value: 0 },
    isAnimating: { value: false },
    anchorPage: { value: 0 },
    flingDirection: { value: 0 },
    uiSteps: { value: 0 },
    jsState: { value: { center: 0, hasPrevious: false, hasNext: true, processedStep: 0 } },
    slideWidth: { value: 0 },
    stationaryMotion: { value: false },
    resetGeneration: { value: 0 },
    untoldStep: { value: 0 },
    tellUntoldStep: () => {},
    requestStep: () => {},
    stepRendered: () => {},
    setNavigation: () => {},
  } as unknown as SwipePager;
}

const baseProps = {
  boardName: 'kilter' as const,
  boardRenderData: { boardWidth: 1000, boardHeight: 2000 },
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
  currentFrames: 'current',
  nextFrames: 'next',
  prevFrames: null,
  pager: restingPager(),
  centerPage: 0,
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

/** The neighbours mount one frame after the board is measured. */
async function nextFrame() {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
}

function expectDimensions(element: HTMLElement, width: number, height: number) {
  expect(element.dataset.width).toBe(String(width));
  expect(element.dataset.height).toBe(String(height));
}

/** One UI turn: JS setters wait for this turn, while worklets read live state. */
function flushUiThread() {
  act(() => {
    while (sharedThreads.uiJobs.length > 0) sharedThreads.uiJobs.shift()?.();
    for (const synchronizeJsRead of sharedThreads.synchronizeJsReads) synchronizeJsRead();
  });
}

function readinessCallbackFor(frames: string): (readiness: BoardArtReadiness) => void {
  const boardProps = recorded.boardProps.mock.calls.findLast(([boardProps]) => boardProps.frames === frames)?.[0] as
    | { onArtReadinessChange?: (readiness: BoardArtReadiness) => void }
    | undefined;
  if (!boardProps?.onArtReadinessChange) throw new Error(`Missing artwork readiness callback for ${frames}`);
  return boardProps.onArtReadinessChange;
}

beforeEach(() => {
  platform.OS = 'android';
  recorded.motionNative = false;
  recorded.gpuEnabled = true;
  recorded.pngWallFade = true;
  recorded.apiVersion = 5;
  recorded.renderSettings = { mode: 'aura', boardsesh: { softDisc: false } };
  recorded.onLayout = undefined;
  _resetPlayBoardPrewarmForTests();
  recorded.prefetch.mockClear();
  recorded.swipeOptions.mockClear();
  recorded.zoomOptions.mockClear();
  recorded.boardProps.mockClear();
  recorded.synchronousArtReadiness = undefined;
  recorded.accessibility = undefined;
  sharedThreads.asynchronous = false;
  sharedThreads.onUiThread = false;
  sharedThreads.uiJobs.length = 0;
  sharedThreads.synchronizeJsReads.length = 0;
  vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '0');
});

it.each(['kilter', 'tension', 'decoy', 'touchstone', 'grasshopper', 'soill', 'moonboard', 'woods'] as const)(
  'releases stationary %s motion when the remote GPU switch turns off',
  (boardName) => {
    // The slide: the PNG board's own still wall would hold the flag (tested below).
    recorded.pngWallFade = false;
    recorded.motionNative = true;
    const pager = restingPager();
    const props = {
      ...baseProps,
      boardName,
      layoutId: 1,
      pager,
      prevFrames: 'previous',
      containerSize: { width: 350, height: 500 },
    };
    const { rerender } = render(createElement(SwipeBoardCarousel, props));
    expect(pager.stationaryMotion.value).toBe(true);
    recorded.gpuEnabled = false;
    rerender(createElement(SwipeBoardCarousel, { ...props, containerSize: { ...props.containerSize } }));
    expect(pager.stationaryMotion.value).toBe(false);
  },
);

it.each([0, 2, 3, 4])('keeps catalogue motion on PNG with API %s', (apiVersion) => {
  recorded.pngWallFade = false;
  recorded.motionNative = true;
  recorded.apiVersion = apiVersion;
  const pager = restingPager();
  const props = {
    ...baseProps,
    boardName: 'tension' as const,
    layoutId: 1,
    pager,
    containerSize: { width: 350, height: 500 },
  };
  const { rerender } = render(createElement(SwipeBoardCarousel, props));
  expect(pager.stationaryMotion.value).toBe(false);
  rerender(createElement(SwipeBoardCarousel, { ...props, boardName: 'kilter', layoutId: 8 }));
  expect(pager.stationaryMotion.value).toBe(true);
});
afterEach(() => vi.unstubAllEnvs());

type StationaryBoardProps = {
  frames: string;
  gpuTransition?: {
    previousFrames: string | null;
    nextFrames: string | null;
    centerPage: number;
    pagePosition: SharedValue<number>;
  };
  onArtReadinessChange: (state: BoardArtReadiness) => void;
  onGpuTransitionStateChange: (state: 'unavailable' | 'loading' | 'ready') => void;
};

function latestStationaryBoard(): StationaryBoardProps {
  const call = recorded.boardProps.mock.calls.findLast(([props]) => props.gpuTransition !== undefined);
  if (!call) throw new Error('Stationary GPU board was not mounted');
  return call[0] as StationaryBoardProps;
}

it.each([
  { native: false, boardWidth: 1000, boardHeight: 2000, width: 250, height: 500, offsetX: 70, offsetY: 0 },
  { native: true, boardWidth: 1000, boardHeight: 2000, width: 250, height: 500, offsetX: 70, offsetY: 0 },
  { native: false, boardWidth: 2000, boardHeight: 1000, width: 358, height: 179, offsetX: 16, offsetY: 160.5 },
  { native: true, boardWidth: 2000, boardHeight: 1000, width: 358, height: 179, offsetX: 16, offsetY: 160.5 },
])(
  'zooms across the full player width without changing rest fit (%j)',
  ({ native, boardWidth, boardHeight, width, height, offsetX, offsetY }) => {
    recorded.motionNative = native;
    const { getByTestId } = render(
      createElement(SwipeBoardCarousel, {
        ...baseProps,
        layoutId: 8,
        restingHorizontalInset: 16,
        boardRenderData: { boardWidth, boardHeight },
        containerSize: { width: 390, height: 500 },
      }),
    );
    expectDimensions(getByTestId('board-current'), width, height);
    expect(recorded.zoomOptions.mock.lastCall?.[0]).toMatchObject({
      containerWidth: width,
      containerHeight: height,
      viewport: {
        width: 390,
        height: 500,
        offsetX,
        offsetY,
        bandStartX: 0,
        bandEndX: 390,
        bandStartY: 0,
        bandEndY: 500,
      },
    });
    expect(recorded.swipeOptions.mock.lastCall?.[0].boardWidth).toBe(width);
  },
);

it('keeps one photograph and feeds reversible absolute progress without a JS render', () => {
  recorded.motionNative = true;
  const pager = restingPager();
  const { queryAllByTestId } = render(
    createElement(SwipeBoardCarousel, {
      ...baseProps,
      layoutId: 8,
      pager,
      prevFrames: 'previous',
      containerSize: { width: 350, height: 500 },
    }),
  );
  expect(queryAllByTestId(/^board-/)).toHaveLength(1);
  expect(pager.stationaryMotion.value).toBe(true);
  const board = latestStationaryBoard();
  expect(board.gpuTransition).toMatchObject({ previousFrames: 'previous', nextFrames: 'next', centerPage: 0 });
  const renderCount = recorded.boardProps.mock.calls.length;
  pager.slideWidth.value = 250;
  pager.translateX.value = -125;
  expect(board.gpuTransition?.pagePosition.value).toBe(0.5);
  pager.translateX.value = 50;
  expect(board.gpuTransition?.pagePosition.value).toBe(-0.2);
  pager.anchorPage.value = 1;
  pager.translateX.value = 0;
  expect(board.gpuTransition?.pagePosition.value).toBe(1);
  expect(recorded.boardProps.mock.calls).toHaveLength(renderCount);
});

it('hands an API 6 board the wall swap frame alongside the wipe progress', () => {
  recorded.motionNative = true;
  recorded.apiVersion = 6;
  const pager = restingPager();
  render(
    createElement(SwipeBoardCarousel, {
      ...baseProps,
      layoutId: 8,
      pager,
      prevFrames: 'previous',
      containerSize: { width: 350, height: 500 },
    }),
  );
  const transition = latestStationaryBoard().gpuTransition as unknown as {
    revealMode: string;
    pagePosition: { value: number };
    swapFrame: { value: readonly number[] };
  };
  expect(transition.revealMode).toBe('swap');
  expect(transition.swapFrame.value).toEqual([0, 1, 0, 1]);
  // The swap's frame moves only on the UI thread, never with the pager's raw offset.
  pager.slideWidth.value = 250;
  pager.translateX.value = -125;
  expect(transition.swapFrame.value).toEqual([0, 1, 0, 1]);
  expect(transition.pagePosition.value).toBe(0.5);
});

it.each([1, -1] as const)('keeps the incoming holds during the outgoing animation tail (%s)', (direction) => {
  recorded.motionNative = true;
  const pager = restingPager();
  const props = {
    ...baseProps,
    layoutId: 8,
    pager,
    currentFrames: 'outgoing',
    prevFrames: 'previous',
    nextFrames: 'next',
    containerSize: { width: 390, height: 500 },
  };
  const { rerender } = render(createElement(SwipeBoardCarousel, props));
  pager.slideWidth.value = 250;
  pager.isAnimating.value = true;
  pager.flingDirection.value = direction;
  // The header keeps travelling past the contained board to clear its margins.
  pager.translateX.value = -direction * 414;
  // Navigation publishes the new trio once the incoming board reaches center,
  // before the UI thread lands the outgoing header and advances its anchor.
  rerender(
    createElement(SwipeBoardCarousel, {
      ...props,
      centerPage: direction,
      currentFrames: 'incoming',
      prevFrames: direction === 1 ? 'outgoing' : 'unrelated-previous',
      nextFrames: direction === 1 ? 'unrelated-next' : 'outgoing',
    }),
  );
  const transition = latestStationaryBoard().gpuTransition!;
  expect(transition.centerPage).toBe(direction);
  expect(transition.pagePosition.value).toBe(direction);
  expect(transition.pagePosition.value - transition.centerPage).toBe(0);
  pager.anchorPage.value = direction;
  pager.translateX.value = 0;
  pager.flingDirection.value = 0;
  expect(transition.pagePosition.value).toBe(direction);
});

it('waits for the photograph and prepared native neighbors before releasing a swipe', () => {
  recorded.motionNative = true;
  render(
    createElement(SwipeBoardCarousel, {
      ...baseProps,
      layoutId: 8,
      prevFrames: 'previous',
      containerSize: { width: 350, height: 500 },
    }),
  );
  const board = latestStationaryBoard();
  const pageArt = recorded.swipeOptions.mock.lastCall?.[0].pageArt as SharedValue<Record<number, BoardArtReadiness>>;
  act(() => board.onGpuTransitionStateChange('ready'));
  expect(pageArt.value).toEqual({ '-1': 'loading', 0: 'loading', 1: 'loading' });
  act(() => board.onArtReadinessChange('ready'));
  expect(pageArt.value).toEqual({ '-1': 'ready', 0: 'ready', 1: 'ready' });
});

it('ignores a stale three-climb presentation after the pager window advances', () => {
  recorded.motionNative = true;
  const props = { ...baseProps, layoutId: 8, prevFrames: 'previous', containerSize: { width: 350, height: 500 } };
  const { rerender } = render(createElement(SwipeBoardCarousel, props));
  const stale = latestStationaryBoard();
  rerender(
    createElement(SwipeBoardCarousel, {
      ...props,
      centerPage: 1,
      prevFrames: 'current',
      currentFrames: 'next',
      nextFrames: 'later',
    }),
  );
  const pageArt = recorded.swipeOptions.mock.lastCall?.[0].pageArt as SharedValue<Record<number, BoardArtReadiness>>;
  act(() => {
    stale.onGpuTransitionStateChange('ready');
    stale.onArtReadinessChange('ready');
  });
  expect(pageArt.value).toEqual({ 0: 'loading', 1: 'loading', 2: 'loading' });
  const current = latestStationaryBoard();
  act(() => {
    current.onGpuTransitionStateChange('ready');
    current.onArtReadinessChange('ready');
  });
  expect(pageArt.value).toEqual({ 0: 'ready', 1: 'ready', 2: 'ready' });
});

it('rejects old readiness and failure callbacks when the same three climbs return', () => {
  recorded.motionNative = true;
  const props = { ...baseProps, layoutId: 8, prevFrames: 'previous', containerSize: { width: 350, height: 500 } };
  const { rerender, queryAllByTestId } = render(createElement(SwipeBoardCarousel, props));
  const firstVisit = latestStationaryBoard();
  rerender(
    createElement(SwipeBoardCarousel, {
      ...props,
      centerPage: 1,
      prevFrames: 'current',
      currentFrames: 'next',
      nextFrames: 'later',
    }),
  );
  rerender(createElement(SwipeBoardCarousel, props));
  const returnVisit = latestStationaryBoard();
  const pageArt = recorded.swipeOptions.mock.lastCall?.[0].pageArt as SharedValue<Record<number, BoardArtReadiness>>;
  act(() => {
    firstVisit.onGpuTransitionStateChange('ready');
    firstVisit.onArtReadinessChange('ready');
  });
  expect(pageArt.value).toEqual({ '-1': 'loading', 0: 'loading', 1: 'loading' });
  act(() => firstVisit.onGpuTransitionStateChange('unavailable'));
  expect(queryAllByTestId(/^board-/)).toHaveLength(1);
  expect(recorded.boardProps.mock.lastCall?.[0].gpuTransition).toBeDefined();
  act(() => {
    returnVisit.onGpuTransitionStateChange('ready');
    returnVisit.onArtReadinessChange('ready');
  });
  expect(pageArt.value).toEqual({ '-1': 'ready', 0: 'ready', 1: 'ready' });
});

it('returns to retained image pages after unsupported or failed native rendering', async () => {
  recorded.pngWallFade = false;
  recorded.motionNative = true;
  const pager = restingPager();
  const { queryAllByTestId } = render(
    createElement(SwipeBoardCarousel, {
      ...baseProps,
      pager,
      layoutId: 8,
      prevFrames: 'previous',
      containerSize: { width: 350, height: 500 },
    }),
  );
  const board = latestStationaryBoard();
  act(() => board.onGpuTransitionStateChange('unavailable'));
  await nextFrame();
  expect(queryAllByTestId(/^board-/)).toHaveLength(3);
  expect(recorded.boardProps.mock.lastCall?.[0].gpuTransition).toBeUndefined();
  expect(pager.stationaryMotion.value).toBe(false);
});

it('uses the existing carousel for Classic and retries stationary rendering after changing appearance', async () => {
  recorded.motionNative = true;
  recorded.renderSettings = { mode: 'classic', boardsesh: { softDisc: false } };
  const props = { ...baseProps, layoutId: 8, prevFrames: 'previous', containerSize: { width: 350, height: 500 } };
  const { rerender, queryAllByTestId } = render(createElement(SwipeBoardCarousel, props));
  await nextFrame();
  expect(queryAllByTestId(/^board-/)).toHaveLength(3);
  recorded.renderSettings = { mode: 'aura', boardsesh: { softDisc: false } };
  rerender(createElement(SwipeBoardCarousel, { ...props, onSwipeNext: vi.fn() }));
  expect(queryAllByTestId(/^board-/)).toHaveLength(1);
  const board = latestStationaryBoard();
  act(() => board.onGpuTransitionStateChange('unavailable'));
  expect(queryAllByTestId(/^board-/)).toHaveLength(3);
  recorded.renderSettings = { mode: 'aura', boardsesh: { softDisc: true } };
  rerender(createElement(SwipeBoardCarousel, { ...props, onSwipeNext: vi.fn() }));
  expect(queryAllByTestId(/^board-/)).toHaveLength(3);
  recorded.renderSettings = { mode: 'default', boardsesh: { softDisc: false } };
  rerender(createElement(SwipeBoardCarousel, { ...props, onSwipeNext: vi.fn() }));
  expect(queryAllByTestId(/^board-/)).toHaveLength(1);
});

it('retries a new climb window after a frame failure without accepting old callbacks', async () => {
  recorded.motionNative = true;
  const props = {
    ...baseProps,
    pager: restingPager(),
    layoutId: 8,
    prevFrames: 'previous',
    containerSize: { width: 350, height: 500 },
  };
  const { rerender, queryAllByTestId } = render(createElement(SwipeBoardCarousel, props));
  const failedBoard = latestStationaryBoard();
  act(() => failedBoard.onGpuTransitionStateChange('unavailable'));
  await nextFrame();
  expect(queryAllByTestId(/^board-/)).toHaveLength(3);
  rerender(createElement(SwipeBoardCarousel, { ...props, onSwipeNext: vi.fn() }));
  expect(queryAllByTestId(/^board-/)).toHaveLength(3);

  rerender(
    createElement(SwipeBoardCarousel, {
      ...props,
      centerPage: 1,
      prevFrames: 'current',
      currentFrames: 'next',
      nextFrames: 'later',
    }),
  );
  expect(queryAllByTestId(/^board-/)).toHaveLength(1);
  expect(latestStationaryBoard().frames).toBe('next');
  act(() => failedBoard.onGpuTransitionStateChange('unavailable'));
  expect(queryAllByTestId(/^board-/)).toHaveLength(1);
});

it('keeps readiness on retained pages and prunes removed slots without accepting their late callbacks', async () => {
  const props = { ...baseProps, containerSize: { width: 350, height: 500 }, prevFrames: 'previous' };
  const { rerender, unmount } = render(createElement(SwipeBoardCarousel, props));
  await nextFrame();
  const { pageArt } = recorded.swipeOptions.mock.calls.at(-1)![0] as {
    pageArt: SharedValue<Readonly<Record<number, BoardArtReadiness>>>;
  };
  const callbackFor = (frames: string) => {
    const props = recorded.boardProps.mock.calls
      .map(([props]) => props)
      .findLast((props) => props.frames === frames) as {
      onArtReadinessChange: (readiness: BoardArtReadiness) => void;
    };
    return props.onArtReadinessChange;
  };
  const removed = callbackFor('previous');
  act(() => {
    removed('ready');
    callbackFor('current')('ready');
    callbackFor('next')('ready');
  });
  expect(pageArt.value).toEqual({ '-1': 'ready', 0: 'ready', 1: 'ready' });
  rerender(
    createElement(SwipeBoardCarousel, {
      ...props,
      centerPage: 1,
      prevFrames: 'current',
      currentFrames: 'next',
      nextFrames: 'new-next',
    }),
  );
  expect(pageArt.value).toEqual({ 0: 'ready', 1: 'ready' });
  act(() => removed('ready'));
  expect(pageArt.value).toEqual({ 0: 'ready', 1: 'ready' });
  const retained = callbackFor('next');
  unmount();
  act(() => retained('ready'));
  expect(pageArt.value).toEqual({});
});

it('merges different slots atomically in one UI-thread turn despite cached JS reads', async () => {
  sharedThreads.asynchronous = true;
  const props = { ...baseProps, containerSize: { width: 350, height: 500 }, prevFrames: 'previous' };
  render(createElement(SwipeBoardCarousel, props));
  await nextFrame();
  const { pageArt } = recorded.swipeOptions.mock.calls.at(-1)![0] as {
    pageArt: SharedValue<Readonly<Record<number, BoardArtReadiness>>>;
  };
  pageArt.value = { 0: 'loading', 1: 'loading' };
  flushUiThread();

  act(() => {
    readinessCallbackFor('current')('ready');
    readinessCallbackFor('next')('ready');
  });
  // JS has not observed either scheduled update yet. Both callbacks saw the
  // same map, so JS-side read/modify/write would lose page 0's ready signal.
  expect(pageArt.value).toEqual({ 0: 'loading', 1: 'loading' });
  flushUiThread();

  expect(pageArt.value).toEqual({ 0: 'ready', 1: 'ready' });
});

it('keeps the newest slot transition when cached JS readiness already looks ready', async () => {
  sharedThreads.asynchronous = true;
  const props = { ...baseProps, containerSize: { width: 350, height: 500 }, prevFrames: 'previous' };
  render(createElement(SwipeBoardCarousel, props));
  await nextFrame();
  const { pageArt } = recorded.swipeOptions.mock.calls.at(-1)![0] as {
    pageArt: SharedValue<Readonly<Record<number, BoardArtReadiness>>>;
  };
  pageArt.value = { 0: 'ready', 1: 'ready' };
  flushUiThread();

  act(() => {
    readinessCallbackFor('current')('loading');
    readinessCallbackFor('current')('ready');
  });
  // A JS-side equality guard would discard the final ready event because the
  // cached read has not observed the preceding loading event yet.
  flushUiThread();

  expect(pageArt.value).toEqual({ 0: 'ready', 1: 'ready' });
});

it('prunes removed slots atomically with retained updates in one UI-thread turn', async () => {
  sharedThreads.asynchronous = true;
  const props = { ...baseProps, containerSize: { width: 350, height: 500 }, prevFrames: 'previous' };
  const { rerender } = render(createElement(SwipeBoardCarousel, props));
  await nextFrame();
  const { pageArt } = recorded.swipeOptions.mock.calls.at(-1)![0] as {
    pageArt: SharedValue<Readonly<Record<number, BoardArtReadiness>>>;
  };
  pageArt.value = { '-1': 'ready', 0: 'loading', 1: 'ready' };
  flushUiThread();

  rerender(
    createElement(SwipeBoardCarousel, {
      ...props,
      centerPage: 1,
      prevFrames: 'current',
      currentFrames: 'next',
      nextFrames: 'new-next',
    }),
  );
  // The removed page's prune is queued first. A retained page then reports
  // ready before JS sees that prune; it must not resurrect the removed page.
  act(() => readinessCallbackFor('current')('ready'));
  flushUiThread();

  expect(pageArt.value).toEqual({ 0: 'ready', 1: 'ready' });
});

it('preserves cached readiness when the previous climb refreshes during a forward step', async () => {
  recorded.synchronousArtReadiness = 'ready';
  const props = {
    ...baseProps,
    containerSize: { width: 350, height: 500 },
    currentFrames: 'a',
    nextFrames: 'b',
  };
  const { rerender, getByTestId } = render(createElement(SwipeBoardCarousel, props));
  await nextFrame();
  const previousBoard = getByTestId('board-a');
  const { pageArt } = recorded.swipeOptions.mock.calls.at(-1)![0] as {
    pageArt: SharedValue<Readonly<Record<number, BoardArtReadiness>>>;
  };
  expect(pageArt.value[0]).toBe('ready');

  rerender(
    createElement(SwipeBoardCarousel, {
      ...props,
      centerPage: 1,
      prevFrames: 'refreshed-a',
      currentFrames: 'b',
      nextFrames: 'c',
    }),
  );

  // The same retained page now renders cached refreshed holds. Its descendant
  // reports readiness during commit, before its parent's layout effects run.
  expect(getByTestId('board-refreshed-a')).toBe(previousBoard);
  expect(pageArt.value[0]).toBe('ready');
  expect(pageArt.value[1]).toBe('ready');
  expect(pageArt.value[2]).toBe('ready');
});

it('preserves cached readiness when an empty previous slot gains a climb', async () => {
  recorded.synchronousArtReadiness = 'ready';
  const props = { ...baseProps, containerSize: { width: 350, height: 500 } };
  const { rerender } = render(createElement(SwipeBoardCarousel, props));
  await nextFrame();
  const { pageArt } = recorded.swipeOptions.mock.calls.at(-1)![0] as {
    pageArt: SharedValue<Readonly<Record<number, BoardArtReadiness>>>;
  };
  expect(pageArt.value[-1]).toBe('ready');

  rerender(createElement(SwipeBoardCarousel, { ...props, prevFrames: 'new-previous' }));

  expect(pageArt.value[-1]).toBe('ready');
});

it('keeps cached artwork ready after StrictMode replays slot layout effects', async () => {
  recorded.synchronousArtReadiness = 'ready';
  const props = {
    ...baseProps,
    containerSize: { width: 350, height: 500 },
    prevFrames: 'previous',
  };
  const { unmount } = render(createElement(SwipeBoardCarousel, props), { wrapper: StrictMode });
  await nextFrame();
  const { pageArt } = recorded.swipeOptions.mock.calls.at(-1)![0] as {
    pageArt: SharedValue<Readonly<Record<number, BoardArtReadiness>>>;
  };

  // Child layout effects replay before the parent reclaims page ownership.
  // Their cached display result still has to enable both swipe directions.
  expect(pageArt.value).toEqual({ '-1': 'ready', 0: 'ready', 1: 'ready' });

  const removedBoard = recorded.boardProps.mock.calls.at(-1)![0] as {
    onArtReadinessChange: (readiness: BoardArtReadiness) => void;
  };
  unmount();
  act(() => removedBoard.onArtReadinessChange('ready'));
  expect(pageArt.value).toEqual({});
});

describe.each(['0', '1'])('SwipeBoardCarousel layout (screenshot mode %s)', (screenshotMode) => {
  it('preserves the normal board group and readiness regardless of capture flags', () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', screenshotMode);
    const { getByTestId } = render(createElement(SwipeBoardCarousel, baseProps));
    measure(350, 500);
    const board = getByTestId('board-current');
    const { pageArt } = recorded.swipeOptions.mock.calls.at(-1)![0] as {
      pageArt: SharedValue<Readonly<Record<number, BoardArtReadiness>>>;
    };
    expect(pageArt.value).toEqual({});
    const standIn = getByTestId('play-drawer-board-accessibility');
    expect(standIn.dataset.accessible).toBe('true');
    expect(standIn.dataset.importantForAccessibility).toBeUndefined();
    expect(standIn.dataset.pointerEvents).toBeUndefined();
    expectDimensions(standIn, 250, 500);
    expect(board.parentElement?.parentElement?.dataset.importantForAccessibility).toBe('no-hide-descendants');
    expect(board.dataset.overlayTestid).toBeUndefined();
  });

  it('mounts one current image before geometry, then enables gestures without remounting it', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', screenshotMode);
    const { queryAllByTestId, getByTestId } = render(createElement(SwipeBoardCarousel, baseProps));
    expect(getByTestId('play-drawer-board-container')).toBeTruthy();
    expect(queryAllByTestId(/^board-/)).toHaveLength(1);
    const firstImage = getByTestId('board-current');
    expect(firstImage.dataset.width).toBe('100%');
    expect(firstImage.dataset.height).toBe('100%');
    expect(recorded.swipeOptions).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
    expect(recorded.zoomOptions).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
    expect(recorded.prefetch).not.toHaveBeenCalled();

    measure(350, 0);
    expect(getByTestId('board-current')).toBe(firstImage);
    expect(recorded.prefetch).not.toHaveBeenCalled();

    measure(350, 500);
    expect(getByTestId('board-current')).toBe(firstImage);
    expect(recorded.swipeOptions).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true, boardWidth: 250 }));
    expect(recorded.zoomOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true, containerWidth: 250, containerHeight: 500 }),
    );
    expectDimensions(getByTestId('board-current'), 250, 500);
    // The current board paints first; its neighbour follows a frame later.
    expect(queryAllByTestId('board-next')).toHaveLength(0);
    await nextFrame();
    expectDimensions(getByTestId('board-next'), 250, 500);
    expect(getByTestId('board-current').dataset.renderWidth).toBe('750');
    expect(recorded.prefetch).toHaveBeenLastCalledWith(expect.objectContaining({ renderWidth: 750 }));
    expectDimensions(getByTestId('board-current').parentElement!, 250, 500);
    expectDimensions(getByTestId('board-next').parentElement!, 250, 500);
  });

  it('uses supplied positive geometry on the first frame and resizes without remounting', () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', screenshotMode);
    const props = { ...baseProps, containerSize: { width: 350, height: 500 } };
    const { getByTestId, rerender } = render(createElement(SwipeBoardCarousel, props));
    const image = getByTestId('board-current');
    expectDimensions(image, 250, 500);
    expect(recorded.swipeOptions).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true, boardWidth: 250 }));
    measure(100, 100);
    expectDimensions(image, 250, 500);
    rerender(createElement(SwipeBoardCarousel, { ...props, containerSize: { width: 200, height: 600 } }));
    expect(getByTestId('board-current')).toBe(image);
    expectDimensions(image, 200, 400);
  });

  it('reuses the warmed render width before measurement and forwards opening art only to current', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', screenshotMode);
    rememberPlayOverlayWidth(baseProps, 777);
    const readyBoardArt = { frames: 'current' } as ReadyBoardArtSnapshot;
    const onReadyArtDisplayed = vi.fn();
    const { getByTestId } = render(
      createElement(SwipeBoardCarousel, { ...baseProps, readyBoardArt, onReadyArtDisplayed }),
    );
    expect(getByTestId('board-current').dataset.renderWidth).toBe('777');
    expect(recorded.boardProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        readyBoardArt,
        onReadyArtDisplayed,
        style: { width: '100%', height: '100%', aspectRatio: undefined },
      }),
    );
    measure(350, 500);
    await nextFrame();
    const neighbourProps = recorded.boardProps.mock.calls.filter(([props]) => props.frames === 'next').at(-1)?.[0];
    expect(neighbourProps?.readyBoardArt).toBeUndefined();
    expect(neighbourProps?.onReadyArtDisplayed).toBeUndefined();
  });

  it('resizes a mounted board for rotation or a narrower iPad pane without a placeholder', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', screenshotMode);
    const { getByTestId } = render(createElement(SwipeBoardCarousel, baseProps));
    measure(350, 500);
    await nextFrame();
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

describe('SwipeBoardCarousel pages', () => {
  it('keeps the board that was a neighbour mounted when it becomes the current one', async () => {
    const props = { ...baseProps, prevFrames: null, currentFrames: 'a', nextFrames: 'b' };
    const { getByTestId, queryAllByTestId, rerender } = render(createElement(SwipeBoardCarousel, props));
    measure(350, 500);
    await nextFrame();
    const boardA = getByTestId('board-a');
    const boardB = getByTestId('board-b');

    // A swipe forward: `b` is current now, on the page it was already on.
    rerender(
      createElement(SwipeBoardCarousel, {
        ...props,
        prevFrames: 'a',
        currentFrames: 'b',
        nextFrames: 'c',
        centerPage: 1,
      }),
    );

    expect(getByTestId('board-b')).toBe(boardB);
    expect(getByTestId('board-a')).toBe(boardA);
    expect(queryAllByTestId('board-c')).toHaveLength(1);
  });

  it('draws only the page in the middle at rest, and keeps every board out of the accessibility tree', async () => {
    const props = { ...baseProps, prevFrames: 'a', currentFrames: 'b', nextFrames: 'c' };
    const { getByTestId } = render(createElement(SwipeBoardCarousel, props));
    measure(350, 500);
    await nextFrame();

    const slotOf = (frames: string) => getByTestId(`board-${frames}`).parentElement!.parentElement!;
    expect(slotOf('b').dataset.opacity).toBe('1');
    expect(slotOf('a').dataset.opacity).toBe('0');
    expect(slotOf('c').dataset.opacity).toBe('0');
    for (const frames of ['a', 'b', 'c']) {
      expect(slotOf(frames).dataset.importantForAccessibility).toBe('no-hide-descendants');
      expect(slotOf(frames).dataset.pointerEvents).toBe('none');
    }
  });

  it('keeps one accessibility element across a step, so focus is not left on a board that moved away', async () => {
    const props = { ...baseProps, prevFrames: null, currentFrames: 'a', nextFrames: 'b' };
    const { getByTestId, rerender } = render(createElement(SwipeBoardCarousel, props));
    measure(350, 500);
    await nextFrame();
    const standIn = getByTestId('play-drawer-board-accessibility');

    rerender(
      createElement(SwipeBoardCarousel, {
        ...props,
        prevFrames: 'a',
        currentFrames: 'b',
        nextFrames: 'c',
        centerPage: 1,
      }),
    );

    expect(getByTestId('play-drawer-board-accessibility')).toBe(standIn);
    // Ahead of every board in its parent, so no board that is added or dropped
    // can change where it sits: a view that is put back into its parent loses
    // the touch that began on it.
    expect(standIn.parentElement?.firstElementChild).toBe(standIn);
  });

  it('offers and runs accessible Next and Previous independently of visible arrow buttons', () => {
    const onSwipeNext = vi.fn();
    const onSwipePrevious = vi.fn();
    render(createElement(SwipeBoardCarousel, { ...baseProps, canSwipePrevious: true, onSwipeNext, onSwipePrevious }));
    measure(350, 500);

    expect(recorded.accessibility?.accessibilityRole).toBe('adjustable');
    expect(recorded.accessibility?.accessibilityActions).toEqual([
      { name: 'increment', label: 'mobile.boardAccessibility.next' },
      { name: 'decrement', label: 'mobile.boardAccessibility.previous' },
    ]);
    act(() => recorded.accessibility?.onAccessibilityAction?.({ nativeEvent: { actionName: 'increment' } }));
    act(() => recorded.accessibility?.onAccessibilityAction?.({ nativeEvent: { actionName: 'decrement' } }));
    expect(onSwipeNext).toHaveBeenCalledOnce();
    expect(onSwipePrevious).toHaveBeenCalledOnce();
  });

  // The then-signposts: on the last Up next climb the board's value names
  // what comes after, and the action that crosses into the list says so.
  it('reads the walk as its value and names an action that crosses into the list', () => {
    render(
      createElement(SwipeBoardCarousel, {
        ...baseProps,
        canSwipePrevious: true,
        accessibilityValueText: 'Up next, 4 of 4, then Projects',
        nextActionLabel: 'Next in Projects',
      }),
    );
    measure(350, 500);

    expect(recorded.accessibility?.accessibilityValue).toEqual({ text: 'Up next, 4 of 4, then Projects' });
    expect(recorded.accessibility?.accessibilityActions).toEqual([
      { name: 'increment', label: 'Next in Projects' },
      { name: 'decrement', label: 'mobile.boardAccessibility.previous' },
    ]);
  });

  // VoiceOver reads an adjustable element's value as soon as its increment
  // returns, before the JS thread has changed the climb, and is not told when
  // the value changes after: it would say the climb that left, then the
  // player's announcement of the new one.
  it('gives VoiceOver no value to read stale, leaving the step to its announcement', () => {
    platform.OS = 'ios';
    const onSwipeNext = vi.fn();
    render(
      createElement(SwipeBoardCarousel, {
        ...baseProps,
        accessibilityValueText: 'Low, V4, 4 of 40',
        onSwipeNext,
      }),
    );
    measure(350, 500);
    expect(recorded.accessibility?.accessibilityValue).toBeUndefined();
    // Still adjustable, and the adjust still steps.
    expect(recorded.accessibility?.accessibilityRole).toBe('adjustable');
    act(() => recorded.accessibility?.onAccessibilityAction?.({ nativeEvent: { actionName: 'increment' } }));
    expect(onSwipeNext).toHaveBeenCalledOnce();
  });

  it('has no value off Up next', () => {
    render(createElement(SwipeBoardCarousel, baseProps));
    measure(350, 500);
    expect(recorded.accessibility?.accessibilityValue).toBeUndefined();
  });

  it('does not expose or run accessible navigation while the board is disabled', () => {
    const onSwipeNext = vi.fn();
    const onSwipePrevious = vi.fn();
    render(
      createElement(SwipeBoardCarousel, {
        ...baseProps,
        enabled: false,
        canSwipePrevious: true,
        onSwipeNext,
        onSwipePrevious,
      }),
    );
    measure(350, 500);

    expect(recorded.accessibility?.accessibilityActions).toEqual([]);
    act(() => recorded.accessibility?.onAccessibilityAction?.({ nativeEvent: { actionName: 'increment' } }));
    act(() => recorded.accessibility?.onAccessibilityAction?.({ nativeEvent: { actionName: 'decrement' } }));
    expect(onSwipeNext).not.toHaveBeenCalled();
    expect(onSwipePrevious).not.toHaveBeenCalled();
  });

  it('gives every board the zoom wrapper, so one that stops being current cannot keep a stale zoom', async () => {
    const props = { ...baseProps, prevFrames: 'a', currentFrames: 'b', nextFrames: 'c' };
    const { getByTestId } = render(createElement(SwipeBoardCarousel, props));
    measure(350, 500);
    await nextFrame();

    for (const frames of ['a', 'b', 'c']) {
      expect(getByTestId(`board-${frames}`).parentElement!.dataset.zoomed).toBe('yes');
    }
  });

  // A zIndex that changes re-inserts the native view among its siblings, and that
  // cancels a touch that began on it: a swipe that took over a fling was cut off 3 ms
  // after it started. So the boards share one level, wherever the anchor is.
  it.each([0, 1])('gives all three boards one zIndex with page %i in the middle', async (anchor) => {
    const pager = restingPager();
    (pager.anchorPage as { value: number }).value = anchor;
    const props = { ...baseProps, pager, prevFrames: 'a', currentFrames: 'b', nextFrames: 'c' };
    const { getByTestId } = render(createElement(SwipeBoardCarousel, props));
    measure(350, 500);
    await nextFrame();

    const levels = ['a', 'b', 'c'].map(
      (frames) => getByTestId(`board-${frames}`).parentElement!.parentElement!.dataset.zIndex,
    );
    expect(levels).toEqual(['1', '1', '1']);
  });

  it('gives a neighbour an empty page when this board cannot draw its climb', async () => {
    const props = { ...baseProps, prevFrames: null, currentFrames: 'b', nextFrames: null };
    const { queryAllByTestId } = render(createElement(SwipeBoardCarousel, props));
    measure(350, 500);
    await nextFrame();

    expect(queryAllByTestId(/^board-/)).toHaveLength(1);
  });
});

describe('SwipeBoardCarousel still wall (PNG board)', () => {
  const slotOf = (element: HTMLElement) => element.parentElement!.parentElement!;
  const props = { ...baseProps, prevFrames: 'a', currentFrames: 'b', nextFrames: 'c' };

  it('keeps every board in the middle mid-drag and lets it fade as one picture', async () => {
    const pager = restingPager();
    (pager.translateX as { value: number }).value = -100;
    const { getByTestId } = render(createElement(SwipeBoardCarousel, { ...props, pager }));
    measure(350, 500);
    await nextFrame();

    for (const frames of ['a', 'b', 'c']) {
      const slot = slotOf(getByTestId(`board-${frames}`));
      expect(slot.dataset.translateX).toBe('0');
      expect(slot.dataset.offscreenAlpha).toBe('true');
    }
    // Opacity from the swap's layers: the current climb at rest, as no UI frame ran.
    expect(slotOf(getByTestId('board-b')).dataset.opacity).toBe('1');
    expect(slotOf(getByTestId('board-a')).dataset.opacity).toBe('0');
    expect(slotOf(getByTestId('board-c')).dataset.opacity).toBe('0');
    expect(pager.stationaryMotion.value).toBe(true);
  });

  it('mounts the bare wall after the neighbours, under every board, out of the way at rest', async () => {
    const { getByTestId, queryByTestId, queryAllByTestId } = render(createElement(SwipeBoardCarousel, props));
    measure(350, 500);
    expect(queryByTestId('bare-wall')).toBeNull();
    await nextFrame();
    // The neighbours first, so a first render of the bare wall queues behind theirs.
    expect(queryAllByTestId(/^board-/)).toHaveLength(3);
    expect(queryByTestId('bare-wall')).toBeNull();
    await nextFrame();

    const bareWall = getByTestId('bare-wall');
    const bareWallSlot = slotOf(bareWall);
    expect(bareWallSlot.dataset.opacity).toBe('0');
    expect(bareWallSlot.dataset.pointerEvents).toBe('none');
    expect(bareWallSlot.dataset.importantForAccessibility).toBe('no-hide-descendants');
    // Rides the zoom, like the boards.
    expect(bareWall.parentElement!.dataset.zoomed).toBe('yes');
    const siblings = Array.from(bareWallSlot.parentElement!.children);
    for (const frames of ['a', 'b', 'c']) {
      expect(siblings.indexOf(bareWallSlot)).toBeLessThan(siblings.indexOf(slotOf(getByTestId(`board-${frames}`))));
    }
    const bareWallProps = recorded.boardProps.mock.calls.findLast(([board]) => board.bareWall)?.[0];
    expect(bareWallProps).toMatchObject({ frames: '', bareWall: true, mirrored: false, backgroundVariant: 'full' });
    // Native onDisplay fires at the start of expo-image's fade. Disabling that
    // fade makes readiness mean the veil is whole, before drag dimming can start.
    expect(bareWallProps.suppressOverlayTransition).toBe(true);
    // Never a page: the swipe does not wait for it, and it is not the play surface.
    expect(bareWallProps.playSurface).toBeUndefined();
  });

  it.each([
    ['the kill switch is on', { pngWallFade: false, transition: undefined }],
    ['the lab plays the wipe', { pngWallFade: true, transition: { revealMode: 'wipe' as const } }],
  ])('slides the whole board again when %s', async (_reason, { pngWallFade, transition }) => {
    recorded.pngWallFade = pngWallFade;
    const pager = restingPager();
    (pager.translateX as { value: number }).value = -100;
    const { getByTestId, queryByTestId } = render(createElement(SwipeBoardCarousel, { ...props, pager, transition }));
    measure(350, 500);
    // Two frames: long enough for the bare wall to have mounted, were it wanted.
    await nextFrame();
    await nextFrame();

    expect(queryByTestId('bare-wall')).toBeNull();
    const current = slotOf(getByTestId('board-b'));
    expect(Number(current.dataset.translateX)).toBeLessThan(0);
    expect(current.dataset.offscreenAlpha).toBe('false');
    expect(Number(slotOf(getByTestId('board-c')).dataset.opacity)).toBeGreaterThan(0);
    expect(pager.stationaryMotion.value).toBe(false);
  });
});

it.each([false, true])(
  'passes the host ground to all displayed boards, and prefetches PNGs only off the GPU, GPU %s',
  async (native) => {
    recorded.motionNative = native;
    render(
      createElement(SwipeBoardCarousel, {
        ...baseProps,
        layoutId: 8,
        sizeId: 25,
        fieldColorOverride: '#1C1C1E',
        prefetchFrames: ['later'],
      }),
    );
    measure(390, 700);
    await nextFrame();
    expect(recorded.boardProps).toHaveBeenCalled();
    for (const [props] of recorded.boardProps.mock.calls) {
      expect(props.fieldColorOverride).toBe('#1C1C1E');
    }
    if (native) {
      // The stationary GPU board shows no PNG on a swipe; the GPU looks ahead itself.
      expect(recorded.prefetch).not.toHaveBeenCalled();
    } else {
      expect(recorded.prefetch).toHaveBeenLastCalledWith(expect.objectContaining({ fieldColorOverride: '#1C1C1E' }));
    }
  },
);

it('exposes a smoke marker outside hidden artwork only after the current holds paint', () => {
  const props = { ...baseProps, currentFrames: 'p1145r15', containerSize: { width: 350, height: 500 } };
  const { queryByTestId, getByTestId, rerender } = render(createElement(SwipeBoardCarousel, props));
  const latestCurrent = () =>
    recorded.boardProps.mock.calls.filter(([board]) => board.frames === props.currentFrames).at(-1)![0] as {
      onArtReadinessChange: (readiness: BoardArtReadiness) => void;
    };
  expect(queryByTestId('play-drawer-board-overlay')).toBeNull();
  const previousReport = latestCurrent().onArtReadinessChange;
  act(() => previousReport('ready'));
  const marker = getByTestId('play-drawer-board-overlay');
  expect(marker.closest('[data-important-for-accessibility="no-hide-descendants"]')).toBeNull();
  rerender(createElement(SwipeBoardCarousel, { ...props, mirrored: true }));
  expect(queryByTestId('play-drawer-board-overlay')).toBeNull();
  act(() => previousReport('ready'));
  expect(queryByTestId('play-drawer-board-overlay')).toBeNull();
  act(() => latestCurrent().onArtReadinessChange('failed'));
  expect(queryByTestId('play-drawer-board-overlay')).toBeNull();
  act(() => latestCurrent().onArtReadinessChange('ready'));
  expect(queryByTestId('play-drawer-board-overlay')).not.toBeNull();
});

it('waits for both GPU presentation and board art before exposing the marker', () => {
  recorded.motionNative = true;
  const props = {
    ...baseProps,
    layoutId: 8,
    currentFrames: 'p4131r42',
    containerSize: { width: 350, height: 500 },
  };
  const { queryByTestId, rerender } = render(createElement(SwipeBoardCarousel, props));
  const first = latestStationaryBoard();
  act(() => first.onArtReadinessChange('ready'));
  expect(queryByTestId('play-drawer-board-overlay')).toBeNull();
  act(() => first.onGpuTransitionStateChange('ready'));
  expect(queryByTestId('play-drawer-board-overlay')).not.toBeNull();

  rerender(createElement(SwipeBoardCarousel, { ...props, mirrored: true }));
  expect(queryByTestId('play-drawer-board-overlay')).toBeNull();
  act(() => {
    first.onGpuTransitionStateChange('ready');
    first.onArtReadinessChange('ready');
  });
  expect(queryByTestId('play-drawer-board-overlay')).toBeNull();
  const mirrored = latestStationaryBoard();
  act(() => {
    mirrored.onGpuTransitionStateChange('ready');
    mirrored.onArtReadinessChange('ready');
  });
  expect(queryByTestId('play-drawer-board-overlay')).not.toBeNull();
});
