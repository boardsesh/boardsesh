import type { BoardName } from '@boardsesh/shared-schema';

/**
 * The board half of a gym search — "which physical wall am I looking for".
 *
 * Deliberately NOT the text/location/paging half: www calls its free text
 * `query` and pages with `?page`, the mobile Wall Finder calls it `name` and
 * pages by viewport. Those belong to their surfaces. What both share is the
 * board question, and that is this type.
 *
 * Every field is a multi-select OR within itself and an AND across fields, which
 * is exactly what `searchGyms` does with them: all four are pushed into ONE
 * `EXISTS (SELECT 1 FROM user_boards ub ...)` so they must describe the SAME
 * physical board. A gym does not match "Kilter Homewall at 40°" by owning a
 * Homewall at 25° and, separately, something else at 40°.
 *
 *  - `boardTypes`  — the top tier, always meaningful.
 *  - `layoutIds`   — only meaningful under exactly ONE board type. Layout ids are
 *    not globally unique: id 1 is simultaneously Kilter Board Original,
 *    Touchstone Winter 2020, Grasshopper 2020 and So iLL Summer 2024, and the
 *    resolver's `ub.layout_id IN (...)` carries no board-type scoping of its own.
 *    So a layout filter under two board types is not a narrow search, it is a
 *    wrong one — hence the cascade below clears it rather than trusting it.
 *  - `sizeIds`     — only meaningful under exactly one layout (sizes are
 *    layout-scoped through `productId`).
 *  - `angles`      — scoped to BOARD TYPE, not layout: `ANGLES` is
 *    `Record<BoardName, Angle[]>`. So angle is a SIBLING of layout, not a child
 *    of size, and a layout change must not clear it.
 *  - `multiBoardTypeOnly` — a gym-level predicate ("two or more distinct board
 *    types"), not a board-level one. It never clears anything and nothing clears
 *    it.
 */
export type GymBoardFilter = {
  boardTypes?: BoardName[];
  layoutIds?: number[];
  sizeIds?: number[];
  angles?: number[];
  multiBoardTypeOnly?: boolean;
};

export const EMPTY_GYM_BOARD_FILTER: GymBoardFilter = {};

/** True when any board filter term is set. */
export function hasActiveBoardFilter(filter: GymBoardFilter): boolean {
  return (
    (filter.boardTypes?.length ?? 0) > 0 ||
    (filter.layoutIds?.length ?? 0) > 0 ||
    (filter.sizeIds?.length ?? 0) > 0 ||
    (filter.angles?.length ?? 0) > 0 ||
    filter.multiBoardTypeOnly === true
  );
}

/**
 * Everything below the board-type tier, cleared.
 *
 * One helper rather than three inline spreads because the set of deeper tiers is
 * the thing that grows: `angles` joined `layoutIds`/`sizeIds` here, and the next
 * board-scoped filter will too. A caller that spelled the fields out would keep
 * compiling while silently leaving the new one behind.
 */
function clearedBelowBoardType<T extends GymBoardFilter>(filter: T): T & GymBoardFilter {
  return { ...filter, layoutIds: undefined, sizeIds: undefined, angles: undefined };
}

/**
 * Toggle one board type.
 *
 * Generic over the carrier so www can call this on its whole `DirectoryQuery`
 * (keeping `page`, `query`, `latitude`) and mobile on its `WallFinderFilter`
 * (keeping `place`, `name`) without either of them unpacking and rebuilding the
 * board half.
 */
export function toggleBoardTypeFilter<T extends GymBoardFilter>(filter: T, boardType: BoardName): T & GymBoardFilter {
  const current = filter.boardTypes ?? [];
  const next = current.includes(boardType) ? current.filter((type) => type !== boardType) : [...current, boardType];
  return setBoardTypesFilter(filter, next);
}

/**
 * Replace the board-type selection wholesale — what a facet chip means ("show me
 * Kilter" replaces, it does not add).
 *
 * Clears the deeper tiers unless the result is exactly one board type, in BOTH
 * directions: going 1 → 2 invalidates them because the ids become ambiguous, and
 * going 2 → 1 invalidates them because they were never scoped to the survivor in
 * the first place.
 */
export function setBoardTypesFilter<T extends GymBoardFilter>(filter: T, boardTypes: BoardName[]): T & GymBoardFilter {
  const deduped = [...new Set(boardTypes)];
  const current = filter.boardTypes ?? [];
  // Unchanged selection keeps everything: re-applying the same board type (a
  // facet chip clicked twice, or www rebuilding its query object) must not wipe
  // the layout the climber just picked.
  const unchanged = deduped.length === current.length && deduped.every((type) => current.includes(type));
  const next = deduped.length > 0 ? deduped : undefined;
  if (unchanged) return { ...filter, boardTypes: next };
  // Any real change invalidates the tiers below, in BOTH directions. Widening
  // 1 -> 2 makes the ids ambiguous; narrowing 2 -> 1 or swapping one type for
  // another leaves ids that were never scoped to the survivor. Layout id 8 is a
  // Kilter Homewall and nothing at all on MoonBoard.
  return { ...clearedBelowBoardType(filter), boardTypes: next };
}

/**
 * Toggle one layout. Sizes are layout-scoped, so they go whenever we are no
 * longer down to exactly one layout — but `angles` stay, because angles hang off
 * the board type, which has not moved.
 */
export function toggleLayoutFilter<T extends GymBoardFilter>(filter: T, layoutId: number): T & GymBoardFilter {
  const current = filter.layoutIds ?? [];
  const next = current.includes(layoutId) ? current.filter((id) => id !== layoutId) : [...current, layoutId];
  const layoutIds = next.length > 0 ? next : undefined;
  if (next.length === 1) return { ...filter, layoutIds };
  return { ...filter, layoutIds, sizeIds: undefined };
}

/**
 * Toggle a size GROUP. One display label can carry several Aurora size ids — the
 * Kilter Homewall ships "10x10" as a Full Ride, a Mainline and an Auxiliary LED
 * kit, and nobody choosing a gym cares which — so the group moves as a unit: add
 * it whole if any member is missing, otherwise remove it whole.
 */
export function toggleSizeFilter<T extends GymBoardFilter>(filter: T, sizeIds: number[]): T & GymBoardFilter {
  const current = filter.sizeIds ?? [];
  const allSelected = sizeIds.length > 0 && sizeIds.every((id) => current.includes(id));
  const next = allSelected
    ? current.filter((id) => !sizeIds.includes(id))
    : [...current, ...sizeIds.filter((id) => !current.includes(id))];
  return { ...filter, sizeIds: next.length > 0 ? next : undefined };
}

/** Toggle one angle. Bottom of its tier — nothing hangs off an angle. */
export function toggleAngleFilter<T extends GymBoardFilter>(filter: T, angle: number): T & GymBoardFilter {
  const current = filter.angles ?? [];
  const next = current.includes(angle) ? current.filter((value) => value !== angle) : [...current, angle];
  return { ...filter, angles: next.length > 0 ? next : undefined };
}

/** Flip the "two or more distinct board types" gym restriction. */
export function toggleMultiBoardTypeFilter<T extends GymBoardFilter>(filter: T): T & GymBoardFilter {
  return { ...filter, multiBoardTypeOnly: filter.multiBoardTypeOnly ? undefined : true };
}

/** Clear every board filter, leaving whatever else the carrier holds untouched. */
export function clearBoardFilters<T extends GymBoardFilter>(filter: T): T & GymBoardFilter {
  return { ...clearedBelowBoardType(filter), boardTypes: undefined, multiBoardTypeOnly: undefined };
}
