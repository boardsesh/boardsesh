import { ANGLES, getBoardLayouts, getBoardSizesForLayoutId } from '@boardsesh/board-config';
import type { GymBoardFilter } from './filter-state';

/** A layout filter chip: id + display label. */
export type LayoutFilterOption = { id: number; label: string };

/** A size filter chip; one display label can map to several Aurora size ids. */
export type SizeFilterOption = { label: string; sizeIds: number[] };

/** An angle filter chip. Degrees, as stored in `user_boards.angle`. */
export type AngleFilterOption = { angle: number };

/**
 * The one board type this filter is scoped to, or null when it is not scoped to
 * exactly one. Every builder below is gated on it, so the rule lives in one
 * place and the three cannot drift apart.
 */
function soleBoardType(filter: GymBoardFilter) {
  const types = filter.boardTypes ?? [];
  return types.length === 1 ? types[0] : null;
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
export function buildLayoutOptions(filter: GymBoardFilter): LayoutFilterOption[] {
  const boardType = soleBoardType(filter);
  if (!boardType) return [];
  return getBoardLayouts(boardType).map((layout) => ({ id: layout.id, label: layout.name }));
}

/**
 * Size chips for the current filter — empty unless exactly one board type AND one
 * layout are selected (sizes are layout-scoped). Grouped by display name so one
 * chip can carry several Aurora size ids that share a label (e.g. a Full Ride /
 * Mainline pair under the same dimensions). Same board-aware cascade as
 * `buildLayoutOptions` — Woods' two sizes and MoonBoard's single one live in
 * code, not in the generated tables.
 */
export function buildSizeOptions(filter: GymBoardFilter): SizeFilterOption[] {
  const boardType = soleBoardType(filter);
  const layouts = filter.layoutIds ?? [];
  if (!boardType || layouts.length !== 1) return [];
  const byName = new Map<string, number[]>();
  for (const size of getBoardSizesForLayoutId(boardType, layouts[0])) {
    const existing = byName.get(size.name);
    if (existing) existing.push(size.id);
    else byName.set(size.name, [size.id]);
  }
  return Array.from(byName, ([label, sizeIds]) => ({ label, sizeIds }));
}

/**
 * Angle chips for the current filter — empty unless exactly one board type is
 * selected, because the legal angles differ per board: Kilter and the Aurora
 * family run 0-70 in fives, MoonBoard is exactly [25, 40], Woods starts at 20,
 * and Grasshopper alone goes negative at -5. Rendering the union would offer
 * thirteen chips that can never match a MoonBoard gym.
 *
 * Reads the ungated `ANGLES` table rather than `getBoardAngleOptions(name,
 * wideAnglesEnabled)`. The gym directory is an anonymous, cache-backed public
 * surface with no feature-flag context, and a shareable URL whose validity
 * depends on whether the reader has `moonboard-wide-angles` turned on is a URL
 * that works for one person and 404s the filter for the next.
 */
export function buildAngleOptions(filter: GymBoardFilter): AngleFilterOption[] {
  const boardType = soleBoardType(filter);
  if (!boardType) return [];
  return ANGLES[boardType].map((angle) => ({ angle }));
}

/**
 * How many size CHIPS are selected, not how many Aurora ids are.
 *
 * One chip can carry several ids, so counting `sizeIds.length` reports three for
 * a single click on the Homewall's "10x10" — a number that contradicts the chip
 * row and the active-filter summary sitting next to it. A filter count is a
 * count of decisions the visitor made.
 */
export function countSelectedSizeGroups(filter: GymBoardFilter): number {
  const selected = new Set(filter.sizeIds ?? []);
  if (selected.size === 0) return 0;
  const options = buildSizeOptions(filter);
  let groups = 0;
  for (const option of options) {
    if (!option.sizeIds.every((sizeId) => selected.has(sizeId))) continue;
    groups += 1;
    for (const sizeId of option.sizeIds) selected.delete(sizeId);
  }
  // Anything the current option tree cannot place still counts as one choice
  // each, so a stale link never reports zero active filters while filtering.
  return groups + selected.size;
}
