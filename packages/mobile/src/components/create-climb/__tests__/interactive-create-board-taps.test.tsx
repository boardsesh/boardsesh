// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { BoardHoldTarget } from '../../../lib/create-board-holds';

// What this test is about: which gesture surface the create board mounts at each
// zoom level, and what it hands that surface. The overlays' own arbitration is
// covered by use-rest-hold-tap-gesture / use-zoomed-hold-tap-gesture.

const zoomState = vi.hoisted(() => ({ isZoomed: false, resetZoom: vi.fn() }));
const restTapCalls = vi.hoisted(() => [] as Record<string, unknown>[]);
const zoomedTapCalls = vi.hoisted(() => [] as Record<string, unknown>[]);

type ChildrenProps = { children?: ReactNode };

vi.mock('react-native', () => ({
  View: ({ children }: ChildrenProps) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: { position: 'absolute' } },
  PixelRatio: { get: () => 3 },
}));

vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: ChildrenProps) => createElement('div', { 'data-animated': 'true' }, children) },
}));

vi.mock('react-native-gesture-handler', () => ({
  GestureDetector: ({ children }: ChildrenProps) => createElement('div', { 'data-gesture': 'true' }, children),
  GestureHandlerRootView: ({ children }: ChildrenProps) => createElement('div', { 'data-rngh-root': 'true' }, children),
}));

vi.mock('../../play-drawer/use-zoom-pan-gesture', () => ({
  useZoomPanGesture: () => ({
    pinchGesture: {},
    zoomPanGesture: {},
    isZoomed: zoomState.isZoomed,
    isPinching: false,
    isPinchingSV: { value: false },
    scaleSV: { value: 1 },
    translateXSV: { value: 0 },
    translateYSV: { value: 0 },
    containerWidthSV: { value: 300 },
    containerHeightSV: { value: 400 },
    resetZoom: zoomState.resetZoom,
    animatedZoomStyle: {},
  }),
}));

vi.mock('../use-rest-hold-tap-gesture', () => ({
  useRestHoldTapGesture: (options: Record<string, unknown>) => {
    restTapCalls.push(options);
    return options.onTap ? { composed: 'race' } : null;
  },
}));
vi.mock('../use-zoomed-hold-tap-gesture', () => ({
  useZoomedHoldTapGesture: (options: Record<string, unknown>) => {
    zoomedTapCalls.push(options);
    return { composed: 'zoomed' };
  },
  PAN_ACTIVATION_OFFSET: 8,
}));

// Renders its under-overlay slot, because that is where the board puts the
// discoverability dots (under the rendered holds — see #4978). A mock that
// drops the slot would hide the marker layer from this suite entirely.
vi.mock('../../BoardImageNative', () => ({
  BoardImageNative: ({ underOverlay }: { underOverlay?: ReactNode }) =>
    createElement('div', { 'data-board-image': 'true' }, underOverlay),
}));
// Stubbed so the suite doesn't pull the real Icon (and @expo/vector-icons' Flow
// source) in through the board's zoomed chrome.
vi.mock('../../board-controls/ResetZoomButton', () => ({
  ResetZoomButton: ({ onPress }: { onPress?: () => void }) =>
    createElement('button', { 'data-reset-zoom': 'true', onClick: onPress }),
}));
vi.mock('../HoldMarkerLayer', () => ({
  HoldMarkerLayer: () => createElement('div', { 'data-hold-markers': 'true' }),
}));
// The board no longer imports this. Mocked anyway so the "no per-hold layer"
// assertion below is a real probe: if it is ever mounted again, it shows up.
vi.mock('../HoldTargetLayer', () => ({
  HoldTargetLayer: () => createElement('div', { 'data-hold-layer': 'true' }),
}));
vi.mock('../PaintedHoldsLayer', () => ({
  PaintedHoldsLayer: () => createElement('div', { 'data-painted': 'true' }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8 } }));

import { InteractiveCreateBoard } from '../InteractiveCreateBoard';

const holdTargets: BoardHoldTarget[] = [
  { id: 10, cx: 100, cy: 100, r: 20 },
  { id: 20, cx: 120, cy: 100, r: 8 },
];

function renderBoard(onPaint = vi.fn(), onLongPressHold = vi.fn()) {
  const result = render(
    <InteractiveCreateBoard
      frames="p1r12"
      boardName="kilter"
      layoutId={1}
      sizeId={10}
      setIds="1,2"
      boardWidth={1000}
      boardHeight={1000}
      holdTargets={holdTargets}
      litUpHoldsMap={{}}
      onPaint={onPaint}
      onLongPressHold={onLongPressHold}
      renderWidth={300}
      renderHeight={400}
    />,
  );
  return { ...result, onPaint, onLongPressHold };
}

describe('InteractiveCreateBoard hold taps', () => {
  beforeEach(() => {
    zoomState.isZoomed = false;
    zoomState.resetZoom.mockClear();
    restTapCalls.length = 0;
    zoomedTapCalls.length = 0;
  });

  it('mounts no per-hold hit-testing layer, so nothing competes with the overlay', () => {
    // HoldTargetLayer used to sit here with one inflated square per hold
    // (max(ringDiameter * 1.6, 44) px). They overlap at fit-to-screen and
    // overlapping siblings resolve by z-order, so the last hold in the list won
    // every touch inside its square (#4496). The dots it drew live in
    // HoldMarkerLayer now, under the rendered holds and with no gesture at all.
    const { container } = renderBoard();
    expect(container.querySelector('[data-board-image="true"]')).not.toBeNull();
    expect(container.querySelector('[data-hold-markers="true"]')).not.toBeNull();
    expect(container.querySelector('[data-hold-layer="true"]')).toBeNull();
  });

  it('feeds the at-rest overlay one hit circle per hold plus both hold handlers', () => {
    const { onPaint, onLongPressHold } = renderBoard();
    const restOptions = restTapCalls.at(-1);
    expect(restOptions?.onTap).toBe(onPaint);
    expect(restOptions?.onLongPress).toBe(onLongPressHold);
    expect(restOptions?.hitTargets).toHaveLength(holdTargets.length);
    // Same circles the zoomed overlay resolves against, so both zoom levels
    // agree on which hold a point belongs to.
    expect(zoomedTapCalls.at(-1)?.hitTargets).toBe(restOptions?.hitTargets);
    // The pinch relation is what keeps a two-finger zoom alive while a finger
    // rests on the overlay.
    expect(restOptions?.pinchRef).toBeDefined();
    expect(restOptions?.isPinchingSV).toBeDefined();
  });

  it('swaps the at-rest overlay for the pan overlay once zoomed', () => {
    const notZoomed = renderBoard();
    // No reset button at rest — it mounts with the pan overlay.
    expect(notZoomed.container.querySelectorAll('[data-reset-zoom="true"]').length).toBe(0);
    const restCount = notZoomed.container.querySelectorAll('[data-gesture="true"]').length;
    notZoomed.unmount();

    zoomState.isZoomed = true;
    const zoomed = renderBoard();
    expect(zoomed.container.querySelectorAll('[data-reset-zoom="true"]').length).toBe(1);
    // Still one overlay: the zoomed pan replaces the at-rest tap surface rather
    // than stacking on top of it.
    expect(zoomed.container.querySelectorAll('[data-gesture="true"]').length).toBe(restCount);
  });
});
