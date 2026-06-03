import type { ClimbSearchInput, HoldsFilter, ZoneBoxInput, ZoneMatchMode } from '@boardsesh/shared-schema';

/**
 * Board-renderer-dependent search filters, kept as a sibling to
 * {@link import('./filter-state').ClimbFilterState} (which deliberately
 * excludes them). These need the interactive board surface to edit:
 *   - `onlyBenchmarks` — curator-flagged benchmark climbs (P1; the only one
 *     wired today). `holdsFilter` / `zoneBox` / `zoneMode` / `setterId` are
 *     reserved for the holds (P3) and zone (P4) phases so the type and the
 *     merge are in place before the UI lands.
 *
 * Fold into a {@link ClimbSearchInput} (built by `toClimbSearchInput`) via
 * {@link mergeBoardFilters}.
 */
export type ClimbBoardFilterState = {
  onlyBenchmarks?: boolean;
  holdsFilter?: HoldsFilter;
  zoneBox?: ZoneBoxInput | null;
  zoneMode?: ZoneMatchMode;
  setterId?: number;
};

export const DEFAULT_CLIMB_BOARD_FILTER_STATE: ClimbBoardFilterState = {};

/** True when any board-dependent filter is active. */
export function hasActiveBoardFilters(state: ClimbBoardFilterState): boolean {
  if (state.onlyBenchmarks) return true;
  if (state.holdsFilter && Object.keys(state.holdsFilter).length > 0) return true;
  if (state.zoneBox != null) return true;
  if (state.setterId != null) return true;
  return false;
}

/**
 * Returns a new {@link ClimbSearchInput} with the active board filters folded
 * in. Inactive fields are left untouched so the base input's values win.
 */
export function mergeBoardFilters(input: ClimbSearchInput, state: ClimbBoardFilterState): ClimbSearchInput {
  const merged: ClimbSearchInput = { ...input };
  if (state.onlyBenchmarks) merged.onlyBenchmarks = true;
  if (state.holdsFilter && Object.keys(state.holdsFilter).length > 0) merged.holdsFilter = state.holdsFilter;
  if (state.zoneBox != null) {
    merged.zoneBox = state.zoneBox;
    if (state.zoneMode) merged.zoneMode = state.zoneMode;
  }
  if (state.setterId != null) merged.setterId = state.setterId;
  return merged;
}
