import { applyStatusChange, type ClimbFilterState } from '@boardsesh/climb-filters';

// "Collection" is a single-select over two mutually exclusive pools of a
// climber's own climbs: unpublished My drafts (`status='drafts'`) and the climbs
// they hearted, Liked (`onlyFavorited`, #6002). Both are auth-only, so they are
// offered only when signed in. Benchmarks (Verified on Kilter) used to be a third
// option; it is its own switch now, so it combines with either (#2493).
export const COLLECTION_VALUES = ['any', 'drafts', 'liked'] as const;
export type CollectionFilter = (typeof COLLECTION_VALUES)[number];

/**
 * The Collection values a chip menu offers. My drafts and Liked need a signed-in
 * user, except a spray wall's drafts, which its builder may see signed out. Same
 * rule as the filter sheet's Collection segment.
 */
export function visibleCollectionValues(options: {
  canFilterPersonalCollections: boolean;
  isSprayWall: boolean;
}): CollectionFilter[] {
  const { canFilterPersonalCollections, isSprayWall } = options;
  return COLLECTION_VALUES.filter((value) => {
    if (value === 'drafts' && isSprayWall) return true;
    if (isPersonalCollection(value)) return canFilterPersonalCollections;
    return true;
  });
}

/**
 * Whether the benchmarks switch (Verified on Kilter) is offered. A spray wall has
 * no benchmarks (#5960), so it shows there only while on, which keeps a filter
 * picked on another board undoable.
 */
export function offersBenchmarksFilter(isSprayWall: boolean, active: boolean): boolean {
  return !isSprayWall || active;
}

/** The options that need an account; hidden from the picker when signed out. */
export function isPersonalCollection(value: CollectionFilter): boolean {
  return value === 'drafts' || value === 'liked';
}

/** Narrows a raw native-picker tag to a {@link CollectionFilter}. */
export function isCollectionFilter(value: string): value is CollectionFilter {
  return (COLLECTION_VALUES as readonly string[]).includes(value);
}

/** Reads the current Collection choice out of its two underlying flags. */
export function getCollectionFilter(filters: Pick<ClimbFilterState, 'status' | 'onlyFavorited'>): CollectionFilter {
  if (filters.status === 'drafts') return 'drafts';
  if (filters.onlyFavorited) return 'liked';
  return 'any';
}

/**
 * The patch that selects one Collection option. Picking one clears the other,
 * so exactly one pool applies. Only a lingering 'drafts' status is reset;
 * 'projects' (Unrepeated) belongs to Popularity and can coexist. Shared by the
 * chip row and the filter sheet so they can't drift.
 */
export function collectionPatch(
  value: CollectionFilter,
  filters: ClimbFilterState,
): { filters: Partial<ClimbFilterState> } {
  let statusPatch: Partial<ClimbFilterState> = {};
  if (value === 'drafts') statusPatch = applyStatusChange(filters, 'drafts');
  else if (filters.status === 'drafts') statusPatch = applyStatusChange(filters, 'any');
  return { filters: { ...statusPatch, onlyFavorited: value === 'liked' || undefined } };
}

// "Climb type" is a single-select over the boulders/routes flags. The type, its
// values, the reader and the patch live in @boardsesh/climb-filters so the chip
// row, the filter sheet and every list read and write it the same way.
export { CLIMB_TYPE_VALUES, climbTypePatch, getClimbTypeFilter, type ClimbTypeFilter } from '@boardsesh/climb-filters';
