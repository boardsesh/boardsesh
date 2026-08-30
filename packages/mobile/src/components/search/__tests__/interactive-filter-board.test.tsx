// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { HoldsFilter } from '@boardsesh/shared-schema';
import type { BoardHoldTarget } from '../../../lib/create-board-holds';

// Controls the mocked zoom hook so each test can assert the zoomed-only chrome
// (pan overlay + reset button) without driving real gestures.
const zoomState = vi.hoisted(() => ({
  isZoomed: false,
  resetZoom: vi.fn(),
  scaleSV: { value: 1 },
  translateXSV: { value: 0 },
  translateYSV: { value: 0 },
  containerWidthSV: { value: 400 },
  containerHeightSV: { value: 500 },
}));

type ChildrenProps = { children?: ReactNode };
type StyleProps = ChildrenProps & { style?: unknown };

vi.mock('react-native', () => ({
  View: ({ children }: StyleProps) => createElement('div', null, children),
  Pressable: ({ children, onPress }: StyleProps & { onPress?: () => void }) =>
    createElement('button', { 'data-pressable': 'true', onClick: onPress }, children),
  StyleSheet: {
    create: (styles: Record<string, unknown>) => styles,
    absoluteFill: { position: 'absolute' },
  },
}));

vi.mock('react-native-reanimated', () => ({
  // Animated.View → plain div; the zoom style is irrelevant to behaviour here.
  default: { View: ({ children }: StyleProps) => createElement('div', { 'data-animated': 'true' }, children) },
  runOnJS: (handler: (...args: unknown[]) => unknown) => handler,
}));

vi.mock('react-native-gesture-handler', () => {
  const createGesture = () => {
    const gesture = {
      maxDuration: () => gesture,
      maxDistance: () => gesture,
      minDuration: () => gesture,
      onStart: () => gesture,
      simultaneousWithExternalGesture: () => gesture,
    };
    return gesture;
  };
  return {
    Gesture: {
      Tap: createGesture,
      LongPress: createGesture,
      Exclusive: (...gestures: unknown[]) => ({ gestures }),
    },
    GestureDetector: ({ children, gesture }: ChildrenProps & { gesture?: { zoomedPanOverlay?: boolean } }) =>
      createElement(
        'div',
        { 'data-gesture': 'true', 'data-zoom-pan': gesture?.zoomedPanOverlay ? 'true' : undefined },
        children,
      ),
  };
});

vi.mock('../../play-drawer/use-zoom-pan-gesture', () => ({
  useZoomPanGesture: () => ({
    pinchGesture: {},
    zoomPanGesture: {},
    isZoomed: zoomState.isZoomed,
    resetZoom: zoomState.resetZoom,
    animatedZoomStyle: {},
    // The transform shared values the board forwards through
    // FilterBoardTransformContext. Stand-ins, not real shared values — the
    // renderAboveBoard tests only assert they reach the overlay.
    scaleSV: zoomState.scaleSV,
    translateXSV: zoomState.translateXSV,
    translateYSV: zoomState.translateYSV,
    containerWidthSV: zoomState.containerWidthSV,
    containerHeightSV: zoomState.containerHeightSV,
  }),
}));

// The composed overlay gesture is exercised by holdLayout unit tests + device
// QA; here we only assert the zoomed chrome, so return a placeholder gesture.
vi.mock('../../create-climb/use-zoomed-hold-tap-gesture', () => ({
  useZoomedHoldTapGesture: () => ({ zoomedPanOverlay: true }),
  PAN_ACTIVATION_OFFSET: 8,
}));

vi.mock('../../BoardImageNative', () => ({
  BoardImageNative: () => createElement('div', { 'data-board-image': 'true' }),
}));

// SearchHoldFilterRings is covered by its own test; stub it so this test only
// exercises the InteractiveFilterBoard composition + tap routing.
vi.mock('../SearchHoldFilterRings', () => ({
  SearchHoldFilterRings: () => createElement('div', { 'data-rings': 'true' }),
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: ChildrenProps) => createElement('span', null, children),
}));

// HoldTargetLayer renders a tap button per hold so the test can fire a tap and
// assert it routes back through onHoldTap (wired to onPaint).
type HoldTargetLayerMockProps = {
  holdTargets: BoardHoldTarget[];
  showAllHolds: boolean;
  showHoldMarkers?: boolean;
  onPaint: (id: number) => void;
};
vi.mock('../../create-climb/HoldTargetLayer', () => ({
  HoldTargetLayer: ({ holdTargets, showAllHolds, showHoldMarkers, onPaint }: HoldTargetLayerMockProps) =>
    createElement(
      'div',
      {
        'data-hold-layer': 'true',
        'data-show-all-holds': String(showAllHolds),
        'data-show-hold-markers': String(showHoldMarkers),
      },
      holdTargets.map((hold) =>
        createElement('button', { key: hold.id, 'data-hold-id': hold.id, onClick: () => onPaint(hold.id) }),
      ),
    ),
}));

vi.mock('../../../theme/tokens', () => ({
  overlays: { scrim: 'rgba(0,0,0,0.6)', onScrim: '#FFF' },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { InteractiveFilterBoard } from '../InteractiveFilterBoard';

const holdTargets: BoardHoldTarget[] = [
  { id: 10, cx: 100, cy: 100, r: 20 },
  { id: 20, cx: 200, cy: 200, r: 20 },
];

type Overrides = {
  holdsFilter?: HoldsFilter;
  activeHoldId?: number | null;
  onHoldTap?: (id: number) => void;
  showHoldMarkers?: boolean;
};

function renderBoard(overrides: Overrides = {}) {
  const onHoldTap = overrides.onHoldTap ?? vi.fn();
  const result = render(
    <InteractiveFilterBoard
      boardName="kilter"
      layoutId={1}
      sizeId={10}
      setIds="1,2"
      boardWidth={1000}
      boardHeight={1000}
      holdTargets={holdTargets}
      holdsFilter={overrides.holdsFilter ?? {}}
      activeHoldId={overrides.activeHoldId ?? null}
      onHoldTap={onHoldTap}
      showHoldMarkers={overrides.showHoldMarkers}
      renderWidth={400}
      renderHeight={500}
    />,
  );
  return { ...result, onHoldTap };
}

describe('InteractiveFilterBoard', () => {
  beforeEach(() => {
    zoomState.isZoomed = false;
    zoomState.resetZoom.mockClear();
  });

  it('renders the board image, filter rings, and a tap target per hold', () => {
    const { container } = renderBoard();
    expect(container.querySelector('[data-board-image="true"]')).not.toBeNull();
    expect(container.querySelector('[data-rings="true"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-hold-id]').length).toBe(holdTargets.length);
  });

  it('routes a hold tap to onHoldTap with the hold id', () => {
    const { container, onHoldTap } = renderBoard();
    const tapTarget = container.querySelector('[data-hold-id="20"]') as HTMLButtonElement;
    fireEvent.click(tapTarget);
    expect(onHoldTap).toHaveBeenCalledTimes(1);
    expect(onHoldTap).toHaveBeenCalledWith(20);
  });

  it('can hide visible hold markers while keeping tap targets', () => {
    const { container } = renderBoard({ showHoldMarkers: false });
    const holdLayer = container.querySelector('[data-hold-layer="true"]');
    expect(holdLayer?.getAttribute('data-show-all-holds')).toBe('true');
    expect(holdLayer?.getAttribute('data-show-hold-markers')).toBe('false');
    expect(container.querySelectorAll('[data-hold-id]').length).toBe(holdTargets.length);
  });

  it('hides the pan overlay and reset button while not zoomed', () => {
    const { container } = renderBoard();
    // Only the active-hold chrome would add a Pressable; with no zoom and no
    // active hold there is no reset button.
    expect(container.querySelectorAll('[data-pressable="true"]').length).toBe(0);
  });

  it('shows a reset button that calls resetZoom while zoomed', () => {
    zoomState.isZoomed = true;
    const { container } = renderBoard();
    const resetButton = container.querySelector('[data-pressable="true"]') as HTMLButtonElement;
    expect(resetButton).not.toBeNull();
    fireEvent.click(resetButton);
    expect(zoomState.resetZoom).toHaveBeenCalledTimes(1);
  });

  it('renders an active highlight when a hold is active', () => {
    // The highlight is built only when activeHoldId resolves to a known hold;
    // an unknown id yields none. We assert the known-id path renders without
    // throwing and the unknown-id path is a no-op.
    const known = renderBoard({ activeHoldId: 10 });
    expect(known.container.querySelector('[data-hold-layer="true"]')).not.toBeNull();
    known.unmount();

    const unknown = renderBoard({ activeHoldId: 999 });
    expect(unknown.container.querySelector('[data-hold-layer="true"]')).not.toBeNull();
  });
  it('does not render an above-board overlay unless one is asked for', () => {
    const { container } = renderBoard();
    expect(container.querySelector('[data-above-board="true"]')).toBeNull();
  });

  it('renders renderAboveBoard and hands it the full zoom transform', () => {
    const seen: Record<string, unknown>[] = [];
    const { container } = render(
      <InteractiveFilterBoard
        boardName="kilter"
        layoutId={1}
        sizeId={10}
        setIds="1,2"
        boardWidth={1000}
        boardHeight={1000}
        holdTargets={holdTargets}
        renderWidth={400}
        renderHeight={500}
        renderAboveBoard={(context) => {
          seen.push(context as unknown as Record<string, unknown>);
          return <div data-above-board="true" />;
        }}
      />,
    );
    expect(container.querySelector('[data-above-board="true"]')).not.toBeNull();
    const context = seen[0];
    expect(context.scaleSV).toBe(zoomState.scaleSV);
    expect(context.translateXSV).toBe(zoomState.translateXSV);
    expect(context.translateYSV).toBe(zoomState.translateYSV);
    expect(context.containerWidthSV).toBe(zoomState.containerWidthSV);
    expect(context.containerHeightSV).toBe(zoomState.containerHeightSV);
  });
  it('nests renderAboveBoard inside the pan detector while zoomed, so declined touches fall through', () => {
    // RNGH offers a declined touch to ANCESTORS, never to siblings drawn
    // underneath. If the overlay were a sibling of the pan layer, a finger the
    // outline editor's draw surface fails would reach nothing and one-finger
    // panning would be dead while a hold is selected.
    zoomState.isZoomed = true;
    const { container } = render(
      <InteractiveFilterBoard
        boardName="kilter"
        layoutId={1}
        sizeId={10}
        setIds="1,2"
        boardWidth={1000}
        boardHeight={1000}
        holdTargets={holdTargets}
        renderWidth={400}
        renderHeight={500}
        renderAboveBoard={() => <div data-above-board="true" />}
      />,
    );
    const panDetector = container.querySelector('[data-zoom-pan="true"]');
    expect(panDetector).not.toBeNull();
    expect(panDetector?.querySelector('[data-above-board="true"]')).not.toBeNull();
  });

  it('hands renderAboveBoard a pinchRef so overlays relate to the pinch instead of mounting it', () => {
    // Composing the board's pinch INSTANCE into a second GestureDetector throws
    // "Handler with tag N already exists" in RNGH 2.32 — the ref is the safe
    // handle for simultaneousWithExternalGesture.
    const seen: Record<string, unknown>[] = [];
    render(
      <InteractiveFilterBoard
        boardName="kilter"
        layoutId={1}
        sizeId={10}
        setIds="1,2"
        boardWidth={1000}
        boardHeight={1000}
        holdTargets={holdTargets}
        renderWidth={400}
        renderHeight={500}
        renderAboveBoard={(context) => {
          seen.push(context as unknown as Record<string, unknown>);
          return null;
        }}
      />,
    );
    expect(seen[0].pinchRef).toBeDefined();
  });
});
