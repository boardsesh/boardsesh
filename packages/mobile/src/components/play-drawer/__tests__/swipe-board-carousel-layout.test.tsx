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
};

const recorded = vi.hoisted(() => ({
  onLayout: undefined as ViewProps['onLayout'],
  prefetch: vi.fn(),
  swipeOptions: vi.fn(),
  zoomOptions: vi.fn(),
  boardProps: vi.fn(),
  synchronousArtReadiness: undefined as BoardArtReadiness | undefined,
}));

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
    View: ({ children, onLayout, testID, style, accessible, importantForAccessibility, pointerEvents }: ViewProps) => {
      if (testID === 'play-drawer-board-container') recorded.onLayout = onLayout;
      const dimensions = flattenStyle(style);
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
  const { useRef } = await import('react');
  return {
    default: { View },
    useAnimatedStyle: (factory: () => unknown) => factory(),
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
      'data-testid': `board-${frames}`,
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
  recorded.onLayout = undefined;
  _resetPlayBoardPrewarmForTests();
  recorded.prefetch.mockClear();
  recorded.swipeOptions.mockClear();
  recorded.zoomOptions.mockClear();
  recorded.boardProps.mockClear();
  recorded.synchronousArtReadiness = undefined;
  sharedThreads.asynchronous = false;
  sharedThreads.onUiThread = false;
  sharedThreads.uiJobs.length = 0;
  sharedThreads.synchronizeJsReads.length = 0;
  vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '0');
});
afterEach(() => vi.unstubAllEnvs());

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
  it('exposes the painted-overlay descendant only in screenshot mode and preserves the normal board group', () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', screenshotMode);
    const { getByTestId, queryByTestId } = render(createElement(SwipeBoardCarousel, baseProps));
    measure(350, 500);
    const board = getByTestId('board-current');
    const { pageArt } = recorded.swipeOptions.mock.calls.at(-1)![0] as {
      pageArt?: SharedValue<Readonly<Record<number, BoardArtReadiness>>>;
    };
    if (screenshotMode === '1') {
      expect(pageArt).toBeUndefined();
      expect(board.parentElement?.dataset.accessible).toBe('false');
      expect(board.parentElement?.dataset.importantForAccessibility).toBe('no');
      expect(board.dataset.overlayTestid).toBe('play-drawer-board-overlay');
      expect(queryByTestId('play-drawer-board-accessibility')).toBeNull();
    } else {
      expect(pageArt?.value).toEqual({});
      // One fixed stand-in is the accessibility element, the size of the board.
      // The boards themselves change places on a swipe and are hidden from it.
      const standIn = getByTestId('play-drawer-board-accessibility');
      expect(standIn.dataset.accessible).toBe('true');
      expect(standIn.dataset.importantForAccessibility).toBeUndefined();
      // It takes touches, or exploring by touch with a screen reader on cannot find the board.
      expect(standIn.dataset.pointerEvents).toBeUndefined();
      expectDimensions(standIn, 250, 500);
      expect(board.parentElement?.parentElement?.dataset.importantForAccessibility).toBe('no-hide-descendants');
      expect(board.dataset.overlayTestid).toBeUndefined();
    }
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
    if (screenshotMode === '0') {
      expect(recorded.prefetch).toHaveBeenLastCalledWith(expect.objectContaining({ renderWidth: 750 }));
      // The image and the zoom wrapper both carry explicit dimensions. The slot
      // around them fills the container and centres them.
      expectDimensions(getByTestId('board-current').parentElement!, 250, 500);
      expectDimensions(getByTestId('board-next').parentElement!, 250, 500);
    } else {
      expect(recorded.prefetch).not.toHaveBeenCalled();
    }
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

it("keeps screenshot mode's plain board mounted across a step, so the wall photo never drops", async () => {
  vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
  const props = { ...baseProps, prevFrames: null, currentFrames: 'a', nextFrames: 'b' };
  const { getByTestId, queryAllByTestId, rerender } = render(createElement(SwipeBoardCarousel, props));
  measure(350, 500);
  await nextFrame();
  const plainBoard = getByTestId('board-a');
  expect(plainBoard.dataset.overlayTestid).toBe('play-drawer-board-overlay');

  // A swipe forward. The plain board changes climb by a prop; it is not one of the pages.
  rerender(
    createElement(SwipeBoardCarousel, {
      ...props,
      prevFrames: 'a',
      currentFrames: 'b',
      nextFrames: 'c',
      centerPage: 1,
    }),
  );

  const current = queryAllByTestId('board-b').filter((board) => board.dataset.overlayTestid);
  expect(current).toEqual([plainBoard]);
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
