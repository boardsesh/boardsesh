// #5654: "My own board" opens the builder with a setup already chosen. These
// run against the real board catalogue, because the preset is only useful if
// the builder's chips can show what it picked.
import { describe, expect, it } from 'vitest';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
import { presetBoardConfig } from '../board-config-preset';
import {
  getBoardLayouts,
  getBoardSetsForLayoutAndSize,
  getBoardSizesForLayoutId,
  getDefaultBoardSizeForLayout,
} from '../../custom-board-options';

function popular(overrides: Partial<PopularBoardConfig>): PopularBoardConfig {
  return {
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 0,
    setIds: [],
    setNames: [],
    climbCount: 0,
    totalAscents: 0,
    boardCount: 0,
    displayName: 'Popular setup',
    ...overrides,
  };
}

/**
 * A real (layout, size, sets) setup from this build's catalogue that is NOT the
 * first layout at its default size, so a test can tell the popular entry from
 * the catalogue's first choice.
 */
function secondKilterSetup() {
  const firstLayoutId = getBoardLayouts('kilter')[0].id;
  const defaultSizeId = getDefaultBoardSizeForLayout('kilter', firstLayoutId);
  for (const layout of getBoardLayouts('kilter')) {
    for (const size of getBoardSizesForLayoutId('kilter', layout.id)) {
      if (layout.id === firstLayoutId && size.id === defaultSizeId) continue;
      const setIds = getBoardSetsForLayoutAndSize('kilter', layout.id, size.id).map((set) => set.id);
      if (setIds.length > 0) return { layoutId: layout.id, sizeId: size.id, setIds };
    }
  }
  throw new Error('the Kilter catalogue has only one setup');
}

describe('presetBoardConfig', () => {
  it("picks the board type's most used setup from the popular list", () => {
    const setup = secondKilterSetup();
    const preset = presetBoardConfig('kilter', [
      popular({ boardType: 'tension', layoutId: 9, sizeId: 1, setIds: [1] }),
      popular({ boardType: 'kilter', ...setup }),
    ]);
    expect(preset).toEqual(setup);
  });

  it('skips a popular setup this build does not know and takes the next', () => {
    const setup = secondKilterSetup();
    const preset = presetBoardConfig('kilter', [
      popular({ boardType: 'kilter', layoutId: 99_999, sizeId: 1, setIds: [1] }),
      popular({ boardType: 'kilter', ...setup }),
    ]);
    expect(preset).toEqual(setup);
  });

  it('drops sets the catalogue does not list, keeping the rest', () => {
    const setup = secondKilterSetup();
    const preset = presetBoardConfig('kilter', [popular({ ...setup, setIds: [...setup.setIds, 99_999] })]);
    expect(preset?.setIds).toEqual(setup.setIds);
  });

  // A guessed setup is worse than none: one Save makes a board with the wrong
  // climbs and the wrong holds lit, and a duplicate once the climber fixes it.
  it('presets nothing while the popular list has not loaded', () => {
    expect(presetBoardConfig('kilter', undefined)).toBeNull();
    expect(presetBoardConfig('tension', undefined)).toBeNull();
  });

  it('presets nothing for a board type the popular list does not carry', () => {
    expect(presetBoardConfig('tension', [popular({ boardType: 'kilter', ...secondKilterSetup() })])).toBeNull();
  });

  // The live list has only Kilter and Tension setups. The catalogue's first
  // MoonBoard layout is the 2010 board, which almost no current owner has.
  it('leaves a MoonBoard owner to pick their own year and size', () => {
    const kilterAndTension = [
      popular({ boardType: 'kilter', ...secondKilterSetup() }),
      popular({ boardType: 'tension', layoutId: 9, sizeId: 1, setIds: [1] }),
    ];
    expect(presetBoardConfig('moonboard', kilterAndTension)).toBeNull();
    expect(presetBoardConfig('moonboard', [])).toBeNull();
  });

  it('presets a MoonBoard setup once the popular list carries one', () => {
    const layout = getBoardLayouts('moonboard').at(-1);
    if (!layout) throw new Error('no MoonBoard layouts');
    const size = getBoardSizesForLayoutId('moonboard', layout.id)[0];
    const setIds = getBoardSetsForLayoutAndSize('moonboard', layout.id, size.id).map((set) => set.id);

    expect(
      presetBoardConfig('moonboard', [
        popular({ boardType: 'moonboard', layoutId: layout.id, sizeId: size.id, setIds }),
      ]),
    ).toEqual({ layoutId: layout.id, sizeId: size.id, setIds });
  });

  it('has nothing to preset for a spray wall', () => {
    expect(presetBoardConfig('spray', undefined)).toBeNull();
  });
});
