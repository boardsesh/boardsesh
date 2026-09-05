// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { describe, it, expect } from 'vitest';
import { WOODS_DIFFICULTY_IDS } from '@boardsesh/board-constants/woods';
import { BOULDER_GRADES, getGradesForBoard } from '../board-data';
import {
  WOODS_ROW_LENGTHS,
  WOODS_GEOMETRY,
  WOODS_HOLD_RADIUS_PX,
  WOODS_SIZES,
  WOODS_SETS,
  WOODS_LAYOUTS,
  WOODS_BOARD_SIZES,
  getWoodsHoldRowColumn,
  getWoodsHoldPosition,
  getWoodsHoldGridPosition,
  getWoodsHoldImagePosition,
  getWoodsHoldZonePosition,
  woodsHoldIdsInZone,
  getWoodsMirroredHoldLocation,
  getWoodsBoardDetails,
  encodeWoodsHoldsToFrames,
  woodsSizeIdToDimension,
  woodsDimensionToSizeId,
} from '../woods-config';

const totalHolds = (size: '8x10' | '12x12') => WOODS_ROW_LENGTHS[size].reduce((sum, length) => sum + length, 0);

describe('WOODS_ROW_LENGTHS', () => {
  // Matches the LED-map entry counts (docs/woods-board-led-maps) and the app's
  // BOARD_ROW_LENGTHS arrays.
  it('totals 485 holds on 8x10 (1×11 + 21×21 + 3×11)', () => {
    expect(totalHolds('8x10')).toBe(485);
    expect(WOODS_ROW_LENGTHS['8x10']).toHaveLength(25);
    expect(Math.max(...WOODS_ROW_LENGTHS['8x10'])).toBe(21);
  });

  it('totals 894 holds on 12x12 (3×17 + 23×33 + 3×17 + 1×17 + 1×16)', () => {
    expect(totalHolds('12x12')).toBe(894);
    expect(WOODS_ROW_LENGTHS['12x12']).toHaveLength(31);
    expect(Math.max(...WOODS_ROW_LENGTHS['12x12'])).toBe(33);
  });
});

describe('board metadata', () => {
  // Mobile's `cleanDimensions` rewrites an ASCII `x` to `×` for display, so the
  // stored name has to stay ASCII or it renders as "8 × × 10".
  it('names the sizes with an ASCII x', () => {
    expect(WOODS_SIZES['8x10'].name).toBe('8 x 10');
    expect(WOODS_SIZES['12x12'].name).toBe('12 x 12');
  });

  // `cleanLayoutName` strips the board label and a bare "Board" from a layout
  // name, so a layout called "Woods Board" would render as an empty string.
  it('names the single layout Original', () => {
    expect(WOODS_LAYOUTS.woods).toEqual({ id: 1, name: 'Original' });
  });

  it('ships exactly one synthetic hold set', () => {
    expect(WOODS_SETS).toEqual([{ id: 1, name: 'Standard' }]);
  });
});

describe('getWoodsHoldRowColumn / getWoodsHoldPosition', () => {
  it.each(WOODS_BOARD_SIZES)('round-trips every baseHoldLocation on %s', (size) => {
    const total = totalHolds(size);
    for (let location = 0; location < total; location++) {
      const rowColumn = getWoodsHoldRowColumn(location, size);
      expect(rowColumn).toBeDefined();
      expect(getWoodsHoldPosition(rowColumn!.row, rowColumn!.column, size)).toBe(location);
    }
  });

  it('returns undefined for a location past the board', () => {
    expect(getWoodsHoldRowColumn(485, '8x10')).toBeUndefined();
    expect(getWoodsHoldRowColumn(894, '12x12')).toBeUndefined();
  });

  it('decomposes the first holds of the 12x12 top row (17 wide)', () => {
    expect(getWoodsHoldRowColumn(0, '12x12')).toEqual({ row: 0, column: 0 });
    expect(getWoodsHoldRowColumn(16, '12x12')).toEqual({ row: 0, column: 16 });
    expect(getWoodsHoldRowColumn(17, '12x12')).toEqual({ row: 1, column: 0 });
  });
});

describe('getWoodsHoldGridPosition (detected positions)', () => {
  it('returns the top row spread across the width (first hold left, last hold right)', () => {
    // Row 0 is 17 wide; detected centres put hold 0 near the left edge and hold 16
    // near the right, both near the top.
    const first = getWoodsHoldGridPosition(0, '12x12')!;
    const last = getWoodsHoldGridPosition(16, '12x12')!;
    expect(first.x).toBeLessThan(0.1);
    expect(last.x).toBeGreaterThan(0.9);
    expect(first.y).toBeLessThan(0.1);
    expect(last.y).toBeLessThan(0.1);
  });

  it('has a position for every hold, all within the unit square', () => {
    for (const size of WOODS_BOARD_SIZES) {
      for (let location = 0; location < totalHolds(size); location++) {
        const grid = getWoodsHoldGridPosition(location, size);
        expect(grid).toBeDefined();
        expect(grid!.x).toBeGreaterThanOrEqual(0);
        expect(grid!.x).toBeLessThanOrEqual(1);
        expect(grid!.y).toBeGreaterThanOrEqual(0);
        expect(grid!.y).toBeLessThanOrEqual(1);
      }
    }
  });

  it('returns undefined for a location past the board', () => {
    expect(getWoodsHoldGridPosition(894, '12x12')).toBeUndefined();
  });
});

describe('getWoodsHoldImagePosition', () => {
  it('scales the detected position by the board-art pixel size', () => {
    const geometry = WOODS_GEOMETRY['12x12'];
    const grid = getWoodsHoldGridPosition(0, '12x12')!;
    const image = getWoodsHoldImagePosition(0, '12x12')!;
    expect(image.cx).toBeCloseTo(grid.x * geometry.width, 5);
    expect(image.cy).toBeCloseTo(grid.y * geometry.height, 5);
  });
});

describe('encodeWoodsHoldsToFrames', () => {
  it('encodes holdList to sorted p{loc}r{code}, dropping Clear', () => {
    const frames = encodeWoodsHoldsToFrames([
      { type: 'Hand', baseHoldLocation: 5 },
      { type: 'Start', baseHoldLocation: 0 },
      { type: 'Clear', baseHoldLocation: 9 },
      { type: 'Finish', baseHoldLocation: 7 },
    ]);
    // Sorted by location: 0=Start(4), 5=Hand(2), 7=Finish(3).
    expect(frames).toBe('p0r4p5r2p7r3');
  });
});

describe('woods size id helpers', () => {
  it('maps size ids to dimensions and back', () => {
    expect(woodsSizeIdToDimension(1)).toBe('8x10');
    expect(woodsSizeIdToDimension(2)).toBe('12x12');
    expect(woodsSizeIdToDimension(99)).toBeUndefined();
    expect(woodsDimensionToSizeId('8x10')).toBe(1);
    expect(woodsDimensionToSizeId('12x12')).toBe(2);
  });
});

describe('getWoodsMirroredHoldLocation', () => {
  it('mirrors a top-row hold across its row (column → rowLength - 1 - column)', () => {
    // 12x12 top row is 17 wide: hold 0 (column 0) mirrors to column 16 (location 16).
    expect(getWoodsMirroredHoldLocation(0, '12x12')).toBe(16);
    expect(getWoodsMirroredHoldLocation(16, '12x12')).toBe(0);
  });

  it('round-trips (mirror of mirror is the original) for every hold', () => {
    for (const size of WOODS_BOARD_SIZES) {
      const total = totalHolds(size);
      for (let location = 0; location < total; location++) {
        const mirrored = getWoodsMirroredHoldLocation(location, size)!;
        expect(getWoodsMirroredHoldLocation(mirrored, size)).toBe(location);
      }
    }
  });

  it('returns undefined for a location past the board', () => {
    expect(getWoodsMirroredHoldLocation(485, '8x10')).toBeUndefined();
  });
});

describe('getWoodsBoardDetails', () => {
  it('builds an 8x10 BoardDetails with one hold per detected centre', () => {
    const details = getWoodsBoardDetails({ size_id: 1 });
    expect(details.board_name).toBe('woods');
    expect(details.layout_id).toBe(1);
    expect(details.size_id).toBe(1);
    expect(details.layout_name).toBe('Original');
    expect(details.size_name).toBe(WOODS_SIZES['8x10'].name);
    // Mirroring is not wired end-to-end (the BLE send path ignores `mirrored`),
    // so the descriptor must not offer it — matching `boardSupportsMirroring`.
    expect(details.supportsMirroring).toBe(false);
    expect(details.boardWidth).toBe(WOODS_GEOMETRY['8x10'].width);
    expect(details.boardHeight).toBe(WOODS_GEOMETRY['8x10'].height);
    expect(details.edge_right).toBe(WOODS_GEOMETRY['8x10'].maxColumns);
    expect(details.edge_top).toBe(WOODS_GEOMETRY['8x10'].numRows);
    // One synthetic set: an empty set list breaks the board builder, the board
    // path parser and the readable-URL round trip.
    expect(details.set_ids).toEqual([1]);
    expect(details.set_names).toEqual(['Standard']);
    expect(Object.keys(details.images_to_holds)).toEqual(['woods-8x10-bg.png']);
    expect(details.holdsData).toHaveLength(totalHolds('8x10'));
  });

  it('builds a 12x12 BoardDetails referencing the .png background key', () => {
    const details = getWoodsBoardDetails({ size_id: 2 });
    expect(details.size_id).toBe(2);
    expect(Object.keys(details.images_to_holds)).toEqual(['woods-12x12-bg.png']);
    expect(details.holdsData).toHaveLength(totalHolds('12x12'));
  });

  it('positions each hold at its image centre and carries the mirror id', () => {
    const details = getWoodsBoardDetails({ size_id: 2 });
    const firstHold = details.holdsData.find((hold) => hold.id === 0)!;
    const image = getWoodsHoldImagePosition(0, '12x12')!;
    expect(firstHold.cx).toBeCloseTo(image.cx, 5);
    expect(firstHold.cy).toBeCloseTo(image.cy, 5);
    expect(firstHold.r).toBe(WOODS_HOLD_RADIUS_PX['12x12']);
    expect(firstHold.mirroredHoldId).toBe(16);
  });

  // The radius is a measured constant, not a cell-size estimate: at 0.42 x the
  // median nearest-neighbour distance (27.1 px on 8x10, 31.8 px on 12x12) the
  // circles stay separated. Anything at or above half the median spacing puts
  // most holds back in contact with a neighbour.
  it('uses per-size hold radii well under half the measured hold spacing', () => {
    expect(WOODS_HOLD_RADIUS_PX['8x10']).toBe(11.5);
    expect(WOODS_HOLD_RADIUS_PX['12x12']).toBe(13.5);
    expect(getWoodsBoardDetails({ size_id: 1 }).holdsData.every((hold) => hold.r === 11.5)).toBe(true);
    expect(getWoodsBoardDetails({ size_id: 2 }).holdsData.every((hold) => hold.r === 13.5)).toBe(true);
  });

  it('throws for an unknown size id', () => {
    expect(() => getWoodsBoardDetails({ size_id: 99 })).toThrow(/Woods board size not found/);
  });
});

describe('getGradesForBoard(woods)', () => {
  it('offers only the 17 difficulty ids a Woods climb can carry', () => {
    const grades = getGradesForBoard('woods');

    expect(grades).toHaveLength(17);
    expect(grades.map((grade) => grade.difficulty_id)).toEqual([
      10, 13, 15, 16, 18, 20, 22, 23, 24, 26, 27, 28, 29, 30, 31, 32, 33,
    ]);
    // Every offered grade is a band the importer actually maps a V number onto —
    // an id in between would be a dead stop on the grade rail.
    for (const grade of grades) {
      expect(WOODS_DIFFICULTY_IDS.has(grade.difficulty_id)).toBe(true);
    }
  });

  it('leaves the other boards on the full ladder', () => {
    expect(getGradesForBoard('kilter')).toEqual(BOULDER_GRADES);
    expect(getGradesForBoard('woods').length).toBeLessThan(BOULDER_GRADES.length);
  });
});

// The board-region ("zone") search box is dragged over the board art and sent to
// the server in the grid space `getWoodsBoardDetails` reports its edges in. The
// client derives a hold's place in that space with `svgToGrid`
// (packages/shared/climb-filters/src/climb-zone-math.ts); the server derives it
// with `getWoodsHoldZonePosition`. These tests pin the two to the same answer —
// see boardsesh/boardsesh#4748.
//
// `svgToGrid` is re-stated here rather than imported so board-config keeps no
// dependency on climb-filters. Its own copy of the formula is pinned against
// Woods-shaped dims in climb-zone-math.test.ts, so a change on either side breaks
// a test.
function svgToGridReference(
  svgX: number,
  svgY: number,
  dims: {
    boardWidth: number;
    boardHeight: number;
    edgeLeft: number;
    edgeRight: number;
    edgeBottom: number;
    edgeTop: number;
  },
): { x: number; y: number } {
  const xSpacing = dims.boardWidth / (dims.edgeRight - dims.edgeLeft);
  const ySpacing = dims.boardHeight / (dims.edgeTop - dims.edgeBottom);
  return {
    x: svgX / xSpacing + dims.edgeLeft,
    y: dims.edgeBottom + (dims.boardHeight - svgY) / ySpacing,
  };
}

describe('getWoodsHoldZonePosition', () => {
  it('scales the detected position onto the board edges, flipping y', () => {
    const geometry = WOODS_GEOMETRY['12x12'];
    const detected = getWoodsHoldGridPosition(0, '12x12')!;
    const zone = getWoodsHoldZonePosition(0, '12x12')!;

    expect(zone.x).toBeCloseTo(detected.x * geometry.maxColumns, 5);
    expect(zone.y).toBeCloseTo((1 - detected.y) * geometry.numRows, 5);
  });

  it('puts the top row high and the bottom row low — the y flip is the easy thing to get wrong', () => {
    const topRowHold = getWoodsHoldZonePosition(0, '8x10')!;
    const bottomRowHold = getWoodsHoldZonePosition(totalHolds('8x10') - 1, '8x10')!;

    expect(topRowHold.y).toBeGreaterThan(bottomRowHold.y);
    expect(topRowHold.y).toBeGreaterThan(WOODS_GEOMETRY['8x10'].numRows * 0.9);
    expect(bottomRowHold.y).toBeLessThan(WOODS_GEOMETRY['8x10'].numRows * 0.15);
  });

  it('agrees with the client grid math over every hold on both sizes', () => {
    for (const size of WOODS_BOARD_SIZES) {
      const details = getWoodsBoardDetails({ size_id: WOODS_SIZES[size].id });
      const dims = {
        boardWidth: details.boardWidth,
        boardHeight: details.boardHeight,
        edgeLeft: details.edge_left,
        edgeRight: details.edge_right,
        edgeBottom: details.edge_bottom,
        edgeTop: details.edge_top,
      };

      for (const hold of details.holdsData) {
        const expected = svgToGridReference(hold.cx, hold.cy, dims);
        const actual = getWoodsHoldZonePosition(hold.id, size)!;
        expect(actual.x).toBeCloseTo(expected.x, 6);
        expect(actual.y).toBeCloseTo(expected.y, 6);
      }
    }
  });

  it('returns undefined for a location past the board', () => {
    expect(getWoodsHoldZonePosition(485, '8x10')).toBeUndefined();
  });
});

describe('woodsHoldIdsInZone', () => {
  const fullBoard = (size: '8x10' | '12x12') => ({
    edgeLeft: 0,
    edgeRight: WOODS_GEOMETRY[size].maxColumns,
    edgeBottom: 0,
    edgeTop: WOODS_GEOMETRY[size].numRows,
  });

  it('returns a subset of the board, ascending and without duplicates', () => {
    for (const size of WOODS_BOARD_SIZES) {
      const box = { ...fullBoard(size), edgeRight: WOODS_GEOMETRY[size].maxColumns / 2 };
      const inside = woodsHoldIdsInZone(WOODS_SIZES[size].id, box)!;

      expect(inside.length).toBeGreaterThan(0);
      expect(inside.length).toBeLessThan(totalHolds(size));
      expect(new Set(inside).size).toBe(inside.length);
      expect([...inside].sort((left, right) => left - right)).toEqual(inside);
    }
  });

  it('returns every hold for a box covering the whole board', () => {
    for (const size of WOODS_BOARD_SIZES) {
      expect(woodsHoldIdsInZone(WOODS_SIZES[size].id, fullBoard(size))).toHaveLength(totalHolds(size));
    }
  });

  it('selects the top strip of the board, not the bottom', () => {
    const size = '8x10';
    const { numRows, maxColumns } = WOODS_GEOMETRY[size];
    const inside = woodsHoldIdsInZone(WOODS_SIZES[size].id, {
      edgeLeft: 0,
      edgeRight: maxColumns,
      edgeBottom: numRows - 2,
      edgeTop: numRows,
    })!;

    // Hold 0 is the leftmost hold of the top row; the last hold is on the floor row.
    expect(inside).toContain(0);
    expect(inside).not.toContain(totalHolds(size) - 1);
    for (const holdId of inside) {
      expect(getWoodsHoldGridPosition(holdId, size)!.y).toBeLessThan(0.15);
    }
  });

  it('keeps a hold sitting exactly on an edge inside the box', () => {
    const size = '12x12';
    const onTheEdge = getWoodsHoldZonePosition(0, size)!;
    const inside = woodsHoldIdsInZone(WOODS_SIZES[size].id, {
      edgeLeft: onTheEdge.x,
      edgeRight: WOODS_GEOMETRY[size].maxColumns,
      edgeBottom: 0,
      edgeTop: onTheEdge.y,
    })!;

    expect(inside).toContain(0);
  });

  it('returns no holds for a box over a bare corner', () => {
    expect(
      woodsHoldIdsInZone(WOODS_SIZES['8x10'].id, { edgeLeft: 0, edgeRight: 0.5, edgeBottom: 0, edgeTop: 0.5 }),
    ).toHaveLength(0);
  });

  it('answers the two sizes independently — the same hold id is a different hold', () => {
    const box = { edgeLeft: 0, edgeRight: 6, edgeBottom: 0, edgeTop: 6 };

    expect(woodsHoldIdsInZone(WOODS_SIZES['8x10'].id, box)).not.toEqual(
      woodsHoldIdsInZone(WOODS_SIZES['12x12'].id, box),
    );
  });

  it('picks the same holds the picker would highlight', () => {
    // The drift guard: run the board details the picker renders through the
    // client's own containment test and expect the same ids back.
    const box = { edgeLeft: 4, edgeRight: 17, edgeBottom: 6, edgeTop: 20 };
    for (const size of WOODS_BOARD_SIZES) {
      const details = getWoodsBoardDetails({ size_id: WOODS_SIZES[size].id });
      const dims = {
        boardWidth: details.boardWidth,
        boardHeight: details.boardHeight,
        edgeLeft: details.edge_left,
        edgeRight: details.edge_right,
        edgeBottom: details.edge_bottom,
        edgeTop: details.edge_top,
      };
      const fromDetails = details.holdsData
        .filter((hold) => {
          const grid = svgToGridReference(hold.cx, hold.cy, dims);
          return grid.x >= box.edgeLeft && grid.x <= box.edgeRight && grid.y >= box.edgeBottom && grid.y <= box.edgeTop;
        })
        .map((hold) => hold.id);

      expect(woodsHoldIdsInZone(WOODS_SIZES[size].id, box)).toEqual(fromDetails);
      expect(fromDetails.length).toBeGreaterThan(0);
    }
  });

  it('returns null for a size id that is not a Woods board, so the caller fails closed', () => {
    expect(woodsHoldIdsInZone(3, { edgeLeft: 0, edgeRight: 10, edgeBottom: 0, edgeTop: 10 })).toBeNull();
  });
});
