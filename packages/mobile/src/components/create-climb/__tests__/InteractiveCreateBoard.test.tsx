// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// What this test is about: InteractiveCreateBoard's onInteractionActiveChange
// callback, which CreateDrawer uses to disable its native bottom sheet's own
// pan gesture while the board is zoomed or mid-pinch (see the doc comment on
// the prop). Everything else is mocked to a stub — the gesture composition
// itself is covered by use-zoom-pan-gesture's own tests.

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
  Pressable: ({ children }: { children?: ReactNode }) => createElement('button', null, children),
  PixelRatio: { get: () => 3 },
}));

vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: { children?: ReactNode }) => createElement('div', null, children) },
}));

vi.mock('react-native-gesture-handler', () => ({
  GestureDetector: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  GestureHandlerRootView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('../../BoardImageNative', () => ({ BoardImageNative: () => createElement('div') }));
// Stubbed so the suite doesn't pull the real Icon (and @expo/vector-icons' Flow
// source) in through the board's zoomed chrome.
vi.mock('../../board-controls/ResetZoomButton', () => ({
  ResetZoomButton: () => createElement('button', { 'data-reset-zoom': 'true' }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../theme/tokens', () => ({ overlays: { scrim: '#000', onScrim: '#fff' }, spacing: { 2: 8 } }));
vi.mock('../HoldMarkerLayer', () => ({ HoldMarkerLayer: () => createElement('div') }));
vi.mock('../PaintedHoldsLayer', () => ({ PaintedHoldsLayer: () => createElement('div') }));
vi.mock('../holdLayout', () => ({ buildHoldHitTargets: () => [] }));
vi.mock('../use-zoomed-hold-tap-gesture', () => ({
  useZoomedHoldTapGesture: () => ({}),
  PAN_ACTIVATION_OFFSET: 8,
}));
vi.mock('../use-rest-hold-tap-gesture', () => ({ useRestHoldTapGesture: () => ({}) }));

const zoomPanState = { isZoomed: false, isPinching: false };
let lastUseZoomPanGestureOptions: Record<string, unknown> | null = null;
vi.mock('../../play-drawer/use-zoom-pan-gesture', () => ({
  useZoomPanGesture: (options: Record<string, unknown>) => {
    lastUseZoomPanGestureOptions = options;
    return {
      pinchGesture: {},
      zoomPanGesture: {},
      isZoomed: zoomPanState.isZoomed,
      isPinching: zoomPanState.isPinching,
      isPinchingSV: { value: false },
      scaleSV: { value: 1 },
      translateXSV: { value: 0 },
      translateYSV: { value: 0 },
      containerWidthSV: { value: 100 },
      containerHeightSV: { value: 100 },
      resetZoom: () => {},
      animatedZoomStyle: {},
    };
  },
}));

import { InteractiveCreateBoard } from '../InteractiveCreateBoard';

function renderBoard(onInteractionActiveChange: (active: boolean) => void, scrollRef?: { current: undefined }) {
  return render(
    createElement(InteractiveCreateBoard, {
      frames: 'p1r12',
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 1,
      setIds: '1',
      boardWidth: 1000,
      boardHeight: 1000,
      holdTargets: [],
      litUpHoldsMap: {},
      onPaint: () => {},
      onLongPressHold: () => {},
      renderWidth: 300,
      renderHeight: 300,
      onInteractionActiveChange,
      scrollRef,
    }),
  );
}

describe('InteractiveCreateBoard onInteractionActiveChange', () => {
  beforeEach(() => {
    zoomPanState.isZoomed = false;
    zoomPanState.isPinching = false;
  });

  it('reports inactive at rest', () => {
    const onInteractionActiveChange = vi.fn();
    renderBoard(onInteractionActiveChange);
    expect(onInteractionActiveChange).toHaveBeenLastCalledWith(false);
  });

  it('reports active while zoomed', () => {
    zoomPanState.isZoomed = true;
    const onInteractionActiveChange = vi.fn();
    renderBoard(onInteractionActiveChange);
    expect(onInteractionActiveChange).toHaveBeenLastCalledWith(true);
  });

  it('reports active mid-pinch, before isZoomed has flipped', () => {
    zoomPanState.isPinching = true;
    const onInteractionActiveChange = vi.fn();
    renderBoard(onInteractionActiveChange);
    expect(onInteractionActiveChange).toHaveBeenLastCalledWith(true);
  });

  it('forwards scrollRef to useZoomPanGesture, so the pinch can be declared simultaneous with the surrounding scroll', () => {
    const scrollRef = { current: undefined };
    renderBoard(vi.fn(), scrollRef);
    expect(lastUseZoomPanGestureOptions?.scrollRef).toBe(scrollRef);
  });
});
