// Re-export the canonical filter state from the shared package so mobile
// callers and the existing `ClimbFilters` / `DEFAULT_FILTERS` symbols
// continue to work without churn.
import { getBoardCapabilities } from '@boardsesh/board-config';
import {
  type ClimbFilterState,
  DEFAULT_CLIMB_FILTER_STATE,
  SORT_OPTIONS,
  type SortOption,
} from '@boardsesh/climb-filters';

export type ClimbFilters = ClimbFilterState;

export const DEFAULT_FILTERS: ClimbFilters = DEFAULT_CLIMB_FILTER_STATE;

export type { SortOption };

const SORT_OPTIONS_WITHOUT_USER_GRADE: readonly SortOption[] = SORT_OPTIONS.filter(
  (sortOption) => sortOption !== 'userGrade',
);

/** Sort keys whose upstream values represent user grades for this board. */
export function getSortOptionsForBoard(boardName: string): readonly SortOption[] {
  return getBoardCapabilities(boardName).userGradeSort ? SORT_OPTIONS : SORT_OPTIONS_WITHOUT_USER_GRADE;
}

/** Whether a raw picker tag remains a supported sort choice for this board. */
export function isSortOptionForBoard(value: string, boardName: string): value is SortOption {
  return getSortOptionsForBoard(boardName).includes(value as SortOption);
}

/**
 * Sanitizes the whole auth-gated "Your progress" section for a signed-out user.
 * That section — the `drafts` status, the personal progress lens (the four
 * per-user tick flags) and the personal rating filters — is hidden when signed
 * out, so a value left over from a prior signed-in session would filter the
 * results with no visible control to change it. Coerce `drafts`→`any` (the
 * option is also gated out of the status picker) and clear the tick flags and
 * personal ratings. Pure, so it can run inside a `useState` initializer and an
 * effect with no ordering hazards, and returns the same reference when there's
 * nothing to change.
 */
export function statusForAuth(filters: ClimbFilters, isAuthenticated: boolean): ClimbFilters {
  if (isAuthenticated) return filters;
  const needsStatusReset = filters.status === 'drafts';
  const needsProgressReset =
    filters.hideAttempted ||
    filters.hideCompleted ||
    filters.showOnlyAttempted ||
    filters.showOnlyCompleted ||
    filters.minUserRating != null ||
    filters.onlyRatedByMe ||
    filters.onlyFollowedAuthors;
  if (!needsStatusReset && !needsProgressReset) return filters;
  return {
    ...filters,
    status: needsStatusReset ? 'any' : filters.status,
    hideAttempted: undefined,
    hideCompleted: undefined,
    showOnlyAttempted: undefined,
    showOnlyCompleted: undefined,
    minUserRating: undefined,
    onlyRatedByMe: undefined,
    onlyFollowedAuthors: undefined,
  };
}

/**
 * Drops filters this board has no control or meaningful value for. The
 * `includeOtherAngles` switch renders on angle-bound boards (Woods) alone, but
 * recent pills are shared across boards, so a Woods pill replayed on Kilter
 * would carry it over with no switch to turn it off, and opt that search into the
 * cross-angle query, which costs ~5.6 s on Kilter's catalogue (see
 * `angleBoundClimbs` in @boardsesh/board-config). The user-grade sort is also
 * unavailable where `difficulty_average` is only the setter's catalog grade
 * (Woods and spray), so those persisted selections fall back to `difficulty`.
 * Returns the same reference when there's nothing to normalize.
 *
 * Applied where a pill is replayed, and again in every builder that turns filter
 * state into a search input — the list's `searchInput`, the play drawer's
 * `fetchSearchPage` and `buildCountPreviewInput` — so a future path that carries
 * filter state across boards cannot reach the slow query either.
 */
export function filtersForBoard(filters: ClimbFilters, boardName: string): ClimbFilters {
  const capabilities = getBoardCapabilities(boardName);
  const dropOtherAngles = !!filters.includeOtherAngles && !capabilities.angleBoundClimbs;
  const resetSort = filters.sortBy === 'userGrade' && !capabilities.userGradeSort;
  if (!dropOtherAngles && !resetSort) return filters;

  const normalized = { ...filters };
  if (dropOtherAngles) delete normalized.includeOtherAngles;
  if (resetSort) {
    normalized.sortBy = 'difficulty';
    normalized.sortSeed = undefined;
  }
  return normalized;
}
