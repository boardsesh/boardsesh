// Picking a saved search, shared by the two places that offer them: the climbs
// toolbar's Recent menu (components/search/climb-capsules.ts) and the chips
// under Recent in Filters (components/filter-sheet/RecentSearchRail.tsx). Both
// go through these helpers and the screen's one apply handler, so a saved
// search is applied the same way wherever it was picked.

import type { ClimbFilters } from './climb-filter-types';
import { getFilterKey } from './filter-key';
import type { RecentFilter } from './recent-filter-store';

/** The screen's handler that puts a saved search in force. */
export type ApplyRecentFilter = (filters: ClimbFilters, searchText: string) => void;

/** The saved search that matches what is in force now, if any: the one to mark as current. */
export function findCurrentRecentFilter(
  recents: readonly RecentFilter[],
  currentFilters: ClimbFilters,
  currentSearchText: string,
): RecentFilter | undefined {
  const currentKey = getFilterKey(currentFilters, currentSearchText);
  return recents.find((recent) => getFilterKey(recent.filters, recent.searchText) === currentKey);
}

/** Applies the saved search with this id. An id that is no longer saved does nothing. */
export function applyRecentFilterById(
  recents: readonly RecentFilter[],
  id: string,
  onApplyRecent: ApplyRecentFilter,
): void {
  const recent = recents.find((entry) => entry.id === id);
  if (recent) onApplyRecent(recent.filters, recent.searchText);
}
