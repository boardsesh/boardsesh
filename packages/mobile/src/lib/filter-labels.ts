// Shared i18n label builders for the climbs filter summary string and the
// removable filter tokens. Kept in one place so the summary (recent pills) and
// the active-filter token chips never word a filter differently.

import type { TFunction } from 'i18next';
import {
  gradeAccuracyBucket,
  type FilterSummaryLabels,
  type ProgressFilter,
  type SortOption,
} from '@boardsesh/climb-filters';

// The four per-user tick flags collapse into one "Your progress" value, so the
// summary/token labels expose a single `progress` label instead of one label per
// flag. This builder always populates every field except those four, so the
// return type omits them from the otherwise-`Required` shape — the token builder
// can then index the labels without `&& labels.x` guards that would silently
// drop a token if a field were ever forgotten (a real bug) rather than absent by
// design.
type ClimbFilterLabels = Omit<
  Required<FilterSummaryLabels>,
  'hideAttempted' | 'hideCompleted' | 'showOnlyAttempted' | 'showOnlyCompleted'
>;

/**
 * Label for a "Your progress" value. Literal `t` keys (the i18n linter forbids
 * `t(variable)`), sourced once here so the sheet chips, the persistent chip row,
 * and the filter summary / tokens never word the selector differently.
 */
export function progressFilterLabel(value: ProgressFilter, t: TFunction<'climbs'>): string {
  switch (value) {
    case 'all':
      return t('mobile.filter.progress.all');
    case 'untried':
      return t('mobile.filter.progress.untried');
    case 'projects':
      return t('mobile.filter.progress.projects');
    case 'sent':
      return t('mobile.filter.progress.sent');
    case 'unsent':
      return t('mobile.filter.progress.unsent');
  }
}

export function buildFilterLabels(t: TFunction<'climbs'>): ClimbFilterLabels {
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
    // The community `projects` status now reads as "Unrepeated" (matching the
    // Popularity bucket that writes it), so it never collides with the personal
    // "Projects" progress value. Drafts/established keep their own status labels.
    // i18n-keep mobile.filter.status.drafts mobile.filter.status.established
    status: (kind) =>
      kind === 'projects' ? t('mobile.filter.popularityUnrepeated') : t(`mobile.filter.status.${kind}`),
    // A single part for the collapsed progress selector (getBaseFilterParts reads
    // the current value via flagsToProgress); 'all' is never passed here.
    progress: (value) => progressFilterLabel(value, t),
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
    random: t('mobile.filter.sort.random'),
  };
  return (sortBy: string) => sortLabels[sortBy as SortOption];
}
