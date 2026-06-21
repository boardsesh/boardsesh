import { describe, expect, it } from 'vitest';
import { getAllLayouts } from '@boardsesh/board-constants/product-sizes';
import { MOONBOARD_LAYOUTS } from '@boardsesh/board-config';
import {
  getBoardLayouts,
  getBoardSetsForLayoutAndSize,
  getBoardSizesForLayoutId,
  getDefaultBoardSizeForLayout,
} from '../custom-board-options';

describe('custom board options', () => {
  it('delegates non-MoonBoard layouts to product-size constants', () => {
    expect(getBoardLayouts('kilter')).toEqual(getAllLayouts('kilter'));
  });

  it('returns supported MoonBoard layouts for the custom board selector', () => {
    const layouts = getBoardLayouts('moonboard');
    expect(layouts.map((layout) => layout.name)).toEqual([
      'MoonBoard 2010',
      'MoonBoard 2016',
      'MoonBoard 2024',
      'MoonBoard Masters 2017',
      'MoonBoard Masters 2019',
    ]);
    expect(layouts.map((layout) => layout.id)).not.toContain(MOONBOARD_LAYOUTS['mini-moonboard-2020'].id);
  });

  it('returns the MoonBoard standard size for known layouts', () => {
    expect(getDefaultBoardSizeForLayout('moonboard', 3)).toBe(1);
    expect(getBoardSizesForLayoutId('moonboard', 3)).toEqual([
      {
        id: 1,
        name: 'Standard',
        description: '11x18 Grid',
        edgeLeft: 0,
        edgeRight: 11,
        edgeBottom: 0,
        edgeTop: 18,
        productId: 1,
      },
    ]);
  });

  it('returns MoonBoard sets for a known layout and size', () => {
    const sets = getBoardSetsForLayoutAndSize('moonboard', 3, 1);
    expect(sets.map((set) => set.name)).toEqual([
      'Hold Set D',
      'Hold Set E',
      'Hold Set F',
      'Wooden Holds',
      'Wooden Holds B',
      'Wooden Holds C',
    ]);
  });

  it('returns no MoonBoard options for unknown layout or size combinations', () => {
    expect(getDefaultBoardSizeForLayout('moonboard', 999)).toBeNull();
    expect(getBoardSizesForLayoutId('moonboard', 999)).toEqual([]);
    expect(getBoardSetsForLayoutAndSize('moonboard', 3, 999)).toEqual([]);
  });
});
