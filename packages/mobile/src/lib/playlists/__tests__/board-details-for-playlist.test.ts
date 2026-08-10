import { describe, it, expect } from 'vitest';
import { getAllLayouts, getSizesForLayoutId } from '@boardsesh/board-constants/product-sizes';
import { getSizeRank } from '@boardsesh/board-constants/size-comparison';
import { MOONBOARD_LAYOUTS, MOONBOARD_SETS, MOONBOARD_SIZE } from '@boardsesh/board-config';
import { getBoardConfigForPlaylist } from '../board-details-for-playlist';
import { getBoardRenderData } from '../../board-details';

// "Biggest" = tallest, widest breaking ties — the shared `getSizeRank` order, so
// the Kilter default is the 12x14 Commercial rather than the wider-but-shorter
// 16x12 Super Wide that a raw area comparison picks.
function biggestSizeId(layoutId: number): number {
  const sizes = getSizesForLayoutId('kilter', layoutId);
  const biggest = sizes.reduce((best, size) =>
    getSizeRank('kilter', size.id) > getSizeRank('kilter', best.id) ? size : best,
  );
  return biggest.id;
}

describe('getBoardConfigForPlaylist', () => {
  it('returns the biggest size and all its sets for a real kilter layout', () => {
    const layouts = getAllLayouts('kilter');
    expect(layouts.length).toBeGreaterThan(0);
    const layoutId = layouts[0].id;

    const config = getBoardConfigForPlaylist('kilter', layoutId);
    expect(config).not.toBeNull();
    expect(config?.boardName).toBe('kilter');
    expect(config?.layoutId).toBe(layoutId);
    expect(config?.setIds.length).toBeGreaterThan(0);
    expect(config?.sizeId).toBe(biggestSizeId(layoutId));
  });

  it('falls back to a default layout when layoutId is null', () => {
    const config = getBoardConfigForPlaylist('kilter', null);
    expect(config).not.toBeNull();
    expect(config?.layoutId).toBe(getAllLayouts('kilter')[0].id);
  });

  it('returns null for an unknown board type', () => {
    expect(getBoardConfigForPlaylist('not-a-board', 1)).toBeNull();
  });

  it('returns null for an unknown layout id', () => {
    expect(getBoardConfigForPlaylist('kilter', 999999)).toBeNull();
  });

  it('resolves a moonboard config (fixed size + all sets) for a real layout', () => {
    const layoutId = MOONBOARD_LAYOUTS['moonboard-2016'].id;
    const config = getBoardConfigForPlaylist('moonboard', layoutId);

    expect(config).not.toBeNull();
    expect(config?.boardName).toBe('moonboard');
    expect(config?.layoutId).toBe(layoutId);
    expect(config?.sizeId).toBe(MOONBOARD_SIZE.id);
    expect(config?.setIds).toEqual(MOONBOARD_SETS['moonboard-2016'].map((set) => set.id));
  });

  it('falls back to the default moonboard layout when layoutId is null', () => {
    const config = getBoardConfigForPlaylist('moonboard', null);

    expect(config).not.toBeNull();
    expect(config?.boardName).toBe('moonboard');
    expect(config?.layoutId).toBe(MOONBOARD_LAYOUTS['moonboard-2024'].id);
  });

  it('returns null for an unknown moonboard layout id', () => {
    expect(getBoardConfigForPlaylist('moonboard', 999999)).toBeNull();
  });

  it('produces a moonboard config that feeds getBoardRenderData end-to-end', () => {
    const config = getBoardConfigForPlaylist('moonboard', MOONBOARD_LAYOUTS['moonboard-2016'].id);
    expect(config).not.toBeNull();

    const renderData = getBoardRenderData({
      boardName: config!.boardName,
      layoutId: config!.layoutId,
      sizeId: config!.sizeId,
      setIds: config!.setIds,
    });

    expect(renderData).not.toBeNull();
    expect(renderData?.backgroundImageKeys.length).toBeGreaterThan(0);
    expect(renderData?.holdsData.length).toBeGreaterThan(0);
  });
});
