// The pure state behind `useClimbFilterSession` (hooks/use-climb-filter-session.ts):
// one list's filters, board filters, name search, sort and "fits my board", plus
// the sort kept aside while the screen shows its default view (playlist edit
// mode). A reducer rather than ClimbSearchProvider: that provider's reset goes
// back to the Climbs defaults, its context bundles state with actions, and the
// Climbs list is its only consumer. Same shape as the Logbook's
// `use-logbook-search.ts`.
//
// The sort lives only in `sort`, never in `filters`: a list with sorts of its own
// (a playlist's "Playlist order", "Recently added") cannot write them into the
// Climbs `SortOption` field. Every write puts the filters' sort fields back to
// the list's inert defaults, so a sort can never leak into the filter count, the
// tokens or a request through them.

import { DEFAULT_CLIMB_BOARD_FILTER_STATE, type ClimbBoardFilterState, type SortOrder } from '@boardsesh/climb-filters';
import type { ClimbFilters } from './climb-filter-types';
import { applyPopularityBucket } from './filter-chip-menus';
import { collectionPatch, type CollectionFilter } from './collection-filter';

/** A list's whole sort: key, direction, and the seed a shuffle needs. */
export type SessionSort<K extends string> = {
  sortBy: K;
  sortOrder: SortOrder;
  sortSeed?: string;
};

/** What the chip row and the sheet call each sort. Literal i18n keys live in the model. */
export type SessionSortLabels<K extends string> = {
  keyLabel: (sortBy: K) => string;
  /** "Easiest first" / "Hardest first" and friends. */
  directionLabel: (sortBy: K, sortOrder: SortOrder) => string;
  /** The resting chip label: the default sort's own name ("Playlist order"). */
  resting: string;
};

/** A list's sorts: which keys, the default, and how each key behaves. */
export type SessionSortModel<K extends string> = {
  options: readonly K[];
  defaultSort: SessionSort<K>;
  /** The direction a key opens on. */
  defaultOrder: (sortBy: K) => SortOrder;
  /** The sort a tap on a key selects: its default direction, a fresh seed for a shuffle. */
  patchFor: (sortBy: K) => SessionSort<K>;
  /** Whether the key offers two directions (the playlist's own order and Random do not). */
  hasDirection: (sortBy: K) => boolean;
  /** Whether the key shuffles, so the sheet offers "Shuffle again" in place of a direction. */
  isShuffle: (sortBy: K) => boolean;
  /** Narrows a raw menu tag to a key. */
  isOption: (value: string) => value is K;
  /** Called during render by the session hook. Keep the model a module constant. */
  useLabels: () => SessionSortLabels<K>;
};

/** Everything one list view is made of: what the session hands its screen and its query. */
export type ClimbFilterSessionSelection<K extends string> = {
  filters: ClimbFilters;
  boardFilters: ClimbBoardFilterState;
  name: string;
  sort: SessionSort<K>;
  boardFit: boolean;
};

export type ClimbFilterSessionState<K extends string> = {
  filters: ClimbFilters;
  boardFilters: ClimbBoardFilterState;
  /** The committed (debounced) name search. */
  name: string;
  sort: SessionSort<K>;
  boardFit: boolean;
  /** The sort kept aside while the screen shows its default view; null otherwise. */
  pausedSort: SessionSort<K> | null;
  /** The list's own starting filters: what Clear and Reset go back to. Constant. */
  defaultFilters: ClimbFilters;
  /** The list's own starting sort: what Reset goes back to. Constant. */
  defaultSort: SessionSort<K>;
  /**
   * The board the hold and zone picks were made on (`boardGeometryKey`), or null
   * before any board. Hold ids and a region belong to one board's geometry.
   */
  boardGeometry: string | null;
};

export type ClimbFilterSessionAction<K extends string> =
  | { type: 'replaceSelection'; filters: ClimbFilters; boardFilters: ClimbBoardFilterState }
  | { type: 'patchFilters'; patch: Partial<ClimbFilters> }
  | { type: 'patchBoardFilters'; patch: Partial<ClimbBoardFilterState> }
  | { type: 'popularity'; bucket: number | undefined }
  | { type: 'collection'; value: CollectionFilter }
  | { type: 'toggleBeta' }
  | { type: 'setName'; name: string }
  | { type: 'setSort'; sort: SessionSort<K> }
  /**
   * A tap on a sort key: its opening sort. A re-tap of the key in force keeps the
   * climber's direction, unless the key shuffles (`model.isShuffle`), where a
   * re-tap is a new shuffle. The flag is required, so the reducer never has to
   * guess a shuffle from whether a seed came along.
   */
  | { type: 'selectSortKey'; sort: SessionSort<K>; shuffles: boolean }
  | { type: 'setSortOrder'; sortOrder: SortOrder }
  | { type: 'reshuffle'; sortSeed: string }
  | { type: 'setBoardFit'; boardFit: boolean }
  | { type: 'toggleBoardFit' }
  | { type: 'clearFilters' }
  | { type: 'resetToDefault' }
  | { type: 'pauseView' }
  | { type: 'resumeView' }
  /**
   * The list now shows `geometry`'s board. A different board drops the hold and
   * zone picks: hold ids from one board must never filter another. No board
   * (null) keeps them, so they come back with the same board.
   */
  | { type: 'boardGeometry'; geometry: string | null };

/**
 * The part of a board its hold ids and regions belong to: the board, layout,
 * size and hold sets. The angle is left out: tilting the wall keeps the holds.
 */
export function boardGeometryKey(board: {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
}): string {
  return `${board.boardName}|${board.layoutId}|${board.sizeId}|${board.setIds}`;
}

export function createClimbFilterSessionState<K extends string>(options: {
  defaultFilters: ClimbFilters;
  defaultSort: SessionSort<K>;
  initialSort: SessionSort<K>;
  boardGeometry?: string | null;
}): ClimbFilterSessionState<K> {
  return {
    filters: options.defaultFilters,
    boardFilters: DEFAULT_CLIMB_BOARD_FILTER_STATE,
    name: '',
    sort: options.initialSort,
    boardFit: false,
    pausedSort: null,
    defaultFilters: options.defaultFilters,
    defaultSort: options.defaultSort,
    boardGeometry: options.boardGeometry ?? null,
  };
}

/** The board filters without the hold and zone picks. Same reference when there are none. */
function withoutGeometryFilters(boardFilters: ClimbBoardFilterState): ClimbBoardFilterState {
  if (boardFilters.holdsFilter === undefined && boardFilters.zoneBox == null && boardFilters.zoneMode === undefined) {
    return boardFilters;
  }
  const {
    holdsFilter: _droppedHoldsFilter,
    zoneBox: _droppedZoneBox,
    zoneMode: _droppedZoneMode,
    ...otherBoardFilters
  } = boardFilters;
  return Object.keys(otherBoardFilters).length === 0 ? DEFAULT_CLIMB_BOARD_FILTER_STATE : otherBoardFilters;
}

/** The filters with their sort fields back on the list's inert defaults. Same reference when they already are. */
function withInertSort(filters: ClimbFilters, defaults: ClimbFilters): ClimbFilters {
  if (
    filters.sortBy === defaults.sortBy &&
    filters.sortOrder === defaults.sortOrder &&
    filters.sortSeed === undefined
  ) {
    return filters;
  }
  const { sortSeed: _droppedSortSeed, ...filtersWithoutSeed } = filters;
  return { ...filtersWithoutSeed, sortBy: defaults.sortBy, sortOrder: defaults.sortOrder };
}

/** Filters, board filters, name and "fits my board" back to the list's start. The sort is the caller's. */
function withFiltersCleared<K extends string>(state: ClimbFilterSessionState<K>): ClimbFilterSessionState<K> {
  return {
    ...state,
    filters: state.defaultFilters,
    boardFilters: DEFAULT_CLIMB_BOARD_FILTER_STATE,
    name: '',
    boardFit: false,
  };
}

function isCleared<K extends string>(state: ClimbFilterSessionState<K>): boolean {
  return (
    state.filters === state.defaultFilters &&
    state.boardFilters === DEFAULT_CLIMB_BOARD_FILTER_STATE &&
    state.name === '' &&
    !state.boardFit
  );
}

export function climbFilterSessionReducer<K extends string>(
  state: ClimbFilterSessionState<K>,
  action: ClimbFilterSessionAction<K>,
): ClimbFilterSessionState<K> {
  switch (action.type) {
    case 'replaceSelection':
      return {
        ...state,
        filters: withInertSort(action.filters, state.defaultFilters),
        boardFilters: action.boardFilters,
      };
    case 'patchFilters':
      return { ...state, filters: withInertSort({ ...state.filters, ...action.patch }, state.defaultFilters) };
    case 'patchBoardFilters':
      return { ...state, boardFilters: { ...state.boardFilters, ...action.patch } };
    case 'popularity':
      // Same conflict-clear as the Climbs chip: a bucket clears a projects or
      // drafts status that would leave it inert.
      return {
        ...state,
        filters: withInertSort(
          { ...state.filters, ...applyPopularityBucket(state.filters, action.bucket) },
          state.defaultFilters,
        ),
      };
    case 'collection': {
      const patch = collectionPatch(action.value, state.filters);
      return {
        ...state,
        filters: withInertSort({ ...state.filters, ...patch.filters }, state.defaultFilters),
        boardFilters: { ...state.boardFilters, ...patch.boardFilters },
      };
    }
    case 'toggleBeta':
      return {
        ...state,
        filters: { ...state.filters, onlyWithBetaVideos: state.filters.onlyWithBetaVideos ? undefined : true },
      };
    case 'setName':
      return state.name === action.name ? state : { ...state, name: action.name };
    case 'setSort':
      return { ...state, sort: action.sort };
    case 'selectSortKey':
      // Re-picking the key in force keeps the climber's direction, as on the
      // Climbs list. A shuffling key (Random) takes the new sort: a new shuffle.
      return state.sort.sortBy === action.sort.sortBy && !action.shuffles ? state : { ...state, sort: action.sort };
    case 'setSortOrder':
      return state.sort.sortOrder === action.sortOrder
        ? state
        : { ...state, sort: { ...state.sort, sortOrder: action.sortOrder } };
    case 'reshuffle':
      return { ...state, sort: { ...state.sort, sortSeed: action.sortSeed } };
    case 'setBoardFit':
      return state.boardFit === action.boardFit ? state : { ...state, boardFit: action.boardFit };
    case 'toggleBoardFit':
      return { ...state, boardFit: !state.boardFit };
    case 'clearFilters':
      // Clear keeps the sort: a sort hides nothing, so "Clear filters" leaves it.
      return isCleared(state) ? state : withFiltersCleared(state);
    case 'resetToDefault':
      return { ...withFiltersCleared(state), sort: state.defaultSort, pausedSort: null };
    case 'pauseView':
      // The default view while the owner edits: filters cleared, the sort kept
      // aside (not forgotten) so `resumeView` can put it back.
      return {
        ...withFiltersCleared(state),
        sort: state.defaultSort,
        pausedSort: state.pausedSort ?? state.sort,
      };
    case 'resumeView':
      return state.pausedSort ? { ...state, sort: state.pausedSort, pausedSort: null } : state;
    case 'boardGeometry':
      if (action.geometry === null || action.geometry === state.boardGeometry) return state;
      return {
        ...state,
        boardGeometry: action.geometry,
        // The first board just records itself: nothing was picked on another.
        boardFilters: state.boardGeometry === null ? state.boardFilters : withoutGeometryFilters(state.boardFilters),
      };
    default:
      return state;
  }
}
