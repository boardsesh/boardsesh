import { describe, expect, it } from 'vitest';
import {
  parseSprayRailSide,
  railDockX,
  railSideAfterDrag,
  sprayTabletPlacement,
  SPRAY_RAIL_MARGIN,
  SPRAY_RAIL_WIDTH,
} from '../spray-tablet-layout';

const edges = { windowWidth: 1180, leftInset: 0, rightInset: 0 };

describe('railDockX', () => {
  it('docks leading to the left edge and trailing to the right, outside the safe area', () => {
    expect(railDockX({ ...edges, side: 'leading' })).toBe(SPRAY_RAIL_MARGIN);
    expect(railDockX({ ...edges, side: 'trailing' })).toBe(1180 - SPRAY_RAIL_MARGIN - SPRAY_RAIL_WIDTH);
    expect(railDockX({ ...edges, leftInset: 20, side: 'leading' })).toBe(20 + SPRAY_RAIL_MARGIN);
    expect(railDockX({ ...edges, rightInset: 20, side: 'trailing' })).toBe(1160 - SPRAY_RAIL_MARGIN - SPRAY_RAIL_WIDTH);
  });
});

describe('railSideAfterDrag', () => {
  it('stays put when let go short of the middle', () => {
    expect(railSideAfterDrag({ ...edges, side: 'leading', translationX: 200 })).toBe('leading');
    expect(railSideAfterDrag({ ...edges, side: 'trailing', translationX: -200 })).toBe('trailing');
  });

  it('switches sides once its centre crosses the middle', () => {
    const toMiddle = 1180 / 2 - (SPRAY_RAIL_MARGIN + SPRAY_RAIL_WIDTH / 2);
    expect(railSideAfterDrag({ ...edges, side: 'leading', translationX: toMiddle - 1 })).toBe('leading');
    expect(railSideAfterDrag({ ...edges, side: 'leading', translationX: toMiddle + 1 })).toBe('trailing');
    expect(railSideAfterDrag({ ...edges, side: 'trailing', translationX: -toMiddle - 1 })).toBe('leading');
  });
});

describe('sprayTabletPlacement', () => {
  it.each([
    ['leading', true, { railEdge: 'left', oppositeEdge: 'right', inspector: 'top', cluster: 'side' }],
    ['trailing', true, { railEdge: 'right', oppositeEdge: 'left', inspector: 'top', cluster: 'side' }],
    ['leading', false, { railEdge: 'left', oppositeEdge: 'right', inspector: 'bottom', cluster: 'centre' }],
    ['trailing', false, { railEdge: 'right', oppositeEdge: 'left', inspector: 'bottom', cluster: 'centre' }],
  ] as const)('rail %s, landscape %s', (railSide, landscape, expected) => {
    expect(sprayTabletPlacement({ railSide, landscape })).toEqual(expected);
  });
});

describe('parseSprayRailSide', () => {
  it('reads a stored side, and anything else as leading', () => {
    expect(parseSprayRailSide('trailing')).toBe('trailing');
    expect(parseSprayRailSide('leading')).toBe('leading');
    expect(parseSprayRailSide(null)).toBe('leading');
    expect(parseSprayRailSide('left')).toBe('leading');
  });
});
