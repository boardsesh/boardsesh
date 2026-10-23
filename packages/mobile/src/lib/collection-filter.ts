import { applyStatusChange, type ClimbFilterState, type ClimbBoardFilterState } from '@boardsesh/climb-filters';

// "Collection" is a single-select over mutually-exclusive pools of climbs that
// live in three underlying flags: setter-flagged Benchmarks (a board filter,
// `onlyBenchmarks`), your unpublished My drafts (`status='drafts'`) and the
// climbs you hearted, Liked (`onlyFavorited`, #6002). One control, so exactly
// one applies at a time. Drafts and Liked are auth-only, so they are offered
// only when signed in.
export const COLLECTION_VALUES = ['any', 'benchmarks', 'drafts', 'liked'] as const;
export type CollectionFilter = (typeof COLLECTION_VALUES)[number];

/**
 * The Collection values a chip menu offers. My drafts needs a signed-in user. A
 * spray wall has no benchmarks (#5960), so Benchmarks stays only while it is the
 * active value, which keeps a filter picked on another board undoable. Same rule
 * as the filter sheet's Collection segment.
 */
export function visibleCollectionValues(options: {
  canFilterPersonalCollections: boolean;
  isSprayWall: boolean;
  current: CollectionFilter;
}): CollectionFilter[] {
  const { canFilterPersonalCollections, isSprayWall, current } = options;
  return COLLECTION_VALUES.filter((value) => {
    if (isPersonalCollection(value)) return canFilterPersonalCollections;
    if (value === 'benchmarks') return !isSprayWall || current === 'benchmarks';
    return true;
  });
}

/** The options that need an account; hidden from the picker when signed out. */
export function isPersonalCollection(value: CollectionFilter): boolean {
  return value === 'drafts' || value === 'liked';
}

/** Narrows a raw native-picker tag to a {@link CollectionFilter}. */
export function isCollectionFilter(value: string): value is CollectionFilter {
  return (COLLECTION_VALUES as readonly string[]).includes(value);
}

/** Reads the current Collection choice out of the three underlying flags. */
export function getCollectionFilter(
  filters: Pick<ClimbFilterState, 'status' | 'onlyFavorited'>,
  boardFilters: Pick<ClimbBoardFilterState, 'onlyBenchmarks'>,
): CollectionFilter {
  if (boardFilters.onlyBenchmarks) return 'benchmarks';
  if (filters.status === 'drafts') return 'drafts';
  if (filters.onlyFavorited) return 'liked';
  return 'any';
}

/**
 * The patches that select one Collection option. Picking any option clears the
 * other two flags, so exactly one pool applies. Only a lingering 'drafts' status
 * is reset; 'projects' (Unrepeated) belongs to Popularity and can coexist.
 * Shared by the chip row and the filter sheet so they can't drift.
 */
export function collectionPatch(
  value: CollectionFilter,
  filters: ClimbFilterState,
): { filters: Partial<ClimbFilterState>; boardFilters: Partial<ClimbBoardFilterState> } {
  let statusPatch: Partial<ClimbFilterState> = {};
  if (value === 'drafts') statusPatch = applyStatusChange(filters, 'drafts');
  else if (filters.status === 'drafts') statusPatch = applyStatusChange(filters, 'any');
  return {
    filters: { ...statusPatch, onlyFavorited: value === 'liked' || undefined },
    boardFilters: { onlyBenchmarks: value === 'benchmarks' || undefined },
  };
}

// "Climb type" is a single-select over the boulders/routes flags. The type, its
// values, the reader and the patch live in @boardsesh/climb-filters so the chip
// row, the filter sheet and every list read and write it the same way.
export { CLIMB_TYPE_VALUES, climbTypePatch, getClimbTypeFilter, type ClimbTypeFilter } from '@boardsesh/climb-filters';
