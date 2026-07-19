// Shared props for the persistent filter-chip row. The implementation is
// platform-split: FilterChipRow.ios.tsx renders native @expo/ui SwiftUI menus,
// FilterChipRow.android.tsx renders native @expo/ui Jetpack Compose FilterChips +
// DropdownMenus. The split keeps each platform's @expo/ui import (swift-ui /
// jetpack-compose) — whose components resolve native views at module load — off the
// other platform's bundle path.

import type { ProgressFilter } from '@boardsesh/climb-filters';
import type { RecentFilter } from '../../lib/recent-filter-store';
import type { PinnableChipKind } from '../../lib/pinnable-chips';
import type { ClimbFilters } from '../ClimbFilterSheet';

/**
 * Board-shape toggle chips, present only on the Kilter homewall sizes where they
 * apply: Wide on 10x10, Tall on 8x12, both on 10x12 (the caller derives this from
 * the size via @boardsesh/board-constants). Tap toggles the filter; long-press
 * toggles a persisted lock that pins the filter active through clears (shown with
 * a lock glyph). A locked chip ignores tap (only a long-press unlock frees it).
 */
export type DimensionChip = {
  key: 'tall' | 'wide';
  active: boolean;
  locked: boolean;
  onToggle: () => void;
  onToggleLock: () => void;
};

export type FilterChipRowProps = {
  /**
   * The filter chips the user has pinned, in render order (see
   * lib/pinnable-chips.ts). Each pinnable chip renders only when its kind is
   * present; the fixed chrome (Filters button, Recent, Android Angle) always
   * renders. Defaults reproduce today's row.
   */
  pinnedChips: readonly PinnableChipKind[];

  /** Total active filters → the Filters · N badge; tapping opens the sheet. */
  activeFilterCount: number;
  onOpenFilters: () => void;

  recentFilters: RecentFilter[];
  /** Current committed filters + name, to mark the active recent. */
  currentFilters: ClimbFilters;
  currentSearchText: string;
  onApplyRecent: (filters: ClimbFilters, searchText: string) => void;
  onClearRecent: () => void;

  /** Localised grade-bound label ("V4–V6") or the resting "Grade" placeholder. */
  gradeLabel: string;
  gradeActive: boolean;
  onOpenGrade: () => void;
  /** Whether the grade range rail is currently shown — the chip toggles it. */
  gradeRailOpen: boolean;
  onCloseGrade: () => void;

  /** Tall/Wide chips for the current Kilter homewall size (empty otherwise). */
  dimensionChips: DimensionChip[];

  minAscents: number | undefined;
  onChangePopularity: (bucket: number | undefined) => void;

  minRating: number | undefined;
  onChangeRating: (minRating: number | undefined) => void;

  /** The current "Your progress" selection, read from the four tick flags. */
  progress: ProgressFilter;
  onChangeProgress: (value: ProgressFilter) => void;
  /** The progress selector is auth-gated (its chip hides), matching the sheet. */
  canFilterProgress: boolean;
  onlyBenchmarks: boolean;
  onToggleBenchmarks: (next: boolean) => void;
};
