import { DEFAULT_CLIMB_FILTER_STATE, type ClimbFilterState } from './filter-state';
import type { ClimbBoardFilterState } from './board-filter-state';

/**
 * Count of active filters *beyond grade* — grade has its own control, so a gear
 * badge built on this reads as "extra refinements are on". Sort counts as one
 * when it differs from the default; each active board filter (benchmark, holds,
 * zone, setter) counts as one. Shared so web and mobile can't disagree.
 */
export function countActiveFiltersBeyondGrade(filters: ClimbFilterState, boardFilters?: ClimbBoardFilterState): number {
  let count = 0;
  if (filters.setter && filters.setter.length > 0) count += 1;
  if (filters.minAscents != null) count += 1;
  if (filters.minRating != null) count += 1;
  if (filters.gradeAccuracy != null) count += 1;
  if (filters.status !== DEFAULT_CLIMB_FILTER_STATE.status) count += 1;
  if (filters.onlyTallClimbs) count += 1;
  if (filters.onlyWideClimbs) count += 1;
  if (filters.onlyWithBetaVideos) count += 1;
  if (filters.hideAttempted) count += 1;
  if (filters.hideCompleted) count += 1;
  if (filters.showOnlyAttempted) count += 1;
  if (filters.showOnlyCompleted) count += 1;
  if (filters.boulders != null || filters.routes != null) count += 1;
  if (
    filters.sortBy !== DEFAULT_CLIMB_FILTER_STATE.sortBy ||
    filters.sortOrder !== DEFAULT_CLIMB_FILTER_STATE.sortOrder
  ) {
    count += 1;
  }
  if (boardFilters) {
    if (boardFilters.onlyBenchmarks) count += 1;
    if (boardFilters.holdsFilter && Object.keys(boardFilters.holdsFilter).length > 0) count += 1;
    if (boardFilters.zoneBox != null) count += 1;
    if (boardFilters.setterId != null) count += 1;
  }
  return count;
}
