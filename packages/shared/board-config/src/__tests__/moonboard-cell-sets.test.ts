// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { describe, it, expect } from 'vitest';
import { MOONBOARD_LAYOUTS, MOONBOARD_SETS, type MoonBoardLayoutKey } from '../moonboard-config';
import {
  MOONBOARD_CELL_SETS,
  parseHoldIdsFromFrames,
  requiredSetIdsForMoonBoard,
  moonBoardCellSet,
} from '../moonboard-cell-sets';

// layout id -> the set ids defined for that layout in MOONBOARD_SETS.
const setIdsByLayoutId = new Map<number, Set<number>>(
  Object.entries(MOONBOARD_LAYOUTS).map(([key, layout]) => [
    layout.id,
    new Set(MOONBOARD_SETS[key as MoonBoardLayoutKey].map((set) => set.id)),
  ]),
);

// Covered-cell counts measured by sampling the per-set art (the generator).
// Pinned here so a regression in the committed map or the art is caught in CI.
const EXPECTED_COVERED_CELLS: Record<number, number> = {
  1: 40,
  2: 140,
  3: 198,
  4: 198,
  5: 198,
  6: 120,
  7: 128,
};

// The whole feature hinges on telling optional add-on sets (wooden holds /
// screw-on feet) apart from base holds. Pin the per-layout count of cells owned
// by an optional set so a regression in the art or the sampler is caught.
const OPTIONAL_SET_NAME = /wooden|screw/i;
const optionalSetIdsByLayoutId = new Map<number, Set<number>>(
  Object.entries(MOONBOARD_LAYOUTS).map(([key, layout]) => [
    layout.id,
    new Set(
      MOONBOARD_SETS[key as MoonBoardLayoutKey].filter((set) => OPTIONAL_SET_NAME.test(set.name)).map((s) => s.id),
    ),
  ]),
);
const EXPECTED_OPTIONAL_CELLS: Record<number, number> = { 1: 0, 2: 0, 3: 78, 4: 32, 5: 80, 6: 80, 7: 48 };

describe('MoonBoard cell -> set map', () => {
  it('covers every layout with the expected number of cells', () => {
    const layoutIds = Object.keys(MOONBOARD_CELL_SETS)
      .map(Number)
      .sort((a, b) => a - b);
    expect(layoutIds).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const layoutId of layoutIds) {
      expect(Object.keys(MOONBOARD_CELL_SETS[layoutId]).length).toBe(EXPECTED_COVERED_CELLS[layoutId]);
    }
  });

  it('only maps cells to sets that exist for that layout', () => {
    for (const [layoutIdStr, cells] of Object.entries(MOONBOARD_CELL_SETS)) {
      const validSetIds = setIdsByLayoutId.get(Number(layoutIdStr));
      expect(validSetIds).toBeDefined();
      for (const setId of Object.values(cells)) {
        expect(validSetIds!.has(setId)).toBe(true);
      }
    }
  });

  it('keeps optional add-on sets (wooden / screw-on) on their own cells', () => {
    for (const [layoutId, expected] of Object.entries(EXPECTED_OPTIONAL_CELLS)) {
      const optionalIds = optionalSetIdsByLayoutId.get(Number(layoutId))!;
      const count = Object.values(MOONBOARD_CELL_SETS[Number(layoutId)]).filter((setId) =>
        optionalIds.has(setId),
      ).length;
      expect(count).toBe(expected);
    }
  });
});

describe('requiredSetIdsForMoonBoard', () => {
  it('parses hold ids from a frames string', () => {
    expect(parseHoldIdsFromFrames('p1r42p17r43p198r44')).toEqual([1, 17, 198]);
    expect(parseHoldIdsFromFrames('')).toEqual([]);
  });

  it('returns only base sets for a climb that avoids wooden holds', () => {
    // MoonBoard 2024 (layout 3): cells 1 and 9 are Hold Set D (set 5).
    expect(moonBoardCellSet(3, 1)).toBe(5);
    expect(moonBoardCellSet(3, 9)).toBe(5);
    expect(requiredSetIdsForMoonBoard(3, 'p1r42p9r43')).toEqual([5]);
  });

  it('includes the wooden-holds set when the climb uses a wooden cell', () => {
    // MoonBoard 2024 (layout 3): cell 2 is Wooden Holds (set 8), cell 17 is
    // Wooden Holds C (set 10).
    expect(moonBoardCellSet(3, 2)).toBe(8);
    expect(moonBoardCellSet(3, 17)).toBe(10);
    expect(requiredSetIdsForMoonBoard(3, 'p1r42p2r43p17r44')).toEqual([5, 8, 10]);
  });

  it('dedupes and sorts the required sets', () => {
    expect(requiredSetIdsForMoonBoard(3, 'p2r42p2r43')).toEqual([8]);
  });

  it('ignores uncovered holds while keeping the covered ones', () => {
    // cell 1 -> set 5 (covered), cell 999 -> uncovered (contributes nothing).
    expect(moonBoardCellSet(3, 999)).toBeUndefined();
    expect(requiredSetIdsForMoonBoard(3, 'p1r42p999r43')).toEqual([5]);
  });

  it('returns an empty array for an unknown layout', () => {
    expect(requiredSetIdsForMoonBoard(999, 'p1r42')).toEqual([]);
  });
});
