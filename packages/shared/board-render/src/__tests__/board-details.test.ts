// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Marco de Jongh

import { describe, it, expect } from 'vitest';
import { getBoardDetails, getBoardDetailsForBoard } from '../board-details';

describe('getBoardDetails (Kilter)', () => {
  const details = getBoardDetails({ board_name: 'kilter', layout_id: 1, size_id: 10, set_ids: [1, 20] });

  it('resolves positive board dimensions', () => {
    expect(details.boardWidth).toBeGreaterThan(0);
    expect(details.boardHeight).toBeGreaterThan(0);
  });

  it('maps one image per requested set', () => {
    expect(Object.keys(details.images_to_holds)).toHaveLength(2);
  });

  it('computes hold placements inside the board edges', () => {
    expect(details.holdsData.length).toBeGreaterThan(0);
    for (const hold of details.holdsData) {
      expect(hold.cx).toBeGreaterThanOrEqual(0);
      expect(hold.cx).toBeLessThanOrEqual(details.boardWidth);
      expect(hold.cy).toBeGreaterThanOrEqual(0);
      expect(hold.cy).toBeLessThanOrEqual(details.boardHeight);
    }
  });

  it('carries board identity and metadata through', () => {
    expect(details.board_name).toBe('kilter');
    expect(details.layout_id).toBe(1);
    expect(details.size_id).toBe(10);
    expect(details.set_ids).toEqual([1, 20]);
    expect(typeof details.size_name).toBe('string');
  });

  it('throws for a size that does not exist', () => {
    expect(() => getBoardDetails({ board_name: 'kilter', layout_id: 1, size_id: 999999, set_ids: [1] })).toThrow();
  });
});

describe('getBoardDetailsForBoard (MoonBoard)', () => {
  const details = getBoardDetailsForBoard({ board_name: 'moonboard', layout_id: 3, size_id: 0, set_ids: [5, 6] });

  it('routes MoonBoard to the grid-based details', () => {
    expect(details.board_name).toBe('moonboard');
    expect(details.layoutFolder).toBe('moonboard2024');
    expect(details.holdSetImages).toEqual(['holdsetd.png', 'holdsete.png']);
  });

  it('resolves positive geometry and grid holds', () => {
    expect(details.boardWidth).toBeGreaterThan(0);
    expect(details.boardHeight).toBeGreaterThan(0);
    expect(details.holdsData.length).toBeGreaterThan(0);
  });

  it('keys images_to_holds by background + hold-set images', () => {
    const keys = Object.keys(details.images_to_holds);
    // Background image plus one entry per selected set.
    expect(keys.length).toBe(3);
  });
});

describe('getBoardDetailsForBoard (Aurora)', () => {
  it('delegates non-MoonBoard boards to getBoardDetails', () => {
    const viaForBoard = getBoardDetailsForBoard({ board_name: 'kilter', layout_id: 1, size_id: 10, set_ids: [1, 20] });
    const direct = getBoardDetails({ board_name: 'kilter', layout_id: 1, size_id: 10, set_ids: [1, 20] });
    expect(viaForBoard.boardWidth).toBe(direct.boardWidth);
    expect(viaForBoard.boardHeight).toBe(direct.boardHeight);
    expect(Object.keys(viaForBoard.images_to_holds)).toEqual(Object.keys(direct.images_to_holds));
  });
});
