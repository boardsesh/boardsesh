// Re-export the canonical filter state from the shared package so mobile
// callers and the existing `ClimbFilters` / `DEFAULT_FILTERS` symbols
// continue to work without churn.
import { type ClimbFilterState, DEFAULT_CLIMB_FILTER_STATE, type SortOption } from '@boardsesh/climb-filters';

export type ClimbFilters = ClimbFilterState;

export const DEFAULT_FILTERS: ClimbFilters = DEFAULT_CLIMB_FILTER_STATE;

export type { SortOption };

/**
 * Sanitizes the whole auth-gated "Your progress" section for a signed-out user.
 * That section — the `drafts` status and the personal progress lens (the four
 * per-user tick flags) — is hidden when signed out, so a value left over from a
 * prior signed-in session would filter the results with no visible control to
 * change it. Coerce `drafts`→`any` (the option is also gated out of the status
 * picker) and clear the tick flags. Pure, so it can run inside a `useState`
 * initializer and an effect with no ordering hazards, and returns the same
 * reference when there's nothing to change.
 */
export function statusForAuth(filters: ClimbFilters, isAuthenticated: boolean): ClimbFilters {
  if (isAuthenticated) return filters;
  const needsStatusReset = filters.status === 'drafts';
  const needsProgressReset =
    filters.hideAttempted || filters.hideCompleted || filters.showOnlyAttempted || filters.showOnlyCompleted;
  if (!needsStatusReset && !needsProgressReset) return filters;
  return {
    ...filters,
    status: needsStatusReset ? 'any' : filters.status,
    hideAttempted: undefined,
    hideCompleted: undefined,
    showOnlyAttempted: undefined,
    showOnlyCompleted: undefined,
  };
}
