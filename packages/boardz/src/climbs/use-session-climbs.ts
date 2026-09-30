import type { Climb } from '@boardsesh/shared-schema';
import type { ActiveBoard } from '../board/active-board';
import { listsClimb, type ClimbFilters } from './climb-filters';
import { useSetterMatches } from './setter-search';
import { useClimbCount, useClimbSearch } from './use-climb-search';

const NO_SETTERS: readonly string[] = [];

/**
 * The Session list: climbs whose name matches the search, then the climbs of
 * setters whose name matches it, and how many there are in all.
 */
export function useSessionClimbs(board: ActiveBoard | null, filters: ClimbFilters, searchName: string) {
  const byName = useClimbSearch(board, filters, { name: searchName });
  const nameCount = useClimbCount(board, filters, { name: searchName });
  const setterMatches = useSetterMatches(board, searchName);
  const setters = searchName.trim() ? (setterMatches.data ?? NO_SETTERS) : NO_SETTERS;
  const bySetter = useClimbSearch(board, filters, { name: '', setters });
  const setterCount = useClimbCount(board, filters, { name: '', setters });

  const named = byName.data?.pages.flatMap((page) => page.climbs) ?? [];
  // Setter results join once the name matches are all in, so rows never slot in above what's shown.
  const fromSetters = byName.hasNextPage ? [] : (bySetter.data?.pages.flatMap((page) => page.climbs) ?? []);
  const seen = new Set(named.map((climb) => climb.uuid));
  const climbs: Climb[] = [...named, ...fromSetters.filter((climb) => !seen.has(climb.uuid))].filter((climb) =>
    listsClimb(filters, climb),
  );

  const searchingSetters = setters.length > 0;
  const total =
    nameCount.data === undefined
      ? undefined
      : searchingSetters
        ? setterCount.data === undefined
          ? undefined
          : nameCount.data + setterCount.data
        : nameCount.data;

  return {
    climbs,
    /** How many climbs the filters and search find; undefined while counting. */
    total,
    isPending: byName.isPending || (searchingSetters && bySetter.isPending),
    isError: byName.isError,
    error: byName.error,
    /** The rows shown are the last results while new ones load. */
    isPlaceholderData: byName.isPlaceholderData,
    isRefetching: byName.isRefetching || bySetter.isRefetching,
    isFetchingMore: byName.isFetchingNextPage || bySetter.isFetchingNextPage,
    // refetch() runs even a disabled query, so the setter half only joins while it's searching.
    refetch: () =>
      Promise.all([
        byName.refetch(),
        nameCount.refetch(),
        ...(searchingSetters ? [bySetter.refetch(), setterCount.refetch()] : []),
      ]),
    fetchMore: () => {
      if (byName.hasNextPage) {
        if (!byName.isFetchingNextPage) void byName.fetchNextPage();
      } else if (bySetter.hasNextPage && !bySetter.isFetchingNextPage) {
        void bySetter.fetchNextPage();
      }
    },
  };
}
