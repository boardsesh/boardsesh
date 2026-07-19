import type { ClimbFilterState, ClimbBoardFilterState } from '@boardsesh/climb-filters';

// "Collection" is a single-select over two mutually-exclusive pools of climbs
// that used to be independent toggles: setter-flagged Benchmarks (a board filter,
// `onlyBenchmarks`) and your unpublished My drafts (`status='drafts'`). A draft
// can't be a benchmark, so exactly one applies at a time — hence one control.
// "My drafts" is auth-only, so the 'drafts' option is offered only when signed in.
export const COLLECTION_VALUES = ['any', 'benchmarks', 'drafts'] as const;
export type CollectionFilter = (typeof COLLECTION_VALUES)[number];

/** Narrows a raw native-picker tag to a {@link CollectionFilter}. */
export function isCollectionFilter(value: string): value is CollectionFilter {
  return (COLLECTION_VALUES as readonly string[]).includes(value);
}

/** Reads the current Collection choice out of the two underlying flags. */
export function getCollectionFilter(
  filters: Pick<ClimbFilterState, 'status'>,
  boardFilters: Pick<ClimbBoardFilterState, 'onlyBenchmarks'>,
): CollectionFilter {
  if (boardFilters.onlyBenchmarks) return 'benchmarks';
  if (filters.status === 'drafts') return 'drafts';
  return 'any';
}

// "Climb type" is a single-select over the boulders/routes flags. Boulders-only
// is the default; routes-only and both-on are the other two picks (both-off is
// treated as "both" — no frames_count constraint). One derivation, shared by the
// chip row and the sheet so they can't show a different selected value.
export type ClimbTypeFilter = 'boulders' | 'routes' | 'both';

/** Reads the current Climb type choice out of the boulders/routes flags. */
export function getClimbTypeFilter(filters: Pick<ClimbFilterState, 'boulders' | 'routes'>): ClimbTypeFilter {
  const bouldersOn = filters.boulders ?? true;
  const routesOn = filters.routes ?? false;
  if (bouldersOn && !routesOn) return 'boulders';
  if (!bouldersOn && routesOn) return 'routes';
  return 'both';
}
