// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { LitUpHoldsMap } from '@boardsesh/shared-schema';

type ChildrenProps = { children?: ReactNode };

vi.mock('react-native', () => ({
  View: ({ children }: ChildrenProps) => createElement('div', null, children),
  Pressable: ({ children }: ChildrenProps) => createElement('button', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {} },
  PixelRatio: { get: () => 3 },
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: ChildrenProps) => createElement('div', null, children) },
}));
vi.mock('react-native-gesture-handler', () => ({
  GestureDetector: ({ children }: ChildrenProps) => createElement('div', null, children),
  GestureHandlerRootView: ({ children }: ChildrenProps) => createElement('div', null, children),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../theme/tokens', () => ({ overlays: { scrim: 'rgba(0,0,0,0.4)' }, spacing: { 2: 8 } }));
// Stubbed so the suite doesn't pull the real Icon (and @expo/vector-icons' Flow
// source) in through the board's zoomed chrome.
vi.mock('../../board-controls/ResetZoomButton', () => ({
  ResetZoomButton: ({ onPress }: { onPress?: () => void }) =>
    createElement('button', { 'data-reset-zoom': 'true', onClick: onPress }),
}));
vi.mock('../../Text', () => ({ Text: ({ children }: ChildrenProps) => createElement('span', null, children) }));
vi.mock('../../play-drawer/use-zoom-pan-gesture', () => ({
  useZoomPanGesture: () => ({
    pinchGesture: {},
    zoomPanGesture: {},
    isZoomed: false,
    isPinchingSV: { value: false },
    scaleSV: { value: 1 },
    translateXSV: { value: 0 },
    translateYSV: { value: 0 },
    containerWidthSV: { value: 0 },
    containerHeightSV: { value: 0 },
    resetZoom: () => {},
    animatedZoomStyle: {},
  }),
}));
vi.mock('../use-zoomed-hold-tap-gesture', () => ({ useZoomedHoldTapGesture: () => ({}), PAN_ACTIVATION_OFFSET: 8 }));

// The board image records what it was handed: this test is about which layer
// each mark lands in, and BoardImageNative owns the slot between the two.
const boardImageProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock('../../BoardImageNative', () => ({
  BoardImageNative: (props: Record<string, unknown>) => {
    boardImageProps.current = props;
    return createElement('div', { 'data-testid': 'board-image' }, props.underOverlay as ReactNode);
  },
}));
const holdTargetLayerProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock('../HoldTargetLayer', () => ({
  HoldTargetLayer: (props: Record<string, unknown>) => {
    holdTargetLayerProps.current = props;
    return createElement('div', { 'data-testid': 'hold-targets' });
  },
}));
vi.mock('../HoldMarkerLayer', () => ({
  HoldMarkerLayer: () => createElement('div', { 'data-testid': 'hold-markers' }),
}));
vi.mock('../PaintedHoldsLayer', () => ({
  PaintedHoldsLayer: () => createElement('div', { 'data-testid': 'painted-holds' }),
}));

import { InteractiveCreateBoard } from '../InteractiveCreateBoard';

const BOARD_PROPS = {
  frames: 'p1r12',
  boardName: 'kilter' as const,
  layoutId: 1,
  sizeId: 10,
  setIds: '26,27',
  boardWidth: 1080,
  boardHeight: 1080,
  holdTargets: [{ id: 1, cx: 100, cy: 200, r: 20 }],
  litUpHoldsMap: {} as LitUpHoldsMap,
  onPaint: () => {},
  onLongPressHold: () => {},
  renderWidth: 360,
  renderHeight: 360,
};

describe('InteractiveCreateBoard layer order', () => {
  it('draws the discoverability dots under the rendered holds, not over them', () => {
    const { getByTestId } = render(createElement(InteractiveCreateBoard, { ...BOARD_PROPS, showAllHolds: true }));

    // The marks go in the board image's under-overlay slot. Above the overlay a
    // dot would sit in the middle of a lit hold's fill and its role glyph.
    expect(getByTestId('board-image').querySelector('[data-testid="hold-markers"]')).not.toBeNull();
    // ...and the tap targets, which have to stay on top to catch the touch,
    // carry no dot of their own.
    expect(holdTargetLayerProps.current?.showHoldMarkers).toBe(false);
    expect(holdTargetLayerProps.current?.showAllHolds).toBe(true);
  });

  it('keeps the caller overlay under the holds too, where its own contract puts it', () => {
    const { getByTestId } = render(
      createElement(InteractiveCreateBoard, {
        ...BOARD_PROPS,
        overlay: createElement('div', { 'data-testid': 'heatmap' }),
      }),
    );

    expect(getByTestId('board-image').querySelector('[data-testid="heatmap"]')).not.toBeNull();
  });

  it('turns the veil off and asks for a retained frame, so an edit never blanks the climb', () => {
    render(createElement(InteractiveCreateBoard, BOARD_PROPS));

    expect(boardImageProps.current?.frames).toBe('p1r12');
    expect(boardImageProps.current?.retainPreviousOverlay).toBe(true);
    // No wash on an editing board: Aura's glow lands on the wall as it is, so
    // the unlit holds the climber still has to find stay readable.
    expect(boardImageProps.current?.maxVeilOpacity).toBe(0);
  });

  it("does not force the small-surface filled style, so the editor mirrors the climber's own mark style", () => {
    render(createElement(InteractiveCreateBoard, BOARD_PROPS));

    // filledStyle routes the render through settings.thumbnailStyle instead of
    // the climber's markStyle — that's the accessory-thumbnail treatment, not
    // this full-size editor. Left unset here so Aura fill only shows when the
    // climber's own settings ask for it.
    expect(boardImageProps.current?.filledStyle).toBeUndefined();
  });
});
