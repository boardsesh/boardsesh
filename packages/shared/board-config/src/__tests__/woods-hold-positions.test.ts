// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

// Structural invariants for the CV-detected Woods hold centres.
//
// `WOODS_HOLD_POSITIONS` is generated from the Woods app's board art by a hold-
// centre detector (scripts/extract-woods-hold-positions.py), so a re-run can
// silently shift, drop or double up a centre. These checks pin the properties the
// renderer relies on: one entry per hold in the row table, contiguous
// baseHoldLocations, and a row-major reading order (x rightwards within a row,
// rows descending down the board). A regenerated table that breaks any of them
// would draw a climb's holds in the wrong places without failing anything else.
//
// Lives here rather than in board-constants (where the data is generated) because
// the row table it cross-checks against — WOODS_ROW_LENGTHS — is in this package,
// and board-constants must not depend on board-config.
import { describe, it, expect } from 'vitest';
import { WOODS_HOLD_POSITIONS, WOODS_BOARD_SIZES, type WoodsBoardSize } from '@boardsesh/board-constants/woods';
import { WOODS_GEOMETRY, WOODS_ROW_LENGTHS } from '../woods-config';

// The detector rounds to 5 decimals, so rows are never perfectly level. 0.005 of
// the board height (~5 px on 8x10, ~7 px on 12x12) is well under the ~0.03 row
// pitch — enough slack for detection jitter, not enough to hide a swapped row.
const ROW_OVERLAP_TOLERANCE = 0.005;

// How close two hold centres have to land, in board-art PIXELS, before they
// count as the same detection. Measured in pixels rather than compared as
// coordinate strings because the defect is visual: the rendered radius is 11.5 px
// (8×10) / 13.5 px (12×12), so a pair 1 px apart draws as one hold just as
// surely as a pair at the identical coordinate — and a string check scored those
// as clean, which is how 8 of the 8×10 near-duplicates went unpinned.
const COINCIDENT_EPSILON_PX = 2;

// Near-coincident pairs the CV pass currently emits, as measured on the shipped
// table. Pinned as an upper bound: a re-extraction may only ever reduce these.
// Raising a number here means the new table renders MORE holds on top of each
// other than the one shipped.
const COINCIDENT_PAIR_BUDGET: Record<WoodsBoardSize, number> = {
  '8x10': 24,
  '12x12': 17,
};

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

  it('does not detect more coincident hold centres than the shipped table', () => {
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

    expect(coincidentPairs).toBeLessThanOrEqual(COINCIDENT_PAIR_BUDGET[size]);
  });
});
