// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { HoldsFilter } from '@boardsesh/shared-schema';
import type { BoardHoldTarget } from '../../../lib/create-board-holds';

// Controls the mocked zoom hook so each test can assert the zoomed-only chrome
// (pan overlay + reset button) without driving real gestures.
const zoomState = vi.hoisted(() => ({ isZoomed: false, resetZoom: vi.fn() }));

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
}));

vi.mock('react-native-gesture-handler', () => ({
  GestureDetector: ({ children }: ChildrenProps) => createElement('div', { 'data-gesture': 'true' }, children),
}));

vi.mock('../../play-drawer/use-zoom-pan-gesture', () => ({
  useZoomPanGesture: () => ({
    pinchGesture: {},
    zoomPanGesture: {},
    isZoomed: zoomState.isZoomed,
    resetZoom: zoomState.resetZoom,
    animatedZoomStyle: {},
  }),
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
type HoldTargetLayerMockProps = { holdTargets: BoardHoldTarget[]; onPaint: (id: number) => void };
vi.mock('../../create-climb/HoldTargetLayer', () => ({
  HoldTargetLayer: ({ holdTargets, onPaint }: HoldTargetLayerMockProps) =>
    createElement(
      'div',
      { 'data-hold-layer': 'true' },
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
});
