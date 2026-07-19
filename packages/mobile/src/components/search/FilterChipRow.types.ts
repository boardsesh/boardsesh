// Shared props for the persistent filter-chip row. The implementation is
// platform-split: FilterChipRow.ios.tsx renders native @expo/ui SwiftUI menus,
// FilterChipRow.android.tsx renders native @expo/ui Jetpack Compose FilterChips +
// DropdownMenus. The split keeps each platform's @expo/ui import (swift-ui /
// jetpack-compose) — whose components resolve native views at module load — off the
// other platform's bundle path.

import type { ProgressFilter, SortOption, GradeAccuracyValue } from '@boardsesh/climb-filters';
import type { RecentFilter } from '../../lib/recent-filter-store';
import type { PinnableChipKind } from '../../lib/pinnable-chips';
import type { CollectionFilter } from '../../lib/collection-filter';
import type { ClimbTypeFilter } from './FilterChipRow.logic';
import type { ClimbFilters } from '../ClimbFilterSheet';

/**
 * Board-shape toggle chips, present only on the sizes where they apply (a shorter
 * or narrower size exists in the same product family; the caller derives this via
 * @boardsesh/board-constants). Grouped under the single "Shape" menu chip, where
 * Tall and Wide are independent toggles — tap either to flip its filter.
 */
export type DimensionChip = {
  key: 'tall' | 'wide';
  active: boolean;
  onToggle: () => void;
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
  /** Current "Collection" single-select (Any / Benchmarks / My drafts). */
  collection: CollectionFilter;
  onChangeCollection: (value: CollectionFilter) => void;
  /** My drafts is auth-only; the option is dropped from the chip menu when signed out. */
  canFilterDrafts: boolean;

  // --- Tier-2 (opt-in) chips: sheet-only controls a user can pin. ---

  /** Current sort key; the Sort chip menu switches it (direction stays sheet-only). */
  sortBy: SortOption;
  /** Whether sort differs from the default (key or direction) — lights the chip. */
  sortActive: boolean;
  onChangeSort: (value: SortOption) => void;

  /** Grade-accuracy bucket; 'off' is the neutral value. The chip menu switches it. */
  accuracyValue: GradeAccuracyValue | 'off';
  onChangeAccuracy: (value: GradeAccuracyValue | 'off') => void;

  /** Climb-type single-select derived from the boulders/routes flags. */
  climbType: ClimbTypeFilter;
  onChangeClimbType: (value: ClimbTypeFilter) => void;

  /** Beta-videos filter — a plain on/off toggle chip. */
  betaActive: boolean;
  onToggleBeta: () => void;
};
