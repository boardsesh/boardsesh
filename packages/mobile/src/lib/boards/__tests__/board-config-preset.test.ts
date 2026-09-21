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
 * fallback (the first layout at its default size), so a test can tell which one
 * the preset chose.
 */
function secondKilterSetup() {
  const firstLayoutId = getBoardLayouts('kilter')[0].id;
  const fallbackSizeId = getDefaultBoardSizeForLayout('kilter', firstLayoutId);
  for (const layout of getBoardLayouts('kilter')) {
    for (const size of getBoardSizesForLayoutId('kilter', layout.id)) {
      if (layout.id === firstLayoutId && size.id === fallbackSizeId) continue;
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

  // The list is the top twelve across every board type, and may not have
  // loaded at all; the preset must still give a working Save.
  it("falls back to the type's first layout, its default size and every set", () => {
    const layoutId = getBoardLayouts('tension')[0].id;
    const sizeId = getDefaultBoardSizeForLayout('tension', layoutId);
    if (sizeId == null) throw new Error('no default Tension size');
    const setIds = getBoardSetsForLayoutAndSize('tension', layoutId, sizeId).map((set) => set.id);

    expect(presetBoardConfig('tension', undefined)).toEqual({ layoutId, sizeId, setIds });
    expect(presetBoardConfig('tension', [popular({ boardType: 'kilter', ...secondKilterSetup() })])).toEqual({
      layoutId,
      sizeId,
      setIds,
    });
  });

  it('works for the code-driven boards too', () => {
    expect(presetBoardConfig('woods', undefined)).toEqual({ layoutId: 1, sizeId: 2, setIds: [1] });
    expect(presetBoardConfig('moonboard', undefined)?.setIds.length).toBeGreaterThan(0);
  });

  it('has nothing to preset for a spray wall', () => {
    expect(presetBoardConfig('spray', undefined)).toBeNull();
  });
});
