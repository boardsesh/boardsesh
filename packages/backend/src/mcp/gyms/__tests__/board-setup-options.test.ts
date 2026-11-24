import { afterEach, describe, expect, it, vi } from 'vitest';
import * as boardCatalogue from '@boardsesh/board-config';
import { MOONBOARD_LAYOUTS, MOONBOARD_SETS, MOONBOARD_SIZE } from '@boardsesh/board-config/moonboard-metadata';
import { getBoardSelectorOptions } from '@boardsesh/board-constants/product-sizes';
import { getGymBoardSetupOptions } from '../board-setup-options';

describe('gym MCP board setup catalogue', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns Masters 2019, Standard size and all seven supported sets including screw-on feet', () => {
    const options = getGymBoardSetupOptions('moonboard');
    expect(options.layouts).toContainEqual({ id: 5, name: 'MoonBoard Masters 2019' });
    expect(options.sizes['moonboard-5']).toEqual([{ id: 1, name: 'Standard', description: '11x18 Grid' }]);
    expect(options.sets['moonboard-5-1']).toEqual([
      { id: 17, name: 'Hold Set A' },
      { id: 18, name: 'Hold Set B' },
      { id: 19, name: 'Original School Holds' },
      { id: 20, name: 'Screw-on Feet' },
      { id: 21, name: 'Wooden Holds' },
      { id: 22, name: 'Wooden Holds B' },
      { id: 23, name: 'Wooden Holds C' },
    ]);
  });

  it('includes every supported MoonBoard layout and its exact hold-set catalogue', () => {
    const options = getGymBoardSetupOptions('moonboard');
    expect(options.layouts).toHaveLength(Object.keys(MOONBOARD_LAYOUTS).length);
    for (const [layoutKey, layout] of Object.entries(MOONBOARD_LAYOUTS)) {
      expect(options.layouts).toContainEqual({ id: layout.id, name: layout.name });
      expect(options.sizes[`moonboard-${layout.id}`]).toEqual([
        { id: MOONBOARD_SIZE.id, name: MOONBOARD_SIZE.name, description: MOONBOARD_SIZE.description },
      ]);
      expect(options.sets[`moonboard-${layout.id}-${MOONBOARD_SIZE.id}`]).toEqual(
        MOONBOARD_SETS[layoutKey as keyof typeof MOONBOARD_SETS].map(({ id, name }) => ({ id, name })),
      );
    }
  });

  it('preserves Aurora layout, size and hold-set options', () => {
    const existing = getBoardSelectorOptions();
    const options = getGymBoardSetupOptions('kilter');
    expect(options.layouts).toEqual(existing.layouts.kilter);
    expect(options.sizes).toEqual(
      Object.fromEntries(Object.entries(existing.sizes).filter(([key]) => key.startsWith('kilter-'))),
    );
    expect(options.sets).toEqual(
      Object.fromEntries(
        Object.entries(existing.sets)
          .filter(([key]) => key.startsWith('kilter-'))
          .map(([key, holdSets]) => [key, holdSets.map(({ id, name }) => ({ id, name }))]),
      ),
    );
  });

  it('also resolves the code-defined Woods catalogue', () => {
    const options = getGymBoardSetupOptions('woods');
    expect(options.layouts.length).toBeGreaterThan(0);
    expect(Object.values(options.sizes).flat().length).toBeGreaterThan(0);
    expect(Object.values(options.sets).flat().length).toBeGreaterThan(0);
  });

  it('returns an actionable error for a board without a static catalogue', () => {
    expect(() => getGymBoardSetupOptions('spray')).toThrow(
      'Spray walls have no static catalogue. Open the selected spray wall’s management page to edit its photo and holds.',
    );
    expect(() => getGymBoardSetupOptions('spray')).toThrow(
      expect.objectContaining({ extensions: { code: 'BOARD_SETUP_OPTIONS_UNAVAILABLE' } }),
    );
  });

  it.each(['sizes', 'sets'])('refuses an incomplete %s catalogue instead of successful empty choices', (missing) => {
    if (missing === 'sizes') vi.spyOn(boardCatalogue, 'getBoardSizesForLayoutId').mockReturnValue([]);
    else vi.spyOn(boardCatalogue, 'getBoardSetsForLayoutAndSize').mockReturnValue([]);
    expect(() => getGymBoardSetupOptions('moonboard')).toThrow(
      expect.objectContaining({ extensions: { code: 'BOARD_SETUP_OPTIONS_UNAVAILABLE' } }),
    );
  });
});
