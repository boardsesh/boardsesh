import type { PlaylistClimbSort, PlaylistClimbViewInput } from '@boardsesh/shared-schema';
import { countActiveFilters, isGradeFilterActive } from './active-filter-count';
import { hasActiveBoardFilters, type ClimbBoardFilterState } from './board-filter-state';
import {
  hasActiveClimbFilters,
  toSharedClimbFilterInputFields,
  type ClimbFilterState,
  type SortOrder,
} from './filter-state';

/**
 * A playlist's sorts. `position` is the playlist's own order and the default;
 * `added` is when each climb joined the playlist. Popular and Newest are left
 * out: Popular ranks almost the same as Ascents across a hundred climbs, and
 * Newest reads like Recently added.
 */
export const PLAYLIST_SORT_OPTIONS = [
  'position',
  'added',
  'difficulty',
  'quality',
  'ascents',
  'name',
  'random',
] as const satisfies ReadonlyArray<PlaylistClimbSort>;
export type PlaylistSortOption = (typeof PLAYLIST_SORT_OPTIONS)[number];

/**
 * The direction each playlist sort opens on: playlist order top to bottom,
 * newest additions first, easiest first, best and most-climbed first, A to Z.
 * The server applies the same direction when a view omits `sortOrder`.
 */
export const PLAYLIST_SORT_DEFAULT_ORDER: Readonly<Record<PlaylistSortOption, SortOrder>> = {
  position: 'asc',
  added: 'desc',
  difficulty: 'asc',
  quality: 'desc',
  ascents: 'desc',
  name: 'asc',
  random: 'asc',
};

/**
 * The filter state a playlist screen holds: the Climbs list's filters under the
 * playlist's own sorts, plus the playlist-only "only climbs that fit my board".
 */
export type PlaylistClimbViewState = Omit<ClimbFilterState, 'sortBy'> & {
  sortBy: PlaylistSortOption;
  onlyActiveBoard?: boolean;
};

/**
 * A fresh playlist: its own order, both climb types (a playlist lists what its
 * owner put in it, routes included), no filter. Kept apart from the Climbs
 * list's defaults so a grade band left on the Climbs tab never shrinks a playlist.
 */
export const DEFAULT_PLAYLIST_VIEW_STATE: PlaylistClimbViewState = {
  sortBy: 'position',
  sortOrder: 'asc',
  status: 'any',
  boulders: true,
  routes: true,
};

/**
 * Only what a playlist view can send: the sort put back to the default (it has
 * its own control), and the Climbs-only levers a playlist never applies cleared,
 * so a state carried over from the Climbs list can't show "1 filter" over an
 * empty view. Those levers are "Other angles" (`includeOtherAngles`), the drafts
 * status (and the retired "established") and a setter id.
 */
function playlistFiltersOnly(state: PlaylistClimbViewState): PlaylistClimbViewState {
  return {
    ...state,
    sortBy: DEFAULT_PLAYLIST_VIEW_STATE.sortBy,
    sortOrder: DEFAULT_PLAYLIST_VIEW_STATE.sortOrder,
    includeOtherAngles: undefined,
    status: state.status === 'projects' ? 'projects' : DEFAULT_PLAYLIST_VIEW_STATE.status,
  };
}

function playlistBoardFiltersOnly(boardFilters: ClimbBoardFilterState | undefined): ClimbBoardFilterState | undefined {
  if (!boardFilters) return undefined;
  const { setterId: _setterIdPlaylistsIgnore, ...playlistBoardFilters } = boardFilters;
  return playlistBoardFilters;
}

/**
 * True when any FILTER differs from a fresh playlist, ignoring the sort. Drives
 * the "12 of 117 climbs" line and `unfilteredCount`: a sort alone hides nothing.
 */
export function hasActivePlaylistFilters(
  state: PlaylistClimbViewState,
  boardFilters?: ClimbBoardFilterState,
  name?: string,
): boolean {
  if (state.onlyActiveBoard) return true;
  if (name != null && name.trim().length > 0) return true;
  const playlistBoardFilters = playlistBoardFiltersOnly(boardFilters);
  if (playlistBoardFilters && hasActiveBoardFilters(playlistBoardFilters)) return true;
  return hasActiveClimbFilters(playlistFiltersOnly(state), DEFAULT_PLAYLIST_VIEW_STATE);
}

/**
 * True when the screen needs a view at all: a sort other than the playlist's
 * order, or any filter. False means the request goes out exactly as it did
 * before views existed.
 */
export function hasActivePlaylistView(
  state: PlaylistClimbViewState,
  boardFilters?: ClimbBoardFilterState,
  name?: string,
): boolean {
  if (state.sortBy !== DEFAULT_PLAYLIST_VIEW_STATE.sortBy) return true;
  if (state.sortOrder !== DEFAULT_PLAYLIST_VIEW_STATE.sortOrder) return true;
  return hasActivePlaylistFilters(state, boardFilters, name);
}

/**
 * The filter badge count for a playlist: every active filter, grade and board
 * filters included, measured against a fresh playlist and ignoring the sort (it
 * has its own control). `onlyActiveBoard` counts as one.
 */
export function countActivePlaylistFilters(
  state: PlaylistClimbViewState,
  boardFilters?: ClimbBoardFilterState,
): number {
  const filterCount = countActiveFilters(
    playlistFiltersOnly(state),
    playlistBoardFiltersOnly(boardFilters),
    DEFAULT_PLAYLIST_VIEW_STATE,
  );
  return filterCount + (state.onlyActiveBoard ? 1 : 0);
}

export type PlaylistViewInputOptions = {
  /** The name search, which lives in the sheet as a token. */
  name?: string;
  /** The climber's "use my grades" preference. Only sent when it can change the answer. */
  personalGrades?: boolean;
  /** Whether rows show Boardsesh grades, so the grade filter and difficulty sort read those. */
  boardseshGrades?: boolean;
  /** Benchmarks, holds and zone: the filters that need the board surface to edit. */
  boardFilters?: ClimbBoardFilterState;
};

/**
 * The `view` for `GetPlaylistClimbsInput`, or `undefined` for a fresh playlist so
 * the default request stays byte-identical to the one sent before views existed
 * (and an older backend, which rejects the field, keeps answering it).
 *
 * The filter fields go through the same mapper as the Climbs search
 * (`toSharedClimbFilterInputFields`), so the two lists read a filter state the
 * same way. A playlist has no drafts view and no cross-angle switch, so the
 * Climbs-only `onlyDrafts` and `crossAngleStats` never appear here.
 */
export function toPlaylistClimbViewInput(
  state: PlaylistClimbViewState,
  options: PlaylistViewInputOptions = {},
): PlaylistClimbViewInput | undefined {
  if (!hasActivePlaylistView(state, options.boardFilters, options.name)) return undefined;

  const sortsByDifficulty = state.sortBy === 'difficulty';
  const { boulders, routes, ...sharedFields } = toSharedClimbFilterInputFields(state, {
    name: options.name?.trim(),
    personalGrades: options.personalGrades,
    sortsByDifficulty,
    shuffled: state.sortBy === 'random',
    climbTypeDefaults: DEFAULT_PLAYLIST_VIEW_STATE,
  });

  const view: PlaylistClimbViewInput = {
    sortBy: state.sortBy,
    sortOrder: state.sortOrder,
    ...sharedFields,
  };
  // Both climb types is a fresh playlist's default, so it is omitted rather than
  // sent as an explicit pair: one climb type alone is the only real filter.
  if (boulders !== routes) {
    if (boulders) view.boulders = true;
    if (routes) view.routes = true;
  }
  // Same rule as the Climbs list (`withSearchGradeSource` in the mobile app): the
  // source only matters to a grade band or a difficulty sort.
  if (options.boardseshGrades && (isGradeFilterActive(state) || sortsByDifficulty)) {
    view.gradeSource = 'BOARDSESH';
  }
  const boardFilters = options.boardFilters;
  if (boardFilters?.onlyBenchmarks) view.onlyBenchmarks = true;
  if (boardFilters?.holdsFilter && Object.keys(boardFilters.holdsFilter).length > 0) {
    view.holdsFilter = boardFilters.holdsFilter;
  }
  if (boardFilters?.zoneBox != null) {
    view.zoneBox = boardFilters.zoneBox;
    if (boardFilters.zoneMode) view.zoneMode = boardFilters.zoneMode;
  }
  if (state.onlyActiveBoard) view.onlyActiveBoard = true;
  return view;
}
