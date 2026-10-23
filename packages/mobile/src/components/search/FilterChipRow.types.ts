// Props for the climbs list's persistent filter row (FilterChipRow.tsx). The row
// builds capsule descriptors from them (climb-capsules.ts) and hands them to the
// shared, platform-split CapsuleRow (filter-capsules/), so these props carry no
// native types.

import type { ReactElement } from 'react';
import type { ProgressFilter, SortOption, GradeAccuracyValue } from '@boardsesh/climb-filters';
import type { RecentFilter } from '../../lib/recent-filter-store';
import type { FilterChipKind } from '../../lib/pinnable-chips';
import type { CollectionFilter } from '../../lib/collection-filter';
import type { ClimbTypeFilter } from './FilterChipRow.logic';
import type { ClimbFilters } from '../ClimbFilterSheet';
import type { DimensionChip } from '../../lib/dimension-chips';
import type { CapsuleOption } from '../filter-capsules/CapsuleRow.types';

// Board-shape toggle chips (Tall / Wide), present only on the sizes where they
// apply (a shorter or narrower size exists in the same product family; the caller
// derives this via @boardsesh/board-constants), each pinnable on its own. The
// shape and its tap / lock rules live in lib/dimension-chips.ts. Every platform
// taps to toggle; only the iOS row offers the long-press Lock / Unlock.
export type { DimensionChip } from '../../lib/dimension-chips';

/**
 * A Sort capsule with the list's own keys and labels, in place of the Climbs
 * `SORT_OPTIONS` one (a playlist's "Playlist order", "Recently added"). The
 * caller owns what each key means; the row only shows the menu.
 */
export type FilterChipSortControl = {
  /** The capsule's text: the resting name, or the picked sort ("Easiest first"). */
  label: string;
  active: boolean;
  options: readonly CapsuleOption[];
  selected: string;
  onSelect: (value: string) => void;
};

export type FilterChipRowProps = {
  /**
   * The chips the user has pinned, in render order (see lib/pinnable-chips.ts).
   * Each pinnable chip, Recent included, renders only when its kind is present;
   * the Filters button always renders. Defaults reproduce today's row.
   */
  pinnedChips: readonly FilterChipKind[];

  /** Total active filters → the Filters · N badge; tapping opens the sheet. */
  activeFilterCount: number;
  onOpenFilters: () => void;

  /** Saved searches for the Recent menu. A list without saved searches (a playlist) leaves these out. */
  recentFilters?: RecentFilter[];
  /** Current committed filters + name, to mark the active recent. */
  currentFilters?: ClimbFilters;
  currentSearchText?: string;
  onApplyRecent?: (filters: ClimbFilters, searchText: string) => void;
  onClearRecent?: () => void;

  /** Localised grade-bound label ("V4–V6") or the resting "Grade" placeholder. */
  gradeLabel: string;
  gradeActive: boolean;
  onOpenGrade: () => void;
  /** Whether the grade range rail is currently shown — the chip toggles it. The
   *  rail is hidden until the chip opens it, then stays until the chip hides it. */
  gradeRailOpen: boolean;
  onCloseGrade: () => void;
  /** Regular-width iPad places the range picker at its native chip anchor. */
  gradePopoverContent?: ReactElement;

  /**
   * Tall/Wide chips the current board size supports (empty otherwise). Each one
   * still renders only when its own kind ('tall' / 'wide') is pinned.
   */
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
  /** Current "Collection" single-select (Any / Benchmarks / My drafts / Liked). */
  collection: CollectionFilter;
  onChangeCollection: (value: CollectionFilter) => void;
  /** My drafts and Liked are auth-only; their options are dropped from the chip menu when signed out. */
  canFilterPersonalCollections: boolean;
  /** A spray wall has no benchmarks, so the menu hides Benchmarks unless it is already active. */
  isSprayWall: boolean;

  // --- Tier-2 (opt-in) chips: sheet-only controls a user can pin. ---

  /** Current sort key; the Sort chip menu switches it (direction stays sheet-only). Unused with `sortControl`. */
  sortBy?: SortOption;
  /** Whether sort differs from the default (key or direction) — lights the chip. */
  sortActive?: boolean;
  onChangeSort?: (value: SortOption) => void;
  /** A list with sorts of its own passes its Sort capsule here; it replaces the Climbs one. */
  sortControl?: FilterChipSortControl;

  /** Grade-accuracy bucket; 'off' is the neutral value. The chip menu switches it. */
  accuracyValue: GradeAccuracyValue | 'off';
  onChangeAccuracy: (value: GradeAccuracyValue | 'off') => void;

  /** Climb-type single-select derived from the boulders/routes flags. */
  climbType: ClimbTypeFilter;
  onChangeClimbType: (value: ClimbTypeFilter) => void;
  /**
   * The list's own climb type at rest, which leaves the chip unlit and labelled
   * "Climb type". Boulders on the Climbs list (the default); both on a playlist.
   */
  defaultClimbType?: ClimbTypeFilter;

  /** Beta-videos filter — a plain on/off toggle chip. */
  betaActive: boolean;
  onToggleBeta: () => void;

  /** "Fits my board": a toggle chip before Sort, shown while pinned. Playlist-only; absent without an active board. */
  boardFit?: { active: boolean; onToggle: () => void };

  /**
   * Material only: lead with the Angle capsule (default true). A playlist passes
   * false, matching Liquid Glass, where no list but Climbs carries an angle control.
   */
  showAngle?: boolean;
};
