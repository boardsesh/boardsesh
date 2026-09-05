import { describe, it, expect } from 'vitest';
import {
  WOODS_HOLD_POSITIONS,
  WOODS_OCCUPIED_HOLD_IDS,
  WOODS_BOARD_SIZES,
  type WoodsBoardSize,
} from '@boardsesh/board-constants/woods';
import { WOODS_GEOMETRY, WOODS_ROW_LENGTHS, getWoodsHoldImagePosition } from '../woods-config';

// Independent row-table and artwork checks: ordering alone let the old detector
// move mounting slots onto neighbouring holds without any test failing.
const ROW_OVERLAP_TOLERANCE = 0.005;
const COINCIDENT_EPSILON_PX = 2;

const rowRanges = (size: WoodsBoardSize): Array<{ start: number; end: number }> => {
  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (const length of WOODS_ROW_LENGTHS[size]) {
    ranges.push({ start, end: start + length });
    start += length;
  }
  return ranges;
};

describe.each(WOODS_BOARD_SIZES)('WOODS_HOLD_POSITIONS[%s]', (size) => {
  const positions = WOODS_HOLD_POSITIONS[size];
  const locations = Object.keys(positions).map(Number);
  const holdCount = WOODS_ROW_LENGTHS[size].reduce((sum, length) => sum + length, 0);

  it('has one entry per hold in the row table, keyed 0..n-1 with no gaps', () => {
    expect(locations).toHaveLength(holdCount);
    // A gap would silently shift every later hold onto the wrong row, since
    // baseHoldLocation is a cumulative index across rows.
    expect(locations.every((location, index) => location === index)).toBe(true);
  });

  it('keeps every coordinate inside the board art', () => {
    for (const location of locations) {
      const [x, y] = positions[location];
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1);
    }
  });

  it('reads left to right within each row', () => {
    for (const { start, end } of rowRanges(size)) {
      for (let location = start + 1; location < end; location++) {
        expect(positions[location][0]).toBeGreaterThanOrEqual(positions[location - 1][0]);
      }
    }
  });

  it('reads top to bottom across rows', () => {
    let previousRowBottom = -Infinity;
    for (const { start, end } of rowRanges(size)) {
      const ys = [];
      for (let location = start; location < end; location++) ys.push(positions[location][1]);
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(previousRowBottom - ROW_OVERLAP_TOLERANCE);
      previousRowBottom = Math.max(...ys);
    }
  });

  it('never collapses two mounting slots onto the same hold centre', () => {
    const { width, height } = WOODS_GEOMETRY[size];
    // Normalised (0..1) → the board-art pixel space the holds are drawn in, so
    // the threshold is the same distance the eye sees.
    const centres = locations.map((location) => ({
      x: positions[location][0] * width,
      y: positions[location][1] * height,
    }));

    let coincidentPairs = 0;
    for (let first = 0; first < centres.length; first++) {
      for (let second = first + 1; second < centres.length; second++) {
        const dx = centres[first].x - centres[second].x;
        const dy = centres[first].y - centres[second].y;
        if (Math.hypot(dx, dy) < COINCIDENT_EPSILON_PX) coincidentPairs++;
      }
    }

    expect(coincidentPairs).toBe(0);
  });
});

// Approximate bolt locations read independently from the lossless artwork.
// A 1px tolerance admits the five-decimal serialization, not a neighbouring
// mounting slot. These include all reported starting holds and the inset feet.
describe('Woods artwork landmarks (#4971)', () => {
  it.each([
    ['8x10', 0, 42, 34],
    ['8x10', 11, 42, 94],
    ['8x10', 31, 667, 94],
    ['8x10', 452, 42, 781],
    ['8x10', 484, 667, 906],
    ['12x12', 51, 46, 245],
    ['12x12', 722, 431, 945],
    ['12x12', 730, 711, 945],
    ['12x12', 803, 956, 1015],
    ['12x12', 805, 1026, 1015],
    ['12x12', 807, 1096, 1015],
    ['12x12', 878, 81, 1330],
    ['12x12', 892, 1061, 1330],
    ['12x12', 893, 1131, 1330],
  ] as const)('%s placement %i stays on its own hold', (size, placementId, expectedX, expectedY) => {
    const position = getWoodsHoldImagePosition(placementId, size)!;
    expect(Math.abs(position.cx - expectedX)).toBeLessThan(1);
    expect(Math.abs(position.cy - expectedY)).toBeLessThan(1);
  });

  it.each(WOODS_BOARD_SIZES)('records only physical holds as silhouette seeds on %s', (size) => {
    const occupied = WOODS_OCCUPIED_HOLD_IDS[size];
    expect(new Set(occupied).size).toBe(occupied.length);
    expect(occupied).toHaveLength(size === '8x10' ? 379 : 725);
    for (const id of occupied) expect(WOODS_HOLD_POSITIONS[size][id]).toBeDefined();
  });

  it('keeps the empty slot beside the large 12x12 rail out of its outline', () => {
    expect(WOODS_HOLD_POSITIONS['12x12'][808]).toBeDefined();
    expect(WOODS_OCCUPIED_HOLD_IDS['12x12']).not.toContain(808);
    expect(WOODS_OCCUPIED_HOLD_IDS['12x12']).toEqual(expect.arrayContaining([807, 809]));
  });

  it('includes photographed 8x10 holds even when the catalog has no climbs using them', () => {
    expect(WOODS_OCCUPIED_HOLD_IDS['8x10']).toEqual(expect.arrayContaining([25, 112, 131]));
  });
});
