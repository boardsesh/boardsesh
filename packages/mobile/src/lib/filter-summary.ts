import type { TFunction } from 'i18next';
import type { Grade } from '@boardsesh/shared-schema';
import { getBaseFilterParts, formatFilterSummary } from '@boardsesh/climb-filters';
import { DEFAULT_FILTERS, type ClimbFilters } from './climb-filter-types';
import { buildFilterLabels, buildSortLabel, formatSettersLabel } from './filter-labels';

export function getFilterSummary(
  filters: ClimbFilters,
  searchText: string,
  grades: Grade[] | undefined,
  t: TFunction<'climbs'>,
): string {
  const baseLabels = buildFilterLabels(t);
  const labels = {
    ...baseLabels,
    setters: (count: number) =>
      filters.setter != null && count === filters.setter.length
        ? formatSettersLabel(filters.setter, baseLabels, t)
        : baseLabels.setters(count),
  };
  const parts = getBaseFilterParts(
    {
      // Only include grade bounds when grades data is available — without it
      // getGradeName falls back to "#N" which is uninformative to the user.
      minGrade: grades != null ? filters.minGrade : undefined,
      maxGrade: grades != null ? filters.maxGrade : undefined,
      minAscents: filters.minAscents,
      minRating: filters.minRating,
      sortBy: filters.sortBy,
      defaultSortBy: DEFAULT_FILTERS.sortBy,
      name: searchText,
      setter: filters.setter,
      gradeAccuracy: filters.gradeAccuracy,
      onlyTallClimbs: filters.onlyTallClimbs,
      onlyWideClimbs: filters.onlyWideClimbs,
      onlyWithBetaVideos: filters.onlyWithBetaVideos,
      status: filters.status,
      hideAttempted: filters.hideAttempted,
      hideCompleted: filters.hideCompleted,
      showOnlyAttempted: filters.showOnlyAttempted,
      showOnlyCompleted: filters.showOnlyCompleted,
    },
    grades ?? [],
    labels,
    buildSortLabel(t),
  );

  return formatFilterSummary(parts, labels) ?? t('mobile.filter.title');
}

/**
 * Variant-aware active-filter summary for the Climbs screen. Material renders it
 * as a quick chip (up to 2 parts, then "+N more"); the glass variant uses it as
 * the screen title, fitting whole parts within a character budget (the title
 * wraps to two lines) before "+N more". Returns null when there are no parts.
 */
export function buildClimbFilterSummary(params: {
  labels: string[];
  isMaterial: boolean;
  maxChars: number;
  more: (count: number) => string;
}): string | null {
  const { labels, isMaterial, maxChars, more } = params;
  if (labels.length === 0) return null;
  return isMaterial ? formatFilterSummary(labels, { more }, 2) : formatFilterSummary(labels, { more }, null, maxChars);
}
