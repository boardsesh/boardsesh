import { DEFAULT_CLIMB_FILTER_STATE, type ClimbFilterState } from './filter-state';
import { isProgressFilterActive } from './progress-filter';
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
  // The four tick flags are one conceptual axis (the "Your progress" selector),
  // so they contribute at most one — "Not tried" sets two flags but is one choice.
  if (isProgressFilterActive(filters)) count += 1;
  // Personal rating: the star minimum and the "only climbs I've rated" switch
  // are independent levers, each clearable on its own from the receipt row.
  if (filters.minUserRating != null) count += 1;
  if (filters.onlyRatedByMe) count += 1;
  // Climb-type defaults to boulders-only; "active" = routes on or boulders off.
  if ((filters.boulders ?? true) !== true || (filters.routes ?? false) !== false) count += 1;
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
    if (boardFilters.quantumOverlap != null && boardFilters.quantumOverlap !== 'off') count += 1;
  }
  return count;
}

/** True when a grade bound is set (either endpoint), matching hasActiveClimbFilters. */
export function isGradeFilterActive(filters: ClimbFilterState): boolean {
  return filters.minGrade != null || filters.maxGrade != null;
}

/**
 * Total active-filter count INCLUDING grade — for a badge that should reflect
 * every active refinement, grade included (e.g. the climbs filter FAB). Grade
 * counts as one when either bound is set. Shared so web and mobile can't
 * disagree on what the badge counts. Use {@link countActiveFiltersBeyondGrade}
 * instead when grade has its own visible control and should be excluded.
 */
export function countActiveFilters(filters: ClimbFilterState, boardFilters?: ClimbBoardFilterState): number {
  return countActiveFiltersBeyondGrade(filters, boardFilters) + (isGradeFilterActive(filters) ? 1 : 0);
}
