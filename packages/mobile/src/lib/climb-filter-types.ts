// Re-export the canonical filter state from the shared package so mobile
// callers and the existing `ClimbFilters` / `DEFAULT_FILTERS` symbols
// continue to work without churn.
import { type ClimbFilterState, DEFAULT_CLIMB_FILTER_STATE, type SortOption } from '@boardsesh/climb-filters';

export type ClimbFilters = ClimbFilterState;

export const DEFAULT_FILTERS: ClimbFilters = DEFAULT_CLIMB_FILTER_STATE;

export type { SortOption };

/**
 * A signed-out user can't filter to drafts — the option is gated out of the native
 * status picker. Coerce a persisted `drafts` status (left over from a prior signed-in
 * session) to `any` so the picker never receives a selection with no matching option.
 * Pure, so it can run inside a `useState` initializer and an effect with no ordering
 * hazards, and returns the same reference when there's nothing to change.
 */
export function statusForAuth(filters: ClimbFilters, isAuthenticated: boolean): ClimbFilters {
  return !isAuthenticated && filters.status === 'drafts' ? { ...filters, status: 'any' } : filters;
}
