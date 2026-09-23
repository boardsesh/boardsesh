import type { GymBoardFilter } from '@boardsesh/gym-filters';
import { clearBoardFilters, hasActiveBoardFilter } from '@boardsesh/gym-filters';

/**
 * The applied filter for the Find Gym ("Wall Finder") screen.
 *
 * The board half — board types, layouts, sizes, angles, the multi-board toggle,
 * and every cascade rule that keeps them consistent — lives in
 * `@boardsesh/gym-filters`, shared with the www gym directory. What stays here is
 * the two terms only this screen has:
 *
 * - `name` — the applied name filter (gyms/boards `ILIKE`). Mutually exclusive
 *   with `place`: a typed place RELOCATES the map (it is not a filter term), so
 *   the two are never ANDed (a place like "Tokyo" would otherwise hide every gym
 *   not literally named after it).
 * - `place` — the label of a geocoded place search ("Showing <place>"); the
 *   camera move itself is viewport state, not stored here.
 *
 * `viewCenter` / `searchLabel` stay separate viewport state on the screen — this
 * is the FILTER, not the camera.
 */
export type WallFinderFilter = GymBoardFilter & {
  place?: string;
  name?: string;
};

export const DEFAULT_WALL_FINDER_FILTER: WallFinderFilter = {};

/** True when any filter term is set (name, or any board filter). */
export function hasActiveWallFinderFilter(filter: WallFinderFilter): boolean {
  return Boolean(filter.name && filter.name.length > 0) || hasActiveBoardFilter(filter);
}

/** Clear every chip filter, leaving the name/place search and viewport untouched. */
export function clearWallFinderChipFilters(filter: WallFinderFilter): WallFinderFilter {
  return clearBoardFilters(filter);
}

/**
 * Re-exported under the names this screen has always used, so the chip components
 * and the screen keep one import site while the logic lives in the shared package.
 */
export {
  buildLayoutOptions,
  buildSizeOptions,
  buildAngleOptions,
  toggleBoardTypeFilter,
  toggleLayoutFilter,
  toggleSizeFilter,
  toggleAngleFilter,
  toggleMultiBoardTypeFilter,
} from '@boardsesh/gym-filters';

export type {
  LayoutFilterOption as WallFinderLayoutOption,
  SizeFilterOption as WallFinderSizeOption,
} from '@boardsesh/gym-filters';
