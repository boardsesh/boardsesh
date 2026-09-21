// Re-export the canonical filter state from the shared package so mobile
// callers and the existing `ClimbFilters` / `DEFAULT_FILTERS` symbols
// continue to work without churn.
import { getBoardCapabilities } from '@boardsesh/board-config';
import { type ClimbFilterState, DEFAULT_CLIMB_FILTER_STATE, type SortOption } from '@boardsesh/climb-filters';

export type ClimbFilters = ClimbFilterState;

export const DEFAULT_FILTERS: ClimbFilters = DEFAULT_CLIMB_FILTER_STATE;

export type { SortOption };

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
 * Drops the filters this board has no control for. Today that is only
 * `includeOtherAngles`: its switch renders on angle-bound boards (Woods) alone,
 * but recent pills are shared across boards, so a Woods pill replayed on Kilter
 * would carry it over with no switch to turn it off, and opt that search into the
 * cross-angle query, which costs ~5.6 s on Kilter's catalogue (see
 * `angleBoundClimbs` in @boardsesh/board-config). Returns the same reference when
 * there's nothing to drop.
 *
 * Applied where a pill is replayed, and again in every builder that turns filter
 * state into a search input — the list's `searchInput`, the play drawer's
 * `fetchSearchPage` and `buildCountPreviewInput` — so a future path that carries
 * filter state across boards cannot reach the slow query either.
 */
export function filtersForBoard(filters: ClimbFilters, boardName: string): ClimbFilters {
  if (!filters.includeOtherAngles || getBoardCapabilities(boardName).angleBoundClimbs) return filters;
  const { includeOtherAngles: _droppedOtherAngles, ...filtersWithoutOtherAngles } = filters;
  return filtersWithoutOtherAngles;
}
