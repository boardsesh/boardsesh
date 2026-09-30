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
import { isOfflineSearchSupported } from '../../../db/queries/search-climbs-local';

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

/**
 * The search the phone can actually run. A hold-state pick ("this hold as a
 * start") needs a table the phone does not sync, so rather than refusing the
 * whole heatmap the picks are dropped and the rest of the filters still apply;
 * the chip says so.
 */
export function localHeatmapInput(input: ClimbSearchInput): {
  input: ClimbSearchInput;
  holdPicksSkipped: boolean;
  unsupported: boolean;
} {
  if (isOfflineSearchSupported(input)) return { input, holdPicksSkipped: false, unsupported: false };
  if (input.holdsFilter != null) {
    const { holdsFilter: _holdsFilter, ...withoutHoldPicks } = input;
    if (isOfflineSearchSupported(withoutHoldPicks)) {
      return { input: withoutHoldPicks, holdPicksSkipped: true, unsupported: false };
    }
  }
  return { input, holdPicksSkipped: false, unsupported: true };
}
