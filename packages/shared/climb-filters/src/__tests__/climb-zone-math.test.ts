import { describe, it, expect } from 'vitest';
import type { HoldsFilter } from '@boardsesh/shared-schema';
import {
  gridToSvg,
  pruneHoldsToZone,
  type BoardDimensions,
  type BoardEdges,
  type HoldPositionLookup,
} from '../climb-zone-math';

const EDGES: BoardEdges = {
  edgeLeft: 0,
  edgeRight: 144,
  edgeBottom: 0,
  edgeTop: 156,
};

const DIMS: BoardDimensions = {
  ...EDGES,
  boardWidth: 1080,
  boardHeight: 1170,
};

// Holds are stored in SVG-pixel space, so build the lookup from grid coords
// through gridToSvg — the same adaptation the geometry tests use.
function holdAtGrid(gridX: number, gridY: number): { cx: number; cy: number } {
  const svgPoint = gridToSvg(gridX, gridY, DIMS);
  return { cx: svgPoint.x, cy: svgPoint.y };
}

// Hold 1 inside, hold 2 outside (left of), hold 3 outside (below).
const HOLDS_BY_ID: HoldPositionLookup = new Map([
  [1, holdAtGrid(60, 80)],
  [2, holdAtGrid(10, 80)],
  [3, holdAtGrid(60, 20)],
]);

const ZONE = { edgeLeft: 30, edgeRight: 100, edgeBottom: 40, edgeTop: 120 };

describe('pruneHoldsToZone', () => {
  it('keeps only filters whose hold sits inside the zone', () => {
    const holdsFilter: HoldsFilter = {
      1: { HAND: 'include' },
      2: { FOOT: 'include' },
      3: { STARTING: 'exclude' },
    };
    expect(pruneHoldsToZone(holdsFilter, ZONE, HOLDS_BY_ID, DIMS)).toEqual({
      1: { HAND: 'include' },
    });
  });

  it('returns the original filter unchanged when the zone is null', () => {
    const holdsFilter: HoldsFilter = { 2: { FOOT: 'include' }, 3: { STARTING: 'exclude' } };
    expect(pruneHoldsToZone(holdsFilter, null, HOLDS_BY_ID, DIMS)).toBe(holdsFilter);
  });

  it('returns the original filter unchanged when the zone is undefined', () => {
    const holdsFilter: HoldsFilter = { 2: { FOOT: 'include' } };
    expect(pruneHoldsToZone(holdsFilter, undefined, HOLDS_BY_ID, DIMS)).toBe(holdsFilter);
  });

  it('drops filters whose hold id is missing from the lookup', () => {
    const holdsFilter: HoldsFilter = { 1: { HAND: 'include' }, 999: { FOOT: 'include' } };
    expect(pruneHoldsToZone(holdsFilter, ZONE, HOLDS_BY_ID, DIMS)).toEqual({ 1: { HAND: 'include' } });
  });

  it('returns an empty object when every hold is outside the zone', () => {
    const holdsFilter: HoldsFilter = { 2: { FOOT: 'include' }, 3: { STARTING: 'exclude' } };
    expect(pruneHoldsToZone(holdsFilter, ZONE, HOLDS_BY_ID, DIMS)).toEqual({});
  });
});
