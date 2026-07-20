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
import {
  formatMinAscentsFilterCount,
  gradeAccuracyBucket,
  GRADE_ACCURACY_VALUES,
  PROGRESS_FILTER_VALUES,
  SORT_OPTIONS,
  type ProgressFilter,
  type SortOption,
  type GradeAccuracyValue,
} from '@boardsesh/climb-filters';
import type { CollectionFilter, ClimbTypeFilter } from '../../lib/collection-filter';

export { progressFilterLabel } from '../../lib/filter-labels';
export { isCollectionFilter } from '../../lib/collection-filter';
export type { ClimbTypeFilter } from '../../lib/collection-filter';

// Sort labels come straight from the shared `buildSortLabel` — the chip row
// builds that record once per render and reuses it, so there's no per-item helper
// here (an earlier `sortChipLabel` rebuilt the whole record on every menu item).

/** Narrows a raw native-picker tag to a {@link SortOption}. */
export function isSortOption(value: string): value is SortOption {
  return (SORT_OPTIONS as readonly string[]).includes(value);
}

/**
 * Label for a grade-accuracy bucket. Accepts the raw value ('0'…'0.05') and the
 * 'off' tag the chip/segmented use for the neutral bucket. The value→bucket
 * boundaries live once in the shared `gradeAccuracyBucket`; this only maps the
 * bucket to its i18n string (literal keys, so the i18n linter stays happy).
 */
export function accuracyChipLabel(value: GradeAccuracyValue | 'off', t: TFunction<'climbs'>): string {
  switch (gradeAccuracyBucket(value === 'off' ? '0' : value)) {
    case 'off':
      return t('mobile.filter.accuracy.off');
    case 'loose':
      return t('mobile.filter.accuracy.loose');
    case 'moderate':
      return t('mobile.filter.accuracy.moderate');
    case 'tight':
      return t('mobile.filter.accuracy.tight');
  }
}

// The chip's picker tags: 'off' for the neutral bucket ('0'), plus every other
// accuracy value. Derived from GRADE_ACCURACY_VALUES so a new bucket can't render
// as a selectable-but-un-committable option.
const ACCURACY_TAGS: readonly string[] = ['off', ...GRADE_ACCURACY_VALUES.filter((value) => value !== '0')];

/** Narrows a raw native-picker tag to the accuracy value the chip commits. */
export function isAccuracyTag(value: string): value is GradeAccuracyValue | 'off' {
  return ACCURACY_TAGS.includes(value);
}

/** Label for the climb-type single-select ("Boulders" / "Routes" / "Both"). */
export function climbTypeChipLabel(value: ClimbTypeFilter, t: TFunction<'climbs'>): string {
  switch (value) {
    case 'boulders':
      return t('mobile.filter.boulders');
    case 'routes':
      return t('mobile.filter.routes');
    case 'both':
      return t('mobile.filter.both');
  }
}

/** Narrows a raw native-picker tag to a {@link ClimbTypeFilter}. */
export function isClimbType(value: string): value is ClimbTypeFilter {
  return value === 'boulders' || value === 'routes' || value === 'both';
}

/**
 * Label for the "Collection" single-select: the chip shows "Benchmarks" / "My
 * drafts" when active, and "Any" for the neutral value (the resting chip uses the
 * group name "Collection" instead — see the call site).
 */
export function collectionChipLabel(value: CollectionFilter, t: TFunction<'climbs'>): string {
  switch (value) {
    case 'benchmarks':
      return t('mobile.filter.benchmark');
    case 'drafts':
      return t('mobile.filter.drafts');
    case 'any':
      return t('mobile.filter.collection.any');
  }
}

/**
 * Narrows a raw native-picker tag to a {@link ProgressFilter}. The iOS Picker
 * hands back its selection as an untyped tag string, so the menu guards it here
 * before calling `onChangeProgress` — a stray value is ignored rather than cast.
 */
export function isProgressFilter(value: string): value is ProgressFilter {
  return (PROGRESS_FILTER_VALUES as readonly string[]).includes(value);
}

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
