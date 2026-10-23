import { newSortSeed, type ClimbFilterState, type SortOption, type SortOrder } from './filter-state';
import { PLAYLIST_SORT_DEFAULT_ORDER, type PlaylistSortOption } from './playlist-view';

/**
 * The patch a tap on a Climbs sort key writes. Tapping (or re-tapping) Random
 * mints a fresh seed, which is a new shuffle; any other key clears the seed so
 * it never lingers in the search input. The direction is left as it was.
 */
export function sortKeyPatch(sortBy: SortOption): Pick<ClimbFilterState, 'sortBy' | 'sortSeed'> {
  return { sortBy, sortSeed: sortBy === 'random' ? newSortSeed() : undefined };
}

/** A playlist's whole sort: key, direction, and the seed Random needs. */
export type PlaylistSort = {
  sortBy: PlaylistSortOption;
  sortOrder: SortOrder;
  sortSeed?: string;
};

/**
 * The sort a tap on a playlist sort key selects. Each key opens on its own
 * direction (`PLAYLIST_SORT_DEFAULT_ORDER`): playlist order top to bottom,
 * newest additions first, easiest first, best and most-climbed first, A to Z.
 * Random gets a fresh seed, so a re-tap is a new shuffle.
 */
export function playlistSortPatch(sortBy: PlaylistSortOption): PlaylistSort {
  const sort: PlaylistSort = { sortBy, sortOrder: PLAYLIST_SORT_DEFAULT_ORDER[sortBy] };
  if (sortBy === 'random') sort.sortSeed = newSortSeed();
  return sort;
}
