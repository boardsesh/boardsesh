import type { Climb, ClimbSearchInput } from '@boardsesh/shared-schema';
import {
  DEFAULT_CLIMB_FILTER_STATE,
  newSortSeed,
  toClimbSearchInput,
  type ClimbFilterState,
  type SortOption,
  type SortOrder,
} from '@boardsesh/climb-filters';
import { toSearchConfig, type ActiveBoard } from '../board/active-board';

export const CLIMB_SORTS = ['popular', 'quality', 'easiest', 'hardest', 'newest', 'random'] as const;
export type ClimbSort = (typeof CLIMB_SORTS)[number];

export const SORT_LABELS: Record<ClimbSort, string> = {
  popular: 'Most sent',
  quality: 'Best rated',
  easiest: 'Easiest first',
  hardest: 'Hardest first',
  newest: 'Newest',
  random: 'Shuffle',
};

const SORT_QUERY: Record<ClimbSort, { sortBy: SortOption; sortOrder: SortOrder }> = {
  popular: { sortBy: 'ascents', sortOrder: 'desc' },
  quality: { sortBy: 'quality', sortOrder: 'desc' },
  easiest: { sortBy: 'difficulty', sortOrder: 'asc' },
  hardest: { sortBy: 'difficulty', sortOrder: 'desc' },
  newest: { sortBy: 'creation', sortOrder: 'desc' },
  random: { sortBy: 'random', sortOrder: 'desc' },
};

/** The filters the Session tab offers. Deliberately few; each maps onto Boardsesh's search. */
export type ClimbFilters = {
  sort: ClimbSort;
  /** Difficulty ids, inclusive. Null means open-ended. */
  minGrade: number | null;
  maxGrade: number | null;
  /** MoonBoard benchmarks, or the setter-verified classics on other boards. */
  benchmarksOnly: boolean;
  /** Hide climbs the climber has already sent. Needs sign-in. */
  hideSent: boolean;
  /** Minimum average rating, 1-5 stars. */
  minStars: number | null;
  /** Keeps one shuffle stable across pages; replaced whenever Shuffle is picked. */
  shuffleSeed: string | null;
};

export const DEFAULT_CLIMB_FILTERS: ClimbFilters = {
  sort: 'popular',
  minGrade: null,
  maxGrade: null,
  benchmarksOnly: false,
  hideSent: false,
  minStars: null,
  shuffleSeed: null,
};

export const PAGE_SIZE = 30;

/**
 * Sorting by grade leaves out climbs nobody has repeated. They're mostly
 * ungraded, and sorted easiest-first a whole page of them came before the
 * first real grade. Leaving them out also takes the query from about 5 s to 1 s.
 */
const GRADE_SORTS: readonly ClimbSort[] = ['easiest', 'hardest'];

/** Whether a climb belongs in the list for this sort: grade sorts skip the odd ungraded one. */
export function listsClimb(filters: ClimbFilters, climb: Pick<Climb, 'difficulty'>): boolean {
  return !GRADE_SORTS.includes(filters.sort) || Boolean(climb.difficulty);
}

/** Apply a sort change, minting a fresh shuffle each time Shuffle is chosen. */
export function withSort(filters: ClimbFilters, sort: ClimbSort): ClimbFilters {
  return { ...filters, sort, shuffleSeed: sort === 'random' ? newSortSeed() : null };
}

/** How many filters differ from the defaults (sort excluded), for the filter button's badge. */
export function countActiveFilters(filters: ClimbFilters): number {
  return (
    (filters.minGrade !== null || filters.maxGrade !== null ? 1 : 0) +
    (filters.benchmarksOnly ? 1 : 0) +
    (filters.hideSent ? 1 : 0) +
    (filters.minStars !== null ? 1 : 0)
  );
}

export function buildSearchInput(
  board: ActiveBoard,
  filters: ClimbFilters,
  options: {
    name: string;
    page: number;
    signedIn: boolean;
    /** Their climbs instead of a name search: what a search found in setter names. */
    setters?: readonly string[];
  },
): ClimbSearchInput {
  const sort = SORT_QUERY[filters.sort];
  const state: ClimbFilterState = {
    ...DEFAULT_CLIMB_FILTER_STATE,
    ...sort,
    ...(filters.sort === 'random' && filters.shuffleSeed ? { sortSeed: filters.shuffleSeed } : {}),
    ...(filters.minGrade !== null ? { minGrade: filters.minGrade } : {}),
    ...(filters.maxGrade !== null ? { maxGrade: filters.maxGrade } : {}),
    ...(filters.minStars !== null ? { minRating: filters.minStars } : {}),
    // The backend rejects personal filters from anonymous searches.
    ...(filters.hideSent && options.signedIn ? { hideCompleted: true } : {}),
    ...(GRADE_SORTS.includes(filters.sort) ? { minAscents: 1 } : {}),
    ...(options.setters ? { setter: [...options.setters] } : {}),
  };
  const input = toClimbSearchInput(
    state,
    toSearchConfig(board),
    { page: options.page, pageSize: PAGE_SIZE },
    { name: options.setters ? '' : options.name.trim() },
  );
  if (filters.benchmarksOnly) input.onlyBenchmarks = true;
  return input;
}
