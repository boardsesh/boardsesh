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
      'Mini MoonBoard 2020',
      'Mini MoonBoard 2025',
    ]);
    // The Mini layouts now have board art, so they appear in the picker.
    expect(layouts.map((layout) => layout.id)).toContain(MOONBOARD_LAYOUTS['mini-moonboard-2020'].id);
    expect(layouts.map((layout) => layout.id)).toContain(MOONBOARD_LAYOUTS['mini-moonboard-2025'].id);
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

  // Woods is code-driven like MoonBoard: the generated LAYOUTS/SETS tables are
  // empty for it, so every level of the cascade needs its own branch or the
  // builder shows an empty picker.
  it('returns the single Woods layout', () => {
    expect(getBoardLayouts('woods')).toEqual([{ id: 1, name: 'Original', productId: 1 }]);
  });

  it('returns both Woods sizes with their real edge extents', () => {
    expect(getBoardSizesForLayoutId('woods', 1)).toEqual([
      { id: 1, name: '8 x 10', description: '', edgeLeft: 0, edgeRight: 21, edgeBottom: 0, edgeTop: 25, productId: 1 },
      { id: 2, name: '12 x 12', description: '', edgeLeft: 0, edgeRight: 33, edgeBottom: 0, edgeTop: 31, productId: 2 },
    ]);
  });

  it('defaults Woods to the 12x12 board', () => {
    expect(getDefaultBoardSizeForLayout('woods', 1)).toBe(2);
  });

  // The synthetic set is what makes the builder's `setIds.length > 0` gate pass —
  // a Woods board with no sets could never be created.
  it('returns the synthetic Woods hold set for both sizes', () => {
    expect(getBoardSetsForLayoutAndSize('woods', 1, 1)).toEqual([{ id: 1, name: 'Standard' }]);
    expect(getBoardSetsForLayoutAndSize('woods', 1, 2)).toEqual([{ id: 1, name: 'Standard' }]);
  });

  it('returns no Woods options for unknown layout or size combinations', () => {
    expect(getDefaultBoardSizeForLayout('woods', 2)).toBeNull();
    expect(getBoardSizesForLayoutId('woods', 2)).toEqual([]);
    expect(getBoardSetsForLayoutAndSize('woods', 1, 3)).toEqual([]);
    expect(getBoardSetsForLayoutAndSize('woods', 2, 1)).toEqual([]);
  });
});
