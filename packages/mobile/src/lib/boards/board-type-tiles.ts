// "Which board?" in the add-a-board wizard: which board types get a big tile,
// and the setup each one's art is drawn from. Pure, so the split is a table in
// tests.

import type { BoardName, PopularBoardConfig } from '@boardsesh/shared-schema';
import { getBoardLayouts, getBoardSetsForLayoutAndSize, getBoardSizesForLayoutId } from '@boardsesh/board-config';
import { presetBoardConfig } from './board-config-preset';

/**
 * The types with a big tile, in this order: MoonBoard 557, Kilter 318 and
 * Tension 157 of the boards created over 60 days, 95% between them. A type
 * this build leaves out of the catalogue (MoonBoard behind its switch) is
 * skipped, never drawn as an empty tile.
 */
export const FEATURED_BOARD_TYPES: readonly BoardName[] = ['moonboard', 'kilter', 'tension'];

/**
 * The catalogue's board types as the step shows them: the featured ones as
 * tiles, in `FEATURED_BOARD_TYPES` order, and every other type as a row, by
 * label (Decoy, Grasshopper, So iLL, Touchstone, Woods).
 */
export function splitBoardTypes(
  supported: readonly BoardName[],
  labelFor: (boardName: BoardName) => string,
): { featured: BoardName[]; others: BoardName[] } {
  const supportedSet = new Set(supported);
  const featured = FEATURED_BOARD_TYPES.filter((boardName) => supportedSet.has(boardName));
  const featuredSet = new Set<BoardName>(featured);
  const others = supported
    .filter((boardName) => !featuredSet.has(boardName))
    .sort((first, second) => labelFor(first).localeCompare(labelFor(second)));
  return { featured, others };
}

/** The setup a type's art is drawn from: what `BoardThumbnail` takes. */
export type BoardTypeArt = { boardType: BoardName; layoutId: number; sizeId: number; setIds: string };

/**
 * The setup to draw a type's tile with: the one Set up will open on (its most
 * used, `presetBoardConfig`), so the art the climber taps is the board they
 * get, or else the catalogue's first layout and size with every set. Null for a
 * type the catalogue can't draw.
 */
export function boardTypeArt(
  boardName: BoardName,
  popularConfigs: readonly PopularBoardConfig[] | undefined,
): BoardTypeArt | null {
  const preset = presetBoardConfig(boardName, popularConfigs);
  if (preset) {
    return { boardType: boardName, layoutId: preset.layoutId, sizeId: preset.sizeId, setIds: preset.setIds.join(',') };
  }
  const layout = getBoardLayouts(boardName)[0];
  if (!layout) return null;
  const size = getBoardSizesForLayoutId(boardName, layout.id)[0];
  if (!size) return null;
  const setIds = getBoardSetsForLayoutAndSize(boardName, layout.id, size.id).map((set) => set.id);
  if (setIds.length === 0) return null;
  return { boardType: boardName, layoutId: layout.id, sizeId: size.id, setIds: setIds.join(',') };
}

/** Narrower than this, or text larger than `TILE_MAX_FONT_SCALE`, every type is a row. */
export const TILE_MIN_WINDOW_WIDTH = 340;
export const TILE_MAX_FONT_SCALE = 1.3;

/** Whether the featured types fit as three tiles across: at 320 pt "MoonBoard" has no room to spare. */
export function boardTypeTilesFit(windowWidth: number, fontScale: number): boolean {
  return windowWidth >= TILE_MIN_WINDOW_WIDTH && fontScale <= TILE_MAX_FONT_SCALE;
}
