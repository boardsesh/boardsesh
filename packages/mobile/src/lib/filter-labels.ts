// Shared i18n label builders for the climbs filter summary string and the
// removable filter tokens. Kept in one place so the summary (recent pills) and
// the active-filter token chips never word a filter differently.

import type { TFunction } from 'i18next';
import { gradeAccuracyBucket, type FilterSummaryLabels, type SortOption } from '@boardsesh/climb-filters';

// `FilterSummaryLabels` marks several fields optional for shared callers that
// emit a partial summary, but this builder always populates every one — so the
// return type is `Required` here. That lets the token builder index the labels
// without `&& labels.x` guards that would silently drop a token if a field were
// ever forgotten (a real bug) rather than absent by design.
export function buildFilterLabels(t: TFunction<'climbs'>): Required<FilterSummaryLabels> {
  return {
    gradeRange: (min, max) => t('mobile.search.gradeRange', { min, max }),
    gradeMin: (grade) => t('mobile.search.gradeMin', { grade }),
    gradeMax: (grade) => t('mobile.search.gradeMax', { grade }),
    ascents: (count) => t('mobile.search.ascents', { count }),
    rating: (count) => t('mobile.search.rating', { count }),
    more: (count) => t('mobile.search.more', { count }),
    // i18n-keep mobile.search.settersCount
    setters: (count) => t('mobile.search.settersCount', { count }),
    // i18n-keep mobile.filter.accuracy.off mobile.filter.accuracy.loose mobile.filter.accuracy.moderate mobile.filter.accuracy.tight
    gradeAccuracy: (value) => t(`mobile.filter.accuracy.${gradeAccuracyBucket(value)}`),
    // Summary form drops the "only" wording the toggle rows use ("Tall climbs
    // only" → "Tall climbs"), keeping the filter summary / tokens compact.
    tallOnly: () => t('mobile.filter.tallClimbs'),
    wideOnly: () => t('mobile.filter.wideClimbs'),
    betaOnly: () => t('mobile.filter.betaVideosShort'),
    // i18n-keep mobile.filter.status.drafts mobile.filter.status.established mobile.filter.status.projects
    status: (kind) => t(`mobile.filter.status.${kind}`),
    hideAttempted: () => t('mobile.filter.progress.hideAttempted'),
    hideCompleted: () => t('mobile.filter.progress.hideCompleted'),
    showOnlyAttempted: () => t('mobile.filter.progress.onlyAttempted'),
    showOnlyCompleted: () => t('mobile.filter.progress.onlyCompleted'),
  };
}

export function formatSettersLabel(
  setters: readonly string[],
  labels: Pick<Required<FilterSummaryLabels>, 'setters'>,
  t: TFunction<'climbs'>,
): string {
  // i18n-keep mobile.search.setterName
  return setters.length === 1 ? t('mobile.search.setterName', { setter: setters[0] }) : labels.setters(setters.length);
}

export function buildSortLabel(t: TFunction<'climbs'>): (sortBy: string) => string | undefined {
  const sortLabels: Record<SortOption, string> = {
    ascents: t('mobile.filter.sort.ascents'),
    quality: t('mobile.filter.sort.quality'),
    difficulty: t('mobile.filter.sort.difficulty'),
    name: t('mobile.filter.sort.name'),
    popular: t('mobile.filter.sort.popular'),
    creation: t('mobile.filter.sort.creation'),
  };
  return (sortBy: string) => sortLabels[sortBy as SortOption];
}
