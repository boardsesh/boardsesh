// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { HoldsFilter } from '@boardsesh/shared-schema';
import type { BoardHoldTarget } from '../../../lib/create-board-holds';

// Mock the RN host components down to plain DOM so the ring markers are
// queryable. `holdGeometry` is a pure function and runs for real.
type ViewMockProps = {
  children?: ReactNode;
  pointerEvents?: string;
  style?: unknown;
};

function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>((acc, part) => ({ ...acc, ...flattenStyle(part) }), {});
  }
  if (style && typeof style === 'object') return style as Record<string, unknown>;
  return {};
}

vi.mock('react-native', () => ({
  View: ({ children, style }: ViewMockProps) => {
    const flat = flattenStyle(style);
    return createElement(
      'div',
      {
        'data-view': 'true',
        'data-border-color': flat.borderColor ?? '',
        'data-bg': flat.backgroundColor ?? '',
        'data-border-width': flat.borderWidth ?? '',
      },
      children,
    );
  },
  StyleSheet: {
    create: (styles: Record<string, unknown>) => styles,
    absoluteFill: { position: 'absolute' },
  },
}));

type SvgMockProps = {
  children?: ReactNode;
  stroke?: string;
  fill?: string;
  fillOpacity?: number;
  strokeWidth?: number;
};

function svgShape(name: string) {
  return ({ stroke, fill, fillOpacity, strokeWidth }: SvgMockProps) =>
    createElement(name, {
      'data-svg-shape': name,
      'data-stroke': stroke ?? '',
      'data-fill': fill ?? '',
      'data-fill-opacity': fillOpacity ?? '',
      'data-stroke-width': strokeWidth ?? '',
    });
}

vi.mock('react-native-svg', () => ({
  default: ({ children }: SvgMockProps) => createElement('svg', { 'data-svg': 'true' }, children),
  Circle: svgShape('circle'),
  Polygon: svgShape('polygon'),
  Rect: svgShape('rect'),
}));

import { SearchHoldFilterRings } from '../SearchHoldFilterRings';

const holdTargets: BoardHoldTarget[] = [
  { id: 10, cx: 100, cy: 100, r: 20 },
  { id: 20, cx: 200, cy: 200, r: 20 },
  { id: 30, cx: 300, cy: 300, r: 20 },
];

function renderRings(holdsFilter: HoldsFilter, measuredWidth = 400) {
  return render(
    <SearchHoldFilterRings
      boardName="kilter"
      holdsFilter={holdsFilter}
      holdTargets={holdTargets}
      boardWidth={1000}
      boardHeight={1000}
      measuredWidth={measuredWidth}
      mirrored={false}
    />,
  );
}

// A "ring" is either a circle View or an SVG marker with a non-zero stroke
// width; the exclude scrim has a fill and no stroke, so this isolates the
// concentric type rings.
function ringCount(container: HTMLElement): number {
  const svgRingCount = Array.from(container.querySelectorAll('[data-svg-shape]')).filter(
    (node) => Number(node.getAttribute('data-stroke-width') ?? 0) > 0,
  ).length;
  const viewRingCount = Array.from(container.querySelectorAll('[data-view]')).filter(
    (node) => Number(node.getAttribute('data-border-width') ?? 0) > 0 && !!node.getAttribute('data-border-color'),
  ).length;
  return svgRingCount + viewRingCount;
}

function hasExcludeScrim(container: HTMLElement): boolean {
  const hasSvgScrim = Array.from(container.querySelectorAll('[data-svg-shape]')).some(
    (node) => node.getAttribute('data-fill') === '#000000' && node.getAttribute('data-fill-opacity') === '0.55',
  );
  const hasViewScrim = Array.from(container.querySelectorAll('[data-view]')).some(
    (node) => node.getAttribute('data-bg') === 'rgba(0, 0, 0, 0.55)',
  );
  return hasSvgScrim || hasViewScrim;
}

describe('SearchHoldFilterRings', () => {
  it('renders no rings when the filter is empty', () => {
    const { container } = renderRings({});
    expect(ringCount(container)).toBe(0);
    expect(hasExcludeScrim(container)).toBe(false);
  });

  it('renders one ring per active type on a filtered hold', () => {
    const { container } = renderRings({ '10': { STARTING: 'include', HAND: 'include' } });
    expect(ringCount(container)).toBe(2);
    expect(hasExcludeScrim(container)).toBe(false);
  });

  it('draws an exclude scrim on a hold with any exclude filter', () => {
    const { container } = renderRings({ '20': { FOOT: 'exclude' } });
    expect(ringCount(container)).toBe(1);
    expect(hasExcludeScrim(container)).toBe(true);
  });

  it('skips holds whose id is not in the board targets', () => {
    const { container } = renderRings({ '999': { HAND: 'include' } });
    expect(ringCount(container)).toBe(0);
  });

  it('renders nothing until the board is measured (measuredWidth <= 0)', () => {
    const { container } = renderRings({ '10': { HAND: 'include' } }, 0);
    expect(ringCount(container)).toBe(0);
  });

  it('aggregates rings across multiple filtered holds', () => {
    const { container } = renderRings({
      '10': { STARTING: 'include' },
      '20': { HAND: 'include', FINISH: 'include' },
    });
    expect(ringCount(container)).toBe(3);
  });
});
