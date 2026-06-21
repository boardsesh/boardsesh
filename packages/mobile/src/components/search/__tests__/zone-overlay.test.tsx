// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { ZoneBoxInput } from '@boardsesh/shared-schema';
import type { BoardDimensions } from '@boardsesh/climb-filters';

const haptics = vi.hoisted(() => ({ selection: vi.fn() }));

// The overlay's correctness under test is its a11y wiring + commit math, not the
// reanimated host views. Render Animated.View as a div that forwards the a11y
// props + action handler so increment/decrement can be triggered.
type AnimatedViewProps = {
  children?: ReactNode;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityRole?: string;
  onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
};
function AnimatedViewMock({
  children,
  accessibilityLabel,
  accessibilityHint,
  accessibilityRole,
  onAccessibilityAction,
}: AnimatedViewProps) {
  return createElement(
    'div',
    {
      'data-role': accessibilityRole ?? '',
      'data-label': accessibilityLabel ?? '',
      'data-hint': accessibilityHint ?? '',
      'data-has-action': onAccessibilityAction ? 'true' : 'false',
      onClick: (event: { detail?: number }) => {
        // detail 1 → increment, detail -1 → decrement (encoded by the test).
        onAccessibilityAction?.({
          nativeEvent: { actionName: event.detail === 2 ? 'decrement' : 'increment' },
        });
      },
    },
    children,
  );
}

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {}, hairlineWidth: 1 },
}));

vi.mock('react-native-reanimated', () => ({
  default: { View: AnimatedViewMock },
  useAnimatedStyle: () => ({}),
  useSharedValue: (initial: number) => ({ value: initial }),
  runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
}));

vi.mock('react-native-gesture-handler', () => {
  const chainable: Record<string, () => unknown> = {};
  const builder = new Proxy(chainable, { get: () => () => builder });
  return {
    GestureDetector: ({ children }: { children?: ReactNode }) =>
      createElement('div', { 'data-gesture': 'true' }, children),
    Gesture: { Pan: () => builder, Simultaneous: () => builder },
  };
});

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { elevatedSurface: '#FFF' } }),
}));

vi.mock('../../../lib/haptics', () => ({ hapticSelection: () => haptics.selection() }));

import { ZoneOverlay, type ZoneCornerLabels } from '../ZoneOverlay';

const DIMS: BoardDimensions = {
  boardWidth: 1000,
  boardHeight: 1000,
  edgeLeft: 0,
  edgeRight: 100,
  edgeBottom: 0,
  edgeTop: 100,
};

const ZONE: ZoneBoxInput = { edgeLeft: 20, edgeRight: 80, edgeBottom: 20, edgeTop: 80 };

const CORNER_LABELS: ZoneCornerLabels = {
  nw: 'Top-left corner',
  ne: 'Top-right corner',
  sw: 'Bottom-left corner',
  se: 'Bottom-right corner',
};

function renderOverlay() {
  const onCommit = vi.fn<(box: ZoneBoxInput) => void>();
  const pinch = {} as never;
  const result = render(
    <ZoneOverlay
      zoneBox={ZONE}
      dims={DIMS}
      renderWidth={500}
      renderHeight={500}
      zoomScale={{ value: 1 } as never}
      onCommit={onCommit}
      boardPinch={pinch}
      brandColor="#6D28D9"
      scrimColor="rgba(0,0,0,0.4)"
      bodyLabel="Board region"
      bodyHint="Swipe up or down to move the region across the board."
      cornerLabels={CORNER_LABELS}
      cornerHint="Swipe up or down to grow or shrink the region from this corner."
    />,
  );
  return { ...result, onCommit };
}

function adjustables(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('[data-role="adjustable"]')) as HTMLElement[];
}

function byLabel(container: HTMLElement, label: string): HTMLElement {
  const match = adjustables(container).find((node) => node.getAttribute('data-label') === label);
  if (!match) throw new Error(`no adjustable with label "${label}"`);
  return match;
}

describe('ZoneOverlay', () => {
  beforeEach(() => {
    haptics.selection.mockClear();
  });

  it('renders the body plus four corner handles as adjustable a11y elements', () => {
    const { container } = renderOverlay();
    const nodes = adjustables(container);
    // 1 body + 4 corners.
    expect(nodes).toHaveLength(5);
    expect(byLabel(container, 'Board region')).toBeTruthy();
    expect(byLabel(container, 'Top-left corner')).toBeTruthy();
    expect(byLabel(container, 'Bottom-right corner')).toBeTruthy();
  });

  it('gives every corner handle a resize accessibility hint (not just the body)', () => {
    const { container } = renderOverlay();
    const cornerHint = 'Swipe up or down to grow or shrink the region from this corner.';
    for (const label of Object.values(CORNER_LABELS)) {
      expect(byLabel(container, label).getAttribute('data-hint')).toBe(cornerHint);
    }
    // The body keeps its own (move) hint.
    expect(byLabel(container, 'Board region').getAttribute('data-hint')).toBe(
      'Swipe up or down to move the region across the board.',
    );
  });

  it('returns null when the board has not been measured yet', () => {
    const { container } = render(
      <ZoneOverlay
        zoneBox={ZONE}
        dims={DIMS}
        renderWidth={0}
        renderHeight={0}
        zoomScale={{ value: 1 } as never}
        onCommit={vi.fn()}
        boardPinch={{} as never}
        brandColor="#6D28D9"
        scrimColor="rgba(0,0,0,0.4)"
        bodyLabel="Board region"
        bodyHint="move"
        cornerLabels={CORNER_LABELS}
        cornerHint="resize"
      />,
    );
    expect(adjustables(container)).toHaveLength(0);
  });

  it('VoiceOver increment on the NE corner grows the box outward (right + top)', () => {
    const { container, onCommit } = renderOverlay();
    fireEvent.click(byLabel(container, 'Top-right corner'), { detail: 1 });
    expect(onCommit).toHaveBeenCalledTimes(1);
    const next = onCommit.mock.calls[0][0];
    // A11Y_STEP = 2: NE grows edgeRight and edgeTop, leaves left/bottom alone.
    expect(next.edgeRight).toBe(82);
    expect(next.edgeTop).toBe(82);
    expect(next.edgeLeft).toBe(20);
    expect(next.edgeBottom).toBe(20);
  });

  it('VoiceOver decrement on the SW corner shrinks the box inward (left + bottom)', () => {
    const { container, onCommit } = renderOverlay();
    fireEvent.click(byLabel(container, 'Bottom-left corner'), { detail: 2 });
    const next = onCommit.mock.calls[0][0];
    // SW decrement: edgeLeft += step, edgeBottom += step (box shrinks).
    expect(next.edgeLeft).toBe(22);
    expect(next.edgeBottom).toBe(22);
    expect(next.edgeRight).toBe(80);
    expect(next.edgeTop).toBe(80);
  });

  it('VoiceOver increment on the body moves the whole box without resizing it', () => {
    const { container, onCommit } = renderOverlay();
    fireEvent.click(byLabel(container, 'Board region'), { detail: 1 });
    const next = onCommit.mock.calls[0][0];
    // All four edges shift by +A11Y_STEP; width/height unchanged.
    expect(next.edgeLeft).toBe(22);
    expect(next.edgeRight).toBe(82);
    expect(next.edgeBottom).toBe(22);
    expect(next.edgeTop).toBe(82);
  });
});
