// Builds the removable active-filter chips shown in the search bar / strip, so
// a multi-filter query is always visible and one-tap-dismissible. Grade is
// excluded (it has its own pill). Status and sort are excluded — they're the
// rare long tail and the gear badge covers them; keeping them out also avoids
// dynamic `t()` keys (the i18n linter only allows literal keys). Each pill
// carries the patch that clears it.

import { formatMinAscentsFilterCount, type ClimbBoardFilterState } from '@boardsesh/climb-filters';
import type { ClimbFilters } from '../../lib/climb-filter-types';

export type ActiveFilterPill = {
  key: string;
  label: string;
  clearFilters?: Partial<ClimbFilters>;
  clearBoard?: Partial<ClimbBoardFilterState>;
};

type TFunc = (key: string, options?: Record<string, unknown>) => string;

export function buildActiveFilterPills(
  filters: ClimbFilters,
  boardFilters: ClimbBoardFilterState,
  t: TFunc,
): ActiveFilterPill[] {
  const pills: ActiveFilterPill[] = [];

  if (filters.hideCompleted) {
    pills.push({ key: 'hideSent', label: t('mobile.filter.hideSent'), clearFilters: { hideCompleted: undefined } });
  }
  if (filters.minAscents != null) {
    pills.push({
      key: 'popularity',
      label:
        filters.minAscents === 2
          ? t('mobile.filter.established2plus')
          : `${formatMinAscentsFilterCount(filters.minAscents)}+`,
      clearFilters: { minAscents: undefined },
    });
  }
  if (filters.minRating != null) {
    pills.push({
      key: 'rating',
      label: t('mobile.search.rating', { count: filters.minRating }),
      clearFilters: { minRating: undefined },
    });
  }
  if (boardFilters.onlyBenchmarks) {
    pills.push({ key: 'benchmark', label: t('mobile.filter.benchmark'), clearBoard: { onlyBenchmarks: undefined } });
  }
  if (filters.setter && filters.setter.length > 0) {
    pills.push({
      key: 'setter',
      label: t('mobile.search.settersCount', { count: filters.setter.length }),
      clearFilters: { setter: undefined },
    });
  }
  if (filters.gradeAccuracy != null) {
    pills.push({
      key: 'accuracy',
      label: t('mobile.filter.accuracy.label'),
      clearFilters: { gradeAccuracy: undefined },
    });
  }
  if (filters.onlyTallClimbs) {
    pills.push({ key: 'tall', label: t('mobile.filter.tall'), clearFilters: { onlyTallClimbs: undefined } });
  }
  if (filters.onlyWideClimbs) {
    pills.push({ key: 'wide', label: t('mobile.filter.wide'), clearFilters: { onlyWideClimbs: undefined } });
  }
  if (filters.onlyWithBetaVideos) {
    pills.push({ key: 'beta', label: t('mobile.filter.betaVideos'), clearFilters: { onlyWithBetaVideos: undefined } });
  }
  if (filters.hideAttempted) {
    pills.push({
      key: 'hideAttempted',
      label: t('mobile.filter.progress.hideAttempted'),
      clearFilters: { hideAttempted: undefined },
    });
  }
  if (filters.showOnlyAttempted) {
    pills.push({
      key: 'onlyAttempted',
      label: t('mobile.filter.progress.onlyAttempted'),
      clearFilters: { showOnlyAttempted: undefined },
    });
  }
  if (filters.showOnlyCompleted) {
    pills.push({
      key: 'onlyCompleted',
      label: t('mobile.filter.progress.onlyCompleted'),
      clearFilters: { showOnlyCompleted: undefined },
    });
  }
  // status / sort intentionally omitted (rare; gear badge covers them).
  return pills;
}
