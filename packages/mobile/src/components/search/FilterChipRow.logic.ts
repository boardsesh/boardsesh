// Pure label builders for the persistent filter-chip row, shared by both
// implementations (FilterChipRow.ios.tsx SwiftUI menus, FilterChipRow.android.tsx
// Jetpack Compose dropdowns). The chip wording is sourced once here so the two
// platforms can't word the same filter differently, and so the popularity/rating
// bucket → label mapping stays unit-testable without a native host (the
// FilterChipRow vite alias swaps the COMPONENT for a null stub under Vitest, but
// this `.logic` module is not aliased, so its functions run for real).
//
// The native JSX lives in the platform files; only the `t(...)`-bound wording lives
// here. Keep using the shared POPULARITY_BUCKETS / RATING_BUCKETS from
// `filter-chip-menus.ts` at the call sites so the chip and the sheet never diverge.

import type { TFunction } from 'i18next';
import { formatMinAscentsFilterCount } from '@boardsesh/climb-filters';

/**
 * Label for a popularity (min-ascents) bucket: "Any ascents" for the undefined
 * bucket, "Established (2+)" for 2, otherwise "<count>+" (e.g. "10+", "1k+").
 * Matches the filter sheet's wording so chip, token, and sheet never diverge.
 */
export function popularityChipLabel(bucket: number | undefined, t: TFunction<'climbs'>): string {
  if (bucket == null) return t('mobile.filter.anyAscents');
  if (bucket === 2) return t('mobile.filter.established2plus');
  return `${formatMinAscentsFilterCount(bucket)}+`;
}

/**
 * Label for a min-rating star bucket: "Any rating" for the undefined bucket,
 * otherwise the localised "N+ ⭐" wording the rating token already uses.
 */
export function ratingChipLabel(bucket: number | undefined, t: TFunction<'climbs'>): string {
  return bucket == null ? t('mobile.filter.anyRating') : t('mobile.search.rating', { count: bucket });
}
