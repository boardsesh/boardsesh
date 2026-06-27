// Pure helpers behind the persistent filter-chip row (FilterChipRow.tsx). Native
// @expo/ui Pickers take string|number tags; these map our typed filter values to
// stable tags and back, and reproduce the filter sheet's conflict-clear rules so
// a chip menu and the sheet never diverge.
//
// The JSX (Menu/Picker/Toggle) lives in FilterChipRow.tsx; only data + rules live
// here so they can be unit-tested without a native host.

import type { ClimbFilterState } from '@boardsesh/climb-filters';

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
 * Min-rating star buckets for the rating chip. `undefined` is the "Any" bucket.
 * 2–5 mirror the directive's chip scope; the sheet's StarRating still allows 1★,
 * which renders the chip active but shows no menu checkmark until re-selected.
 */
export const RATING_BUCKETS: readonly (number | undefined)[] = [undefined, 2, 3, 4, 5];

/** Stable Picker tag for a rating bucket ("any" | "2" | … | "5"). */
export function ratingTag(value: number | undefined): string {
  return value == null ? 'any' : String(value);
}

/** Inverse of {@link ratingTag}: a Picker tag back to a min-rating value. */
export function ratingFromTag(tag: string): number | undefined {
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
