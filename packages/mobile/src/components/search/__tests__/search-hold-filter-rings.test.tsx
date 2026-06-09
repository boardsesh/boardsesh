// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { HoldsFilter } from '@boardsesh/shared-schema';
import type { BoardHoldTarget } from '../../../lib/create-board-holds';

// Mock the RN host components down to plain DOM so the ring markers are
// queryable. Each ring/scrim is a <View>, which we surface as a <div> tagging
// its border colour + background so the test can count rings and detect the
// exclude scrim. `holdGeometry` is a pure function and runs for real.
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

// A "ring" is a View carrying a non-empty borderColor; the wrapper + scrim have
// no border colour, so this isolates the concentric type rings.
function ringCount(container: HTMLElement): number {
  return Array.from(container.querySelectorAll('[data-view="true"]')).filter(
    (node) => (node.getAttribute('data-border-color') ?? '') !== '',
  ).length;
}

function hasExcludeScrim(container: HTMLElement): boolean {
  return Array.from(container.querySelectorAll('[data-view="true"]')).some((node) =>
    (node.getAttribute('data-bg') ?? '').startsWith('rgba(0,0,0'),
  );
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
