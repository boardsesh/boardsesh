import {
  hasActiveBoardFilters,
  hasActiveClimbFilters,
  mergeBoardFilters,
  toClimbSearchInput,
  DEFAULT_CLIMB_BOARD_FILTER_STATE,
  type BoardSearchConfig,
} from '@boardsesh/climb-filters';
import type { ClimbSearchInput } from '@boardsesh/shared-schema';
import { DEFAULT_FILTERS, filtersForBoard, type ClimbFilters } from '../../../lib/climb-filter-types';
import type { LastSearch } from '../../../lib/last-search-store';

/** The climb list's saved search, minus the bookkeeping the heatmap has no use for. */
export type HeatmapSearch = Pick<LastSearch, 'filters' | 'boardFilters' | 'searchText'>;

/**
 * Ordering and paging decide which climbs a list page shows, never which climbs
 * match. Dropped so a sort change in the list does not refetch the heatmap.
 */
function withoutListFields(input: ClimbSearchInput): ClimbSearchInput {
  const {
    page: _page,
    pageSize: _pageSize,
    sortBy: _sortBy,
    sortOrder: _sortOrder,
    sortSeed: _sortSeed,
    ...rest
  } = input;
  return rest;
}

/** The filter state with sort reset, so "filtered" never means only "sorted differently". */
function withDefaultSort(filters: ClimbFilters): ClimbFilters {
  return { ...filters, sortBy: DEFAULT_FILTERS.sortBy, sortOrder: DEFAULT_FILTERS.sortOrder, sortSeed: undefined };
}

/**
 * Whether the saved search narrows the climbs at all. A search that only changed
 * the sort order is the whole board, so the chip does not claim a filter.
 */
export function isHeatmapSearchFiltered(search: HeatmapSearch | null | undefined): search is HeatmapSearch {
  if (!search) return false;
  return (
    hasActiveClimbFilters(withDefaultSort(search.filters)) ||
    hasActiveBoardFilters(search.boardFilters) ||
    search.searchText.trim().length > 0
  );
}

/**
 * The search the heatmap aggregates over: the climb list's own input for this
 * board config — built the way `app/(tabs)/climbs/index.tsx` builds it, with
 * `toClimbSearchInput` + `filtersForBoard` + `mergeBoardFilters` — or, with no
 * search, the default list (every boulder on the board).
 */
export function heatmapSearchInput(board: BoardSearchConfig, search: HeatmapSearch | null): ClimbSearchInput {
  const filters = search ? filtersForBoard(withDefaultSort(search.filters), board.boardName) : DEFAULT_FILTERS;
  const name = search?.searchText.trim() ?? '';
  const input = toClimbSearchInput(filters, board, { page: 0, pageSize: 1 }, { name });
  return withoutListFields(mergeBoardFilters(input, search?.boardFilters ?? DEFAULT_CLIMB_BOARD_FILTER_STATE));
}
