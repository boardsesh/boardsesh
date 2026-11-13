// @vitest-environment node
import { describe, expect, it } from 'vite-plus/test';
import { gzipSync } from 'node:zlib';
import { getBoardDetailsForBoard } from '../board-utils';
import {
  getBoardImageDetailsForBoard,
  getBoardImageDetailsForPlaylist,
  toBoardImageDetails,
} from '../board-image-details';
import { getBoardDetailsForPlaylist } from '../board-config-for-playlist';
import {
  getAllLayouts,
  getSizesForLayoutId,
  getSetsForLayoutAndSize,
} from '@boardsesh/board-constants/catalog-metadata';
import { MOONBOARD_LAYOUTS, MOONBOARD_SETS, type MoonBoardLayoutKey } from '@boardsesh/board-config/moonboard-metadata';
import {
  buildBoardArtLayers,
  buildBoardRenderUrl,
  buildOverlayPreloadUrls,
} from '@/app/components/board-renderer/util';
import { buildCanonicalClimbViewUrl } from '../url-utils';
import type { BoardName } from '../types';

const auroraBoards: BoardName[] = ['kilter', 'tension', 'decoy', 'touchstone', 'grasshopper', 'soill'];
const configs = auroraBoards.flatMap((board_name) =>
  getAllLayouts(board_name).flatMap((layout) =>
    getSizesForLayoutId(board_name, layout.id).map((size) => ({
      board_name,
      layout_id: layout.id,
      size_id: size.id,
      set_ids: getSetsForLayoutAndSize(board_name, layout.id, size.id).map((set) => set.id),
    })),
  ),
);
const moonConfigs = Object.entries(MOONBOARD_LAYOUTS).map(([key, layout]) => ({
  board_name: 'moonboard',
  layout_id: layout.id,
  size_id: 99,
  set_ids: MOONBOARD_SETS[key as MoonBoardLayoutKey].map((set) => set.id),
}));
const woodsConfigs = [1, 2].map((size_id) => ({ board_name: 'woods', layout_id: 99, size_id, set_ids: [99] }));

describe('geometry-free board presentation metadata', () => {
  it('matches full catalog metadata and image/URL behavior for every configuration', () => {
    for (const params of [...configs, ...moonConfigs, ...woodsConfigs]) {
      const full = getBoardDetailsForBoard(params);
      const projected = toBoardImageDetails(full);
      const direct = getBoardImageDetailsForBoard(params);
      expect(direct, JSON.stringify(params)).toEqual(projected);
      expect(buildBoardRenderUrl(direct, 'p1r42', { thumbnail: true, includeBackground: true })).toBe(
        buildBoardRenderUrl(full, 'p1r42', { thumbnail: true, includeBackground: true }),
      );
      expect(buildBoardArtLayers(direct, 'p1r42', true)).toEqual(buildBoardArtLayers(full, 'p1r42', true));
      expect(buildOverlayPreloadUrls(direct, 'p1r42')).toEqual(buildOverlayPreloadUrls(full, 'p1r42'));
      expect(buildCanonicalClimbViewUrl(direct, 40, 'climb', 'Example')).toBe(
        buildCanonicalClimbViewUrl(full, 40, 'climb', 'Example'),
      );
      expect(direct).not.toHaveProperty('holdsData');
      expect(direct).not.toHaveProperty('images_to_holds');
      expect(direct).not.toHaveProperty('edge_left');
    }
  });

  it('preserves requested image order, catalog name order, and empty-set fallback dimensions', () => {
    const params = { board_name: 'kilter', layout_id: 1, size_id: 10, set_ids: [20, 1, 20] };
    expect(getBoardImageDetailsForBoard(params)).toEqual(toBoardImageDetails(getBoardDetailsForBoard(params)));
    expect(getBoardImageDetailsForBoard({ ...params, set_ids: [] })).toMatchObject({
      boardWidth: 1080,
      boardHeight: 1920,
      backgroundImagePaths: [],
    });
  });

  it('retains invalid configuration failures', () => {
    for (const params of [
      { board_name: 'kilter', layout_id: 1, size_id: 999, set_ids: [1] },
      { board_name: 'kilter', layout_id: 1, size_id: 10, set_ids: [999] },
      { board_name: 'moonboard', layout_id: 999, size_id: 1, set_ids: [1] },
      { board_name: 'woods', layout_id: 1, size_id: 999, set_ids: [1] },
    ]) {
      let fullError: unknown;
      try {
        getBoardDetailsForBoard(params);
      } catch (error) {
        fullError = error;
      }
      expect(fullError).toBeInstanceOf(Error);
      expect(() => getBoardImageDetailsForBoard(params)).toThrow((fullError as Error).message);
    }
  });

  it('shares playlist defaults while keeping full geometry for compatibility consumers', () => {
    for (const board of [...auroraBoards, 'moonboard', 'woods', 'invalid']) {
      for (const layout of [undefined, 1, 3, 999]) {
        const full = getBoardDetailsForPlaylist(board, layout);
        const thin = getBoardImageDetailsForPlaylist(board, layout);
        expect(thin).toEqual(full ? toBoardImageDetails(full) : null);
        if (full) expect(full.holdsData.length).toBeGreaterThan(0);
      }
    }
  });

  it('keeps serialized display props below 700 bytes even for 894-hold boards', () => {
    for (const params of [
      { board_name: 'kilter', layout_id: 1, size_id: 10, set_ids: [1, 20] },
      { board_name: 'tension', layout_id: 9, size_id: 1, set_ids: [8, 9, 10, 11] },
      moonConfigs[0],
      ...woodsConfigs,
    ]) {
      const full = getBoardDetailsForBoard(params);
      const thin = getBoardImageDetailsForBoard(params);
      const fullProps = JSON.stringify({ viewerBoardDetails: full });
      const thinProps = JSON.stringify({ viewerBoardDetails: thin });
      expect(Buffer.byteLength(thinProps)).toBeLessThan(700);
      expect(gzipSync(thinProps).length).toBeLessThan(gzipSync(fullProps).length / 3);
      expect(thinProps).not.toMatch(/holdsData|images_to_holds|mirroredHoldId|"cx"|"cy"|"edge_/);
    }
  });
});
