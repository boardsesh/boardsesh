import type { BoardName } from '@boardsesh/shared-schema';
import { getBoardLayouts, getBoardSizesForLayoutId } from './custom-board-options';

/**
 * The applied filter for the Find Gym ("Wall Finder") screen.
 *
 * Collapses what used to be two loose strings (`inputText` raw + `query`
 * applied) into one object so the search bar's two jobs and the chip filters
 * compose cleanly:
 *
 * - `name` — the applied name filter (gyms/boards `ILIKE`). Mutually exclusive
 *   with `place`: a typed place RELOCATES the map (it is not a filter term), so
 *   the two are never ANDed (a place like "Tokyo" would otherwise hide every gym
 *   not literally named after it).
 * - `place` — the label of a geocoded place search ("Showing <place>"); the
 *   camera move itself is viewport state, not stored here.
 * - `boardTypes` — selected board types (every board in `SUPPORTED_BOARDS`),
 *   multi-select OR. ANDs with `name` and the current viewport.
 * - `layoutIds` — selected layout ids, multi-select OR. Only meaningful when a
 *   single board type is selected (layouts are board-type-scoped), so the toggle
 *   helpers clear these whenever the board-type selection isn't exactly one.
 * - `sizeIds` — selected size ids, multi-select OR. Only meaningful when a single
 *   layout is selected (sizes are layout-scoped); cleared the same way.
 * - `multiBoardTypeOnly` — restrict to gyms with two or more distinct board
 *   types. Gyms only; standalone boards are hidden while it's on.
 *
 * `viewCenter` / `searchLabel` stay separate viewport state on the screen — this
 * is the FILTER, not the camera.
 */
export type WallFinderFilter = {
  place?: string;
  name?: string;
  boardTypes?: BoardName[];
  layoutIds?: number[];
  sizeIds?: number[];
  multiBoardTypeOnly?: boolean;
};

/** A layout filter chip: id + display label. */
export type WallFinderLayoutOption = { id: number; label: string };

/** A size filter chip; one display label can map to several Aurora size ids. */
export type WallFinderSizeOption = { label: string; sizeIds: number[] };

export const DEFAULT_WALL_FINDER_FILTER: WallFinderFilter = {};

/** True when any filter term is set (name, board types, layouts, sizes, or the multi-board toggle). */
export function hasActiveWallFinderFilter(filter: WallFinderFilter): boolean {
  return (
    Boolean(filter.name && filter.name.length > 0) ||
    (filter.boardTypes?.length ?? 0) > 0 ||
    (filter.layoutIds?.length ?? 0) > 0 ||
    (filter.sizeIds?.length ?? 0) > 0 ||
    filter.multiBoardTypeOnly === true
  );
}

/**
 * Toggle a board type (multi-select OR). Layouts are board-type-scoped and sizes
 * are layout-scoped, so any change that leaves us without exactly one board type
 * invalidates both deeper tiers.
 */
export function toggleBoardTypeFilter(filter: WallFinderFilter, boardType: BoardName): WallFinderFilter {
  const current = filter.boardTypes ?? [];
  const next = current.includes(boardType) ? current.filter((type) => type !== boardType) : [...current, boardType];
  const boardTypes = next.length > 0 ? next : undefined;
  if (next.length === 1) return { ...filter, boardTypes };
  return { ...filter, boardTypes, layoutIds: undefined, sizeIds: undefined };
}

/**
 * Toggle a layout (multi-select OR). Sizes are layout-scoped, so drop them
 * whenever we're no longer down to exactly one layout.
 */
export function toggleLayoutFilter(filter: WallFinderFilter, layoutId: number): WallFinderFilter {
  const current = filter.layoutIds ?? [];
  const next = current.includes(layoutId) ? current.filter((id) => id !== layoutId) : [...current, layoutId];
  const layoutIds = next.length > 0 ? next : undefined;
  if (next.length === 1) return { ...filter, layoutIds };
  return { ...filter, layoutIds, sizeIds: undefined };
}

/**
 * Toggle a size group (one display label may map to several Aurora size ids): add
 * the whole group if any id is missing, otherwise remove the whole group.
 */
export function toggleSizeFilter(filter: WallFinderFilter, sizeIds: number[]): WallFinderFilter {
  const current = filter.sizeIds ?? [];
  const allSelected = sizeIds.length > 0 && sizeIds.every((id) => current.includes(id));
  const next = allSelected
    ? current.filter((id) => !sizeIds.includes(id))
    : [...current, ...sizeIds.filter((id) => !current.includes(id))];
  return { ...filter, sizeIds: next.length > 0 ? next : undefined };
}

/** Flip the "two or more distinct board types" gym restriction. */
export function toggleMultiBoardTypeFilter(filter: WallFinderFilter): WallFinderFilter {
  return { ...filter, multiBoardTypeOnly: filter.multiBoardTypeOnly ? undefined : true };
}

/** Clear every chip filter, leaving the name/place search and viewport untouched. */
export function clearWallFinderChipFilters(filter: WallFinderFilter): WallFinderFilter {
  return { ...filter, boardTypes: undefined, layoutIds: undefined, sizeIds: undefined, multiBoardTypeOnly: undefined };
}

/**
 * Layout chips for the current filter — empty unless exactly one board type is
 * selected (layouts are board-type-scoped). Sourced from the same board-aware
 * cascade the board builder uses, so the chips are deterministic, don't vanish
 * as the user narrows, and carry the exact ids the builder wrote to
 * `user_boards.layout_id`. Going through `getBoardLayouts` rather than
 * board-constants' `getAllLayouts` is what makes the code-driven boards work:
 * MoonBoard and Woods have no generated `LAYOUTS` rows, so the Aurora-only
 * helper returns nothing for them and their chips came up empty.
 */
export function buildLayoutOptions(filter: WallFinderFilter): WallFinderLayoutOption[] {
  const types = filter.boardTypes ?? [];
  if (types.length !== 1) return [];
  return getBoardLayouts(types[0]).map((layout) => ({ id: layout.id, label: layout.name }));
}

/**
 * Size chips for the current filter — empty unless exactly one board type AND one
 * layout are selected (sizes are layout-scoped). Grouped by display name so one
 * chip can carry several Aurora size ids that share a label (e.g. a Full Ride /
 * Mainline pair under the same dimensions). Same board-aware cascade as
 * `buildLayoutOptions` — Woods' two sizes and MoonBoard's single one live in
 * code, not in the generated tables.
 */
export function buildSizeOptions(filter: WallFinderFilter): WallFinderSizeOption[] {
  const types = filter.boardTypes ?? [];
  const layouts = filter.layoutIds ?? [];
  if (types.length !== 1 || layouts.length !== 1) return [];
  const byName = new Map<string, number[]>();
  for (const size of getBoardSizesForLayoutId(types[0], layouts[0])) {
    const existing = byName.get(size.name);
    if (existing) existing.push(size.id);
    else byName.set(size.name, [size.id]);
  }
  return Array.from(byName, ([label, sizeIds]) => ({ label, sizeIds }));
}
