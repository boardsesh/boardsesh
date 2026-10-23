import { newSortSeed, type ClimbFilterState, type SortOption } from './filter-state';

/**
 * The patch a tap on a Climbs sort key writes. Tapping (or re-tapping) Random
 * mints a fresh seed, which is a new shuffle; any other key clears the seed so
 * it never lingers in the search input. The direction is left as it was.
 */
export function sortKeyPatch(sortBy: SortOption): Pick<ClimbFilterState, 'sortBy' | 'sortSeed'> {
  return { sortBy, sortSeed: sortBy === 'random' ? newSortSeed() : undefined };
}
