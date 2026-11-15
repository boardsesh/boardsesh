// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { centeredZoomViewport } from '../../play-drawer/zoom-viewport-clamp';

type PointerEvent = { x: number; y: number; absoluteX?: number; absoluteY?: number };
type ViewProps = { children?: ReactNode; testID?: string; style?: unknown };
const signals = vi.hoisted(() => ({
  tap: undefined as undefined | ((event: PointerEvent) => void),
  longPress: undefined as undefined | ((event: PointerEvent) => void),
  zoomOptions: vi.fn(),
}));
const flatten = (style: unknown): Record<string, unknown> =>
  Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : ((style as Record<string, unknown>) ?? {});
const surface = ({ children, testID, style }: ViewProps) =>
  createElement('div', { 'data-testid': testID, 'data-style': JSON.stringify(flatten(style)) }, children);

vi.mock('react-native', () => ({
  View: (props: ViewProps) => surface(props),
  StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
  PixelRatio: { get: () => 3 },
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: (props: ViewProps) => surface(props) },
  useDerivedValue: (factory: () => number) => ({
    get value() {
      return factory();
    },
  }),
  runOnJS: (callback: unknown) => callback,
}));
vi.mock('react-native-gesture-handler', () => {
  function gesture(kind: 'tap' | 'longPress') {
    const builder = {
      maxDuration: () => builder,
      maxDistance: () => builder,
      minDuration: () => builder,
      simultaneousWithExternalGesture: () => builder,
      onStart: (callback: (event: PointerEvent) => void) => {
        signals[kind] = callback;
        return builder;
      },
    };
    return builder;
  }
  return {
    Gesture: {
      Tap: () => gesture('tap'),
      LongPress: () => gesture('longPress'),
      Race: (...members: unknown[]) => members,
    },
    GestureDetector: ({ children }: ViewProps) => children,
    GestureHandlerRootView: ({ children }: ViewProps) => children,
  };
});
vi.mock('../../play-drawer/use-zoom-pan-gesture', () => ({
  useZoomPanGesture: (options: { viewport?: { offsetX: number; offsetY: number } }) => {
    signals.zoomOptions(options);
    return {
      pinchGesture: {},
      zoomPanGesture: {},
      isZoomed: true,
      isPinchingSV: { value: false },
      scaleSV: { value: 2 },
      translateXSV: { value: 0 },
      translateYSV: { value: 0 },
      containerWidthSV: { value: 300 },
      containerHeightSV: { value: 400 },
      viewportOffsetXSV: { value: options.viewport?.offsetX ?? 0 },
      viewportOffsetYSV: { value: options.viewport?.offsetY ?? 0 },
      resetZoom: vi.fn(),
      animatedZoomStyle: { transform: [{ scale: 2 }] },
    };
  },
}));
vi.mock('../use-rest-hold-tap-gesture', () => ({ useRestHoldTapGesture: () => null }));
vi.mock('../../BoardImageNative', () => ({ BoardImageNative: () => null }));
vi.mock('../../board-controls/ResetZoomButton', () => ({ ResetZoomButton: () => null }));
vi.mock('../PaintedHoldsLayer', () => ({ PaintedHoldsLayer: () => null }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8 } }));

import { InteractiveCreateBoard } from '../InteractiveCreateBoard';

const viewport = centeredZoomViewport(390, 400, 300, 400);
const holdTargets = [
  { id: 10, cx: 70, cy: 200, r: 10 },
  { id: 20, cx: 230, cy: 200, r: 10 },
];
function mountBoard(mirrored = false) {
  const onPaint = vi.fn();
  const onLongPressHold = vi.fn();
  const result = render(
    createElement(InteractiveCreateBoard, {
      frames: 'p10r43',
      boardName: 'kilter',
      layoutId: 8,
      sizeId: 25,
      setIds: '26,27,28,29',
      boardWidth: 300,
      boardHeight: 400,
      renderWidth: 300,
      renderHeight: 400,
      holdTargets,
      litUpHoldsMap: {},
      viewport,
      mirrored,
      onPaint,
      onLongPressHold,
    }),
  );
  return { ...result, onPaint, onLongPressHold };
}
beforeEach(() => {
  signals.zoomOptions.mockClear();
  signals.tap = undefined;
  signals.longPress = undefined;
});

describe('create board full-width zoom viewport', () => {
  it('clips to the full stage while preserving the fitted board size and offset', () => {
    const { getByTestId } = mountBoard();
    expect(JSON.parse(getByTestId('create-board-viewport').dataset.style!)).toMatchObject({
      width: 390,
      height: 400,
      overflow: 'hidden',
    });
    expect(JSON.parse(getByTestId('create-board-render-box').dataset.style!)).toMatchObject({
      width: 300,
      height: 400,
      left: 45,
      top: 0,
    });
    expect(signals.zoomOptions.mock.lastCall?.[0]).toMatchObject({
      viewport,
      containerWidth: 300,
      containerHeight: 400,
    });
  });

  it.each([false, true])('paints and opens the correct role in both widened side bands (mirrored=%s)', (mirrored) => {
    const { onPaint, onLongPressHold } = mountBoard(mirrored);
    // At 2x, x=70 and x=230 are drawn at 35 and 355 in the full viewport.
    // Both are outside the resting image's [45,345] band.
    act(() => signals.tap?.({ x: 35, y: 200 }));
    act(() => signals.tap?.({ x: 355, y: 200 }));
    expect(onPaint.mock.calls).toEqual(mirrored ? [[20], [10]] : [[10], [20]]);
    act(() => signals.longPress?.({ x: 35, y: 200, absoluteX: 35, absoluteY: 500 }));
    expect(onLongPressHold).toHaveBeenCalledWith(mirrored ? 20 : 10, { x: 35, y: 500 });
  });
});
