// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
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

vi.mock('../../board-controls/ResetZoomButton', () => ({
  ResetZoomButton: ({ onPress }: { onPress?: () => void }) =>
    createElement('button', { 'data-reset-zoom': 'true', onClick: onPress }),
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
      Race: (...gestures: unknown[]) => ({ gestures }),
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

// The at-rest overlay's arbitration is covered by use-rest-hold-tap-gesture's
// own tests; here we only assert this board wires it (and stops relying on the
// per-hold detectors).
const restTapCalls = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('../../create-climb/use-rest-hold-tap-gesture', () => ({
  useRestHoldTapGesture: (options: Record<string, unknown>) => {
    restTapCalls.push(options);
    return options.onTap ? { composed: 'race' } : null;
  },
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

// HoldTargetLayer is markers only — it takes no handlers and never hit-tests.
// The mock records the props it was handed so a test can assert that.
type HoldTargetLayerMockProps = {
  holdTargets: BoardHoldTarget[];
  showAllHolds: boolean;
  showHoldMarkers?: boolean;
};
const holdLayerProps = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('../../create-climb/HoldTargetLayer', () => ({
  HoldTargetLayer: (props: HoldTargetLayerMockProps & Record<string, unknown>) => {
    holdLayerProps.push(props);
    const { holdTargets: holds, showAllHolds, showHoldMarkers } = props;
    return createElement(
      'div',
      {
        'data-hold-layer': 'true',
        'data-show-all-holds': String(showAllHolds),
        'data-show-hold-markers': String(showHoldMarkers),
      },
      holds.map((hold) => createElement('div', { key: hold.id, 'data-hold-id': hold.id })),
    );
  },
}));

vi.mock('../../../theme/tokens', () => ({
  overlays: { scrim: 'rgba(0,0,0,0.6)', onScrim: '#FFF' },
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { InteractiveFilterBoard, type FilterBoardControls } from '../InteractiveFilterBoard';

const holdTargets: BoardHoldTarget[] = [
  { id: 10, cx: 100, cy: 100, r: 20 },
  { id: 20, cx: 200, cy: 200, r: 20 },
];

type Overrides = {
  holdsFilter?: HoldsFilter;
  activeHoldId?: number | null;
  onHoldTap?: (id: number) => void;
  showHoldMarkers?: boolean;
  controlRef?: { current: FilterBoardControls | null };
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
      controlRef={overrides.controlRef}
    />,
  );
  return { ...result, onHoldTap };
}

describe('InteractiveFilterBoard', () => {
  beforeEach(() => {
    zoomState.isZoomed = false;
    zoomState.resetZoom.mockClear();
    restTapCalls.length = 0;
    holdLayerProps.length = 0;
  });

  it('renders the board image, filter rings, and a marker per hold', () => {
    const { container } = renderBoard();
    expect(container.querySelector('[data-board-image="true"]')).not.toBeNull();
    expect(container.querySelector('[data-rings="true"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-hold-id]').length).toBe(holdTargets.length);
  });

  it('arbitrates at-rest taps through the nearest-hold overlay, not per-hold z-order', () => {
    const { onHoldTap } = renderBoard();
    // The hold layer takes no handlers, so nothing under the overlay hit-tests
    // and z-order can't decide the winner any more (#4496).
    const layerProps = holdLayerProps.at(-1) ?? {};
    for (const gestureProp of ['onPaint', 'onLongPress', 'pinchRef', 'isPinchingSV', 'interactive']) {
      expect(layerProps).not.toHaveProperty(gestureProp);
    }
    const restOptions = restTapCalls.at(-1);
    expect(restOptions?.onTap).toBe(onHoldTap);
    // One hit circle per hold, so the overlay can resolve by distance.
    expect(restOptions?.hitTargets).toHaveLength(holdTargets.length);
    expect(restOptions?.pinchRef).toBeDefined();
  });

  it('can hide the hold markers while the overlay keeps taking taps', () => {
    const { container } = renderBoard({ showHoldMarkers: false });
    const holdLayer = container.querySelector('[data-hold-layer="true"]');
    expect(holdLayer?.getAttribute('data-show-all-holds')).toBe('true');
    expect(holdLayer?.getAttribute('data-show-hold-markers')).toBe('false');
    // The overlay is independent of the markers, so taps keep working.
    expect(restTapCalls.at(-1)?.onTap).toBeDefined();
  });

  it('shows no reset control while not zoomed', () => {
    const { container } = renderBoard();
    expect(container.querySelector('[data-reset-zoom="true"]')).toBeNull();
  });

  it('shows one while zoomed, and pressing it resets', () => {
    // It lives INSIDE the pan overlay so a drag starting on it still pans the
    // board — the corner it sits in is where the panning thumb rests.
    zoomState.isZoomed = true;
    const { container } = renderBoard();
    const control = container.querySelector('[data-reset-zoom="true"]') as HTMLButtonElement;
    expect(control).toBeTruthy();

    control.click();
    expect(zoomState.resetZoom).toHaveBeenCalledTimes(1);
  });

  it('exposes resetZoom through controlRef for callers that drive the zoom', () => {
    const controlRef = { current: null as FilterBoardControls | null };
    renderBoard({ controlRef });
    controlRef.current?.resetZoom();
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
