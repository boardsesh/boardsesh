// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { GestureType } from 'react-native-gesture-handler';

const forwardedCarouselProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
const requestFrame = vi.fn();

type ViewMockProps = { children?: ReactNode; testID?: string; style?: unknown };
vi.mock('react-native', () => ({
  View: ({ children, testID }: ViewMockProps) => createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

// Echo the carousel props without mounting its native renderer.
vi.mock('../SwipeBoardCarousel', () => ({
  SwipeBoardCarousel: (props: Record<string, unknown>) => {
    forwardedCarouselProps.current = props;
    const currentFrames = props.currentFrames;
    if (typeof currentFrames !== 'string') throw new Error('SwipeBoardCarousel needs climb frames');
    return createElement('div', {
      'data-testid': 'swipe-board',
      'data-frames': currentFrames,
    });
  },
}));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: { fill: 'fill' } }) }));

import { DeferredBoard } from '../DeferredBoard';
import type { SwipePager } from '../use-swipe-pager';
import type { ReadyBoardArtSnapshot } from '../../../lib/board-render/ready-board-art';

const baseProps = {
  layoutReady: true,
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
  // Passed straight through to the carousel, which is mocked here.
  pager: {} as SwipePager,
  centerPage: 0,
};

describe('DeferredBoard', () => {
  beforeEach(() => {
    requestFrame.mockClear();
    forwardedCarouselProps.current = null;
    vi.stubGlobal('requestAnimationFrame', requestFrame);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('mounts the current board immediately before layout readiness, without scheduling a frame', () => {
    const { getByTestId, queryByTestId } = render(
      createElement(DeferredBoard, {
        ...baseProps,
        open: true,
        layoutReady: false,
      }),
    );
    expect(getByTestId('swipe-board').dataset.frames).toBe('p1145r15');
    expect(queryByTestId('deferred-board-placeholder')).toBeNull();
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it('forwards geometry, artwork, readiness callback and dismiss ref unchanged', () => {
    const dismissRef = { current: undefined as GestureType | undefined };
    const containerSize = { width: 300, height: 500 };
    const readyBoardArt = { quality: 'full' } as ReadyBoardArtSnapshot;
    const onReadyArtDisplayed = vi.fn();
    render(
      createElement(DeferredBoard, {
        ...baseProps,
        open: true,
        dismissRef,
        containerSize,
        readyBoardArt,
        onReadyArtDisplayed,
      }),
    );
    expect(forwardedCarouselProps.current).toMatchObject({
      dismissRef,
      containerSize,
      readyBoardArt,
      onReadyArtDisplayed,
    });
  });

  it('keeps the current board mounted across layout readiness, geometry and climb changes', () => {
    const { getByTestId, rerender } = render(
      createElement(DeferredBoard, { ...baseProps, open: true, layoutReady: false }),
    );
    const carousel = getByTestId('swipe-board');
    rerender(
      createElement(DeferredBoard, {
        ...baseProps,
        open: true,
        currentFrames: 'p9r12',
        boardRenderData: { boardWidth: 1200, boardHeight: 1200 },
        containerSize: { width: 300, height: 500 },
      }),
    );
    expect(getByTestId('swipe-board')).toBe(carousel);
    expect(carousel.dataset.frames).toBe('p9r12');
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it('withholds a closed board and opens the newly selected climb immediately', () => {
    const { queryByTestId, getByTestId, rerender } = render(createElement(DeferredBoard, { ...baseProps, open: true }));
    rerender(createElement(DeferredBoard, { ...baseProps, open: false }));
    expect(queryByTestId('swipe-board')).toBeNull();
    expect(getByTestId('deferred-board-placeholder')).toBeTruthy();
    rerender(createElement(DeferredBoard, { ...baseProps, open: true, currentFrames: 'p77r15' }));
    expect(getByTestId('swipe-board').dataset.frames).toBe('p77r15');
    expect(requestFrame).not.toHaveBeenCalled();
  });
});
