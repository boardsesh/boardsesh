// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { describe, it, expect } from 'vitest';
import {
  MOONBOARD_LAYOUTS,
  MOONBOARD_SETS,
  STANDARD_MOONBOARD_GEOMETRY,
  MINI_MOONBOARD_GEOMETRY,
  getMoonBoardGeometry,
  getMoonBoardGeometryByLayoutId,
  getMoonBoardGeometryByFolder,
  getGridPosition,
  getMoonBoardDetails,
  coordinateToHoldId,
  type MoonBoardCoordinate,
} from '../moonboard-config';

describe('MoonBoard per-layout geometry', () => {
  it('uses the Mini geometry for both Mini layouts and the standard geometry otherwise', () => {
    expect(getMoonBoardGeometry('mini-moonboard-2020')).toBe(MINI_MOONBOARD_GEOMETRY);
    expect(getMoonBoardGeometry('mini-moonboard-2025')).toBe(MINI_MOONBOARD_GEOMETRY);
    expect(getMoonBoardGeometry('moonboard-2016')).toBe(STANDARD_MOONBOARD_GEOMETRY);
    expect(getMoonBoardGeometry('moonboard-2024')).toBe(STANDARD_MOONBOARD_GEOMETRY);
  });

  it('resolves geometry by layout id and by board-art folder', () => {
    expect(getMoonBoardGeometryByLayoutId(MOONBOARD_LAYOUTS['mini-moonboard-2020'].id)).toBe(MINI_MOONBOARD_GEOMETRY);
    expect(getMoonBoardGeometryByLayoutId(MOONBOARD_LAYOUTS['moonboard-2016'].id)).toBe(STANDARD_MOONBOARD_GEOMETRY);
    expect(getMoonBoardGeometryByFolder('minimoonboard2025')).toBe(MINI_MOONBOARD_GEOMETRY);
    expect(getMoonBoardGeometryByFolder('moonboard2016')).toBe(STANDARD_MOONBOARD_GEOMETRY);
    // Unknown folder falls back to the standard board.
    expect(getMoonBoardGeometryByFolder('nope')).toBe(STANDARD_MOONBOARD_GEOMETRY);
  });

  it('places the highest row number at the top and the lowest at the bottom', () => {
    // Standard board: row 18 near the top, row 1 near the bottom (SVG y grows down).
    const topStd = getGridPosition(coordinateToHoldId('A18'), STANDARD_MOONBOARD_GEOMETRY);
    const bottomStd = getGridPosition(coordinateToHoldId('A1'), STANDARD_MOONBOARD_GEOMETRY);
    expect(topStd.y).toBeLessThan(bottomStd.y);

    // Mini board: row 12 at the top slot, row 1 at the bottom slot.
    const topMini = getGridPosition(coordinateToHoldId('A12'), MINI_MOONBOARD_GEOMETRY);
    const bottomMini = getGridPosition(coordinateToHoldId('A1'), MINI_MOONBOARD_GEOMETRY);
    expect(topMini.y).toBeLessThan(bottomMini.y);
    // Same row number lands lower on the Mini (12-row) than on the standard (18-row) board.
    expect(topMini.y).toBeGreaterThan(topStd.y);
  });

  it('defaults getGridPosition to the standard geometry (back-compat)', () => {
    expect(getGridPosition(1)).toEqual(getGridPosition(1, STANDARD_MOONBOARD_GEOMETRY));
  });

  it('Mini columns A–K run evenly left-to-right and roughly track the standard 11-wide grid', () => {
    const xs = 'ABCDEFGHIJK'
      .split('')
      .map((col) => getGridPosition(coordinateToHoldId(`${col}10` as MoonBoardCoordinate), MINI_MOONBOARD_GEOMETRY).x);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1]);
    // Outermost columns sit inside the board with margins.
    expect(xs[0]).toBeGreaterThan(0.1);
    expect(xs[xs.length - 1]).toBeLessThan(0.95);
    // The Mini reuses the standard board's horizontal hold spacing, so column A
    // lands within ~1% of the standard board's column A.
    const aStd = getGridPosition(coordinateToHoldId('A10'), STANDARD_MOONBOARD_GEOMETRY).x;
    expect(Math.abs(xs[0] - aStd)).toBeLessThan(0.02);
  });
});

describe('getMoonBoardDetails for Mini layouts', () => {
  it('returns the 650x694 Mini board with its own background and 132 hold slots', () => {
    const details = getMoonBoardDetails({
      layout_id: MOONBOARD_LAYOUTS['mini-moonboard-2020'].id,
      set_ids: [24, 25, 26, 27],
    });
    expect(details.boardWidth).toBe(650);
    expect(details.boardHeight).toBe(694);
    expect(details.edge_right).toBe(11);
    expect(details.edge_top).toBe(12);
    expect(details.holdsData).toHaveLength(11 * 12);
    expect(Object.keys(details.images_to_holds)).toContain('minimoonboard-bg.png');
    expect(Object.keys(details.images_to_holds)).toContain('minimoonboard2020/woodenholds.png');
  });

  it('keeps the standard 650x1000 board at 198 holds', () => {
    const details = getMoonBoardDetails({
      layout_id: MOONBOARD_LAYOUTS['moonboard-2016'].id,
      set_ids: [2],
    });
    expect(details.boardWidth).toBe(650);
    expect(details.boardHeight).toBe(1000);
    expect(details.holdsData).toHaveLength(11 * 18);
    expect(Object.keys(details.images_to_holds)).toContain('moonboard-bg.png');
  });
});

describe('Mini MoonBoard 2025 hold sets', () => {
  it('matches the board art shipped by the MoonBoard app (no plain "Wooden Holds")', () => {
    const files = MOONBOARD_SETS['mini-moonboard-2025'].map((set) => set.imageFile).sort();
    expect(files).toEqual(['holdsetf.png', 'originalschoolholds.png', 'woodenholdsb.png', 'woodenholdsc.png']);
  });
});
