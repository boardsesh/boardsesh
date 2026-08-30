import { describe, it, expect } from 'vitest';
import type { HoldsFilter } from '@boardsesh/shared-schema';
import {
  gridToSvg,
  svgToGrid,
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

// Woods is code-driven: it has no `board_placements` rows, so its server-side zone
// search re-derives a hold's grid position from the normalised centres in
// `@boardsesh/board-config` (`getWoodsHoldZonePosition`) instead of reading
// `board_holes.x/y`. That only lines up with what the picker sends while this
// conversion stays as it is, so pin it against Woods-shaped dims — the 8x10 board
// art (720×1000 px) over a 21-column × 25-row edge box. The other half of the
// contract lives in board-config's woods-config.test.ts.
// See boardsesh/boardsesh#4748.
describe('svgToGrid on a code-driven board (Woods 8x10)', () => {
  const WOODS_8X10_DIMS: BoardDimensions = {
    boardWidth: 720,
    boardHeight: 1000,
    edgeLeft: 0,
    edgeRight: 21,
    edgeBottom: 0,
    edgeTop: 25,
  };

  it('scales x by the column count and flips y off the board height', () => {
    // A hold detected at (0.05904, 0.03434) of the art — near the top-left.
    const hold = { cx: 0.05904 * 720, cy: 0.03434 * 1000 };
    const grid = svgToGrid(hold.cx, hold.cy, WOODS_8X10_DIMS);

    expect(grid.x).toBeCloseTo(0.05904 * 21, 6);
    expect(grid.y).toBeCloseTo((1 - 0.03434) * 25, 6);
  });

  it('maps the art corners onto the edge box', () => {
    expect(svgToGrid(0, 1000, WOODS_8X10_DIMS)).toEqual({ x: 0, y: 0 });
    expect(svgToGrid(720, 0, WOODS_8X10_DIMS)).toEqual({ x: 21, y: 25 });
  });
});
