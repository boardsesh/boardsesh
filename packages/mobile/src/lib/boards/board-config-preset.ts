// The layout and size the board builder opens with when a climber came from
// "My own board" in the first-board picker (#5654).
//
// The builder used to open on Kilter with no layout chosen: the preview asked
// them to "pick your layout" and Save stayed disabled with no reason given, so
// a home-wall owner's first board depended on finding the one chip that
// unlocks it. A preset gives them a board on screen and a working Save from the
// first frame; every chip still changes it.
//
// Only a setup other climbers actually use is preset. A guess (the catalogue's
// first layout at its default size) is worse than no preset: it is MoonBoard
// 2010 for a MoonBoard owner, a commercial-size Kilter for a home wall, and one
// Save away from a board with the wrong climbs and the wrong holds lit. With
// no popular setup for the type, the builder opens as before and the climber
// picks their layout and size.

import type { BoardName, PopularBoardConfig } from '@boardsesh/shared-schema';
import { toBoardName } from '@boardsesh/board-config';
import { getBoardLayouts, getBoardSetsForLayoutAndSize, getBoardSizesForLayoutId } from '../custom-board-options';

export type BoardConfigPreset = {
  layoutId: number;
  sizeId: number;
  setIds: number[];
};

/**
 * The setup to preselect for `boardName`: the most common setup of that board
 * type across Boardsesh, from the popular list the picker already loaded, which
 * the server orders by how many boards use each setup. Its entries are checked
 * against this build's own catalogue, because the builder can only show a
 * selection its chips know.
 *
 * `null` when the list has no usable entry for the type, so the builder opens
 * with nothing chosen. That is every MoonBoard today (the live list carries
 * only Kilter and Tension setups), any rarer board type, a spray wall, and
 * every type while the list has not loaded. The builder asks again when the
 * list lands.
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
