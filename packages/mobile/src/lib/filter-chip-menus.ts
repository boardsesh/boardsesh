// Pure helpers behind the persistent filter-chip row (FilterChipRow.tsx). Native
// @expo/ui Pickers take string|number tags; these map our typed filter values to
// stable tags and back, and reproduce the filter sheet's conflict-clear rules so
// a chip menu and the sheet never diverge.
//
// The JSX (Menu/Picker/Toggle) lives in FilterChipRow.tsx; only data + rules live
// here so they can be unit-tested without a native host.

import { SORT_OPTIONS, type SortOption, type ClimbFilterState } from '@boardsesh/climb-filters';

/** Sort fields offered on the Sort chip — the full set, in sheet order. */
export const SORT_CHIP_OPTIONS: readonly SortOption[] = SORT_OPTIONS;

/**
 * Popularity (min-ascents) buckets, matching ClimbFilterSheet's POPULARITY_BUCKETS.
 * `undefined` is the "Any" bucket.
 */
export const POPULARITY_BUCKETS: readonly (number | undefined)[] = [undefined, 2, 10, 100, 1000];

/** Stable Picker tag for a popularity bucket ("any" | "2" | "10" | …). */
export function popularityTag(bucket: number | undefined): string {
  return bucket == null ? 'any' : String(bucket);
}

/** Inverse of {@link popularityTag}: a Picker tag back to a min-ascents value. */
export function popularityFromTag(tag: string): number | undefined {
  return tag === 'any' ? undefined : Number(tag);
}

/**
 * Mirror of ClimbFilterSheet's `handlePopularity` conflict-clear. `minAscents` is
 * mutually exclusive with the `projects`/`drafts` statuses at the DB layer
 * (createClimbFilters drops stats conditions for those), so setting a bucket
 * while one of those statuses is active also resets `status` to `'any'` — else
 * the bucket renders active-but-inert.
 */
export function applyPopularityBucket(
  filters: Pick<ClimbFilterState, 'status'>,
  bucket: number | undefined,
): Partial<ClimbFilterState> {
  const conflicts = bucket != null && (filters.status === 'projects' || filters.status === 'drafts');
  return { minAscents: bucket, ...(conflicts ? { status: 'any' as const } : {}) };
}
