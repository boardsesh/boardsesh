// The layout and size the board builder opens with when a climber came from
// "My own board" in the first-board picker (#5654).
//
// The builder used to open on Kilter with no layout chosen: the preview asked
// them to "pick your layout" and Save stayed disabled with no reason given, so
// a home-wall owner's first board depended on finding the one chip that
// unlocks it. A preset gives them a board on screen and a working Save from the
// first frame; every chip still changes it.

import type { BoardName, PopularBoardConfig } from '@boardsesh/shared-schema';
import { toBoardName } from '@boardsesh/board-config';
import {
  getBoardLayouts,
  getBoardSetsForLayoutAndSize,
  getBoardSizesForLayoutId,
  getDefaultBoardSizeForLayout,
} from '../custom-board-options';

export type BoardConfigPreset = {
  layoutId: number;
  sizeId: number;
  setIds: number[];
};

/**
 * The setup to preselect for `boardName`.
 *
 * First choice is the most common setup of that board type across Boardsesh:
 * the popular list the picker already loaded, which the server orders by how
 * many boards use each setup. Its entries are checked against this build's own
 * catalogue, because the builder can only show a selection its chips know.
 *
 * With no usable popular entry (the list is the top twelve across every type,
 * so a rarer board type is often missing, and it may not have loaded at all)
 * it falls back to the type's first layout, that layout's default size and all
 * of its sets, the same choice `selectLayout` makes when a layout is tapped.
 *
 * `null` for a type with nothing to cascade (a spray wall).
 */
export function presetBoardConfig(
  boardName: BoardName,
  popularConfigs: readonly PopularBoardConfig[] | undefined,
): BoardConfigPreset | null {
  for (const config of popularConfigs ?? []) {
    if (toBoardName(config.boardType) !== boardName) continue;
    const popularPreset = catalogueBackedPreset(boardName, config);
    if (popularPreset) return popularPreset;
  }

  for (const layout of getBoardLayouts(boardName)) {
    const sizeId = getDefaultBoardSizeForLayout(boardName, layout.id);
    if (sizeId == null) continue;
    const setIds = getBoardSetsForLayoutAndSize(boardName, layout.id, sizeId).map((set) => set.id);
    if (setIds.length > 0) return { layoutId: layout.id, sizeId, setIds };
  }
  return null;
}

/**
 * The popular setup as a preset, or `null` when this build's catalogue does not
 * carry its layout, size or any of its sets. Sets the catalogue does not list
 * are dropped rather than failing the whole entry.
 */
function catalogueBackedPreset(boardName: BoardName, config: PopularBoardConfig): BoardConfigPreset | null {
  if (!getBoardLayouts(boardName).some((layout) => layout.id === config.layoutId)) return null;
  if (!getBoardSizesForLayoutId(boardName, config.layoutId).some((size) => size.id === config.sizeId)) return null;
  const catalogueSetIds = new Set(
    getBoardSetsForLayoutAndSize(boardName, config.layoutId, config.sizeId).map((set) => set.id),
  );
  const setIds = config.setIds.filter((setId) => catalogueSetIds.has(setId));
  if (setIds.length === 0) return null;
  return { layoutId: config.layoutId, sizeId: config.sizeId, setIds };
}
