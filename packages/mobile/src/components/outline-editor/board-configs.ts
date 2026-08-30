/**
 * Every board configuration the outline editor can open, enumerated from the
 * bundled catalogue.
 *
 * Three families answer "what layouts / sizes / sets exist?" from different
 * places, and the picker has to list all of them: the backend's `holdOutlines`
 * query serves any config, and a config with no traced shard at all (Woods) is
 * exactly the one worth hand-drawing. Aurora boards read the generated
 * product-size tables; MoonBoard and Woods carry no rows there and keep their
 * layouts, sizes and sets in `@boardsesh/board-config` instead.
 */

import {
  MOONBOARD_LAYOUTS,
  MOONBOARD_SETS,
  MOONBOARD_SIZE,
  WOODS_LAYOUTS,
  WOODS_SETS,
  WOODS_SIZES,
  type MoonBoardLayoutKey,
} from '@boardsesh/board-config';
import { getAllLayouts, getSetsForLayoutAndSize, getSizesForLayoutId } from '@boardsesh/board-constants/product-sizes';
import type { BoardName } from '@boardsesh/shared-schema';

export type OutlineEditorLayout = { id: number; name: string };
export type OutlineEditorSize = { id: number; name: string; description: string };

function moonBoardLayoutKeyFor(layoutId: number): MoonBoardLayoutKey | undefined {
  return (Object.keys(MOONBOARD_LAYOUTS) as MoonBoardLayoutKey[]).find((key) => MOONBOARD_LAYOUTS[key].id === layoutId);
}

/** The layouts of one board, newest catalogue order. */
export function outlineEditorLayouts(boardName: BoardName): OutlineEditorLayout[] {
  if (boardName === 'moonboard') {
    return Object.values(MOONBOARD_LAYOUTS).map((layout) => ({ id: layout.id, name: layout.name }));
  }
  if (boardName === 'woods') {
    return [{ id: WOODS_LAYOUTS.woods.id, name: WOODS_LAYOUTS.woods.name }];
  }
  return getAllLayouts(boardName).map((layout) => ({ id: layout.id, name: layout.name }));
}

/** The sizes one layout ships in. */
export function outlineEditorSizes(boardName: BoardName, layoutId: number): OutlineEditorSize[] {
  if (boardName === 'moonboard') {
    return [{ id: MOONBOARD_SIZE.id, name: MOONBOARD_SIZE.name, description: MOONBOARD_SIZE.description }];
  }
  if (boardName === 'woods') {
    // The two Woods boards number their holds from their own origins, so they
    // are genuinely different configs — both are listed.
    return Object.values(WOODS_SIZES).map((size) => ({ id: size.id, name: size.name, description: '' }));
  }
  return getSizesForLayoutId(boardName, layoutId).map((size) => ({
    id: size.id,
    name: size.name,
    description: size.description,
  }));
}

/**
 * Every set of a layout and size, as the comma-separated string the board routes
 * take. That's how a geometry shard is traced — with all of them mounted — so an
 * override is always drawn against the same art.
 */
export function outlineEditorSetIds(boardName: BoardName, layoutId: number, sizeId: number): string {
  if (boardName === 'moonboard') {
    const layoutKey = moonBoardLayoutKeyFor(layoutId);
    const sets = layoutKey ? (MOONBOARD_SETS[layoutKey] ?? []) : [];
    return sets.map((set) => set.id).join(',');
  }
  if (boardName === 'woods') {
    return WOODS_SETS.map((set) => set.id).join(',');
  }
  return getSetsForLayoutAndSize(boardName, layoutId, sizeId)
    .map((set) => set.id)
    .join(',');
}
