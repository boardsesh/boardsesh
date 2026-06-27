// Shared props for the persistent filter-chip row. The implementation is
// platform-split: FilterChipRow.ios.tsx renders native @expo/ui SwiftUI menus,
// FilterChipRow.android.tsx is a placeholder (the Material chip row lands with
// the jetpack-compose follow-up). The split keeps @expo/ui/swift-ui — whose
// components resolve native views at module load — off the Android bundle path.

import type { RecentFilter } from '../../lib/recent-filter-store';
import type { ClimbFilters } from '../ClimbFilterSheet';

/**
 * Board-shape toggle chips, present only on the Kilter homewall sizes where they
 * apply: Wide on 10x10, Tall on 8x12, both on 10x12 (the caller derives this from
 * the size via @boardsesh/board-constants). Each toggles a boolean filter on tap.
 */
export type DimensionChip = { key: 'tall' | 'wide'; active: boolean; onToggle: () => void };

export type FilterChipRowProps = {
  /** Total active filters → the Filters · N badge; tapping opens the sheet. */
  activeFilterCount: number;
  onOpenFilters: () => void;

  recentFilters: RecentFilter[];
  /** Current committed filters + name, to mark the active recent. */
  currentFilters: ClimbFilters;
  currentSearchText: string;
  onApplyRecent: (filters: ClimbFilters, searchText: string) => void;
  onClearRecent: () => void;

  /** Localised grade-bound label ("V4–V6") or the "Grade range" placeholder. */
  gradeLabel: string;
  gradeActive: boolean;
  onOpenGrade: () => void;

  /** Tall/Wide chips for the current Kilter homewall size (empty otherwise). */
  dimensionChips: DimensionChip[];

  minAscents: number | undefined;
  onChangePopularity: (bucket: number | undefined) => void;

  minRating: number | undefined;
  onChangeRating: (minRating: number | undefined) => void;

  hideCompleted: boolean;
  onToggleHideCompleted: (next: boolean) => void;
  onlyBenchmarks: boolean;
  onToggleBenchmarks: (next: boolean) => void;
  /** Hide-sent is auth-gated, matching the filter sheet. */
  canHideCompleted: boolean;
};
