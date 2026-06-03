import type { ClimbSearchInput } from '@boardsesh/shared-schema';

export const SORT_OPTIONS = ['ascents', 'quality', 'difficulty', 'name', 'popular', 'creation'] as const;
export type SortOption = (typeof SORT_OPTIONS)[number];

export const SORT_ORDERS = ['asc', 'desc'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

// Ordered from no-filter through loosest to tightest so UIs that iterate
// this list render the natural progression (Off → Loose → Moderate → Tight).
// The numeric values correspond to the allowed delta from a climb's
// difficulty_average, so smaller = stricter.
export const GRADE_ACCURACY_VALUES = ['0', '0.2', '0.1', '0.05'] as const;
export type GradeAccuracyValue = (typeof GRADE_ACCURACY_VALUES)[number];

export const STATUS_FILTER_VALUES = ['any', 'drafts', 'established', 'projects'] as const;
export type StatusFilter = (typeof STATUS_FILTER_VALUES)[number];

/**
 * In-app climb filter state, shared between web and mobile.
 *
 * This is a subset of {@link ClimbSearchInput} that excludes board-renderer
 * dependent fields (`holdsFilter`, `zoneBox`, `zoneMode`, `setterId`,
 * `onlyBenchmarks`). Convert to a search input via {@link toClimbSearchInput}.
 */
export type ClimbFilterState = {
  sortBy: SortOption;
  sortOrder: SortOrder;
  minGrade?: number;
  maxGrade?: number;
  minAscents?: number;
  minRating?: number;
  gradeAccuracy?: GradeAccuracyValue;
  setter?: string[];
  onlyTallClimbs?: boolean;
  onlyWideClimbs?: boolean;
  onlyWithBetaVideos?: boolean;
  status: StatusFilter;
  hideAttempted?: boolean;
  hideCompleted?: boolean;
  showOnlyAttempted?: boolean;
  showOnlyCompleted?: boolean;
};

export const DEFAULT_CLIMB_FILTER_STATE: ClimbFilterState = {
  sortBy: 'ascents',
  sortOrder: 'desc',
  status: 'any',
};

/**
 * Returns true when any filter field differs from the default state.
 */
export function hasActiveClimbFilters(state: ClimbFilterState): boolean {
  if (state.sortBy !== DEFAULT_CLIMB_FILTER_STATE.sortBy) return true;
  if (state.sortOrder !== DEFAULT_CLIMB_FILTER_STATE.sortOrder) return true;
  if (state.status !== DEFAULT_CLIMB_FILTER_STATE.status) return true;
  if (state.minGrade != null) return true;
  if (state.maxGrade != null) return true;
  if (state.minAscents != null) return true;
  if (state.minRating != null) return true;
  if (state.gradeAccuracy != null) return true;
  if (state.setter != null && state.setter.length > 0) return true;
  if (state.onlyTallClimbs) return true;
  if (state.onlyWideClimbs) return true;
  if (state.onlyWithBetaVideos) return true;
  if (state.hideAttempted) return true;
  if (state.hideCompleted) return true;
  if (state.showOnlyAttempted) return true;
  if (state.showOnlyCompleted) return true;
  return false;
}

export type StatusFlags = { onlyDrafts?: boolean; projectsOnly?: boolean };

export function statusToFlags(status: StatusFilter): StatusFlags {
  if (status === 'drafts') return { onlyDrafts: true };
  if (status === 'projects') return { projectsOnly: true };
  return {};
}

export function flagsToStatus(flags: StatusFlags): StatusFilter {
  if (flags.onlyDrafts) return 'drafts';
  if (flags.projectsOnly) return 'projects';
  return 'any';
}

/**
 * Returns the patch to apply when the user changes the Status filter.
 * Mirrors web's status side-effects: established sets `minAscents >= 2`,
 * drafts switches sort to newest-first, and any/projects resets `minAscents`.
 *
 * Use as: `setState((previous) => ({ ...previous, ...applyStatusChange(previous, newStatus) }))`.
 */
export function applyStatusChange(_previous: ClimbFilterState, newStatus: StatusFilter): Partial<ClimbFilterState> {
  switch (newStatus) {
    case 'drafts':
      return { status: 'drafts', minAscents: undefined, sortBy: 'creation', sortOrder: 'desc' };
    case 'established':
      return { status: 'established', minAscents: 2 };
    case 'projects':
      return { status: 'projects', minAscents: undefined };
    case 'any':
      return { status: 'any', minAscents: undefined };
  }
}

/**
 * "established" is retired as a user-facing status (it's the same lever as
 * `minAscents >= 2`, now folded into the Popularity control), but the enum
 * value still appears in older stored searches / recent pills. Map it to `any`
 * while preserving `minAscents`, so the UI never holds a status that has no
 * control and the active-filter count doesn't double-count the one lever.
 * The enum value is kept for back-compat; this just normalizes on read.
 */
export function normalizeRetiredStatus(state: ClimbFilterState): ClimbFilterState {
  return state.status === 'established' ? { ...state, status: 'any' } : state;
}

export type BoardSearchConfig = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};

export type SearchPagination = { page: number; pageSize: number };

/**
 * Builds a {@link ClimbSearchInput} for the GraphQL search query from the
 * in-app filter state, board config, and pagination.
 */
export function toClimbSearchInput(
  state: ClimbFilterState,
  board: BoardSearchConfig,
  pagination: SearchPagination,
  options?: { name?: string },
): ClimbSearchInput {
  const input: ClimbSearchInput = {
    boardName: board.boardName,
    layoutId: board.layoutId,
    sizeId: board.sizeId,
    setIds: board.setIds,
    angle: board.angle,
    page: pagination.page,
    pageSize: pagination.pageSize,
    sortBy: state.sortBy,
    sortOrder: state.sortOrder,
  };

  if (state.minGrade != null) input.minGrade = state.minGrade;
  if (state.maxGrade != null) input.maxGrade = state.maxGrade;
  if (state.minAscents != null) input.minAscents = state.minAscents;
  if (state.minRating != null) input.minRating = state.minRating;
  if (state.gradeAccuracy != null) input.gradeAccuracy = state.gradeAccuracy;
  if (state.setter != null && state.setter.length > 0) input.setter = state.setter;
  if (state.onlyTallClimbs) input.onlyTallClimbs = true;
  if (state.onlyWideClimbs) input.onlyWideClimbs = true;
  if (state.onlyWithBetaVideos) input.onlyWithBetaVideos = true;
  if (state.hideAttempted) input.hideAttempted = true;
  if (state.hideCompleted) input.hideCompleted = true;
  if (state.showOnlyAttempted) input.showOnlyAttempted = true;
  if (state.showOnlyCompleted) input.showOnlyCompleted = true;

  const statusFlags = statusToFlags(state.status);
  if (statusFlags.onlyDrafts) input.onlyDrafts = true;
  if (statusFlags.projectsOnly) input.projectsOnly = true;

  if (options?.name && options.name.length > 0) {
    input.name = options.name;
  }

  return input;
}
