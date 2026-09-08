import type { ClimbSearchInput } from '@boardsesh/shared-schema';

export const SORT_OPTIONS = ['ascents', 'quality', 'difficulty', 'name', 'popular', 'creation', 'random'] as const;
export type SortOption = (typeof SORT_OPTIONS)[number];

export const SORT_ORDERS = ['asc', 'desc'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

/**
 * Fresh seed for the `random` sort. A random 31-bit integer as a string, shared
 * by web and mobile so both generate seeds identically. The seed salts a
 * deterministic order (Postgres `md5(uuid || seed)`, SQLite arithmetic mixer) so
 * OFFSET-paginated infinite scroll stays stable across pages for one shuffle,
 * while re-selecting `random` yields a new seed (a fresh shuffle).
 */
export function newSortSeed(): string {
  return String(1 + Math.floor(Math.random() * 2147483646));
}

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
  // Seed for the `random` sort, set when the user picks Random (see newSortSeed).
  // Undefined for every other sort; cleared when switching away from random.
  sortSeed?: string;
  minGrade?: number;
  maxGrade?: number;
  minAscents?: number;
  minRating?: number;
  gradeAccuracy?: GradeAccuracyValue;
  setter?: string[];
  onlyTallClimbs?: boolean;
  onlyWideClimbs?: boolean;
  onlyWithBetaVideos?: boolean;
  // Climb-type toggles. Default is boulders-only (routes hidden) — see
  // DEFAULT_CLIMB_FILTER_STATE. Both-on or both-off means "no preference" and
  // maps to no frames_count constraint (both-on sends explicit boulders:
  // true, routes: true rather than omitting — see toClimbSearchInput for
  // why). Maps to ClimbSearchInput.boulders/routes, whose SQL lives in
  // @boardsesh/db create-climb-filters.ts (boulders → frames_count = 1 or
  // NULL, routes → frames_count > 1).
  boulders?: boolean;
  routes?: boolean;
  status: StatusFilter;
  hideAttempted?: boolean;
  hideCompleted?: boolean;
  showOnlyAttempted?: boolean;
  showOnlyCompleted?: boolean;
  // The user's own star rating, read from their ticks at the browsed angle.
  // `minUserRating` (1-5) keeps climbs they never rated; `onlyRatedByMe` drops
  // those. Both are auth-gated backend-side, like the four tick flags above.
  minUserRating?: number;
  onlyRatedByMe?: boolean;
};

export const DEFAULT_CLIMB_FILTER_STATE: ClimbFilterState = {
  sortBy: 'ascents',
  sortOrder: 'desc',
  status: 'any',
  // Match web: show boulders, hide routes until the user opts in.
  boulders: true,
  routes: false,
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
  if (state.minUserRating != null) return true;
  if (state.onlyRatedByMe) return true;
  // Default is boulders-only, so "active" means routes turned on or boulders off.
  if ((state.boulders ?? true) !== true) return true;
  if ((state.routes ?? false) !== false) return true;
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
  options?: { name?: string; personalGrades?: boolean },
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

  if (state.sortBy === 'random' && state.sortSeed) input.sortSeed = state.sortSeed;
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
  if (state.minUserRating != null) input.minUserRating = state.minUserRating;
  if (state.onlyRatedByMe) input.onlyRatedByMe = true;

  // Personal grades (#4796, #4828): the climber's own grade drives the grade
  // range and the difficulty sort, so a climb they re-graded lands in the band
  // the row already shows them.
  //
  // Sent ONLY when it can change the answer. Everywhere else the param would buy
  // nothing and cost the Redis cache: `useMyGrades` is user-specific, so a search
  // carrying it resolves a userId and leaves the cacheable set. Plain browse —
  // the app's busiest query — therefore stays byte-identical and stays cached.
  const gradeBoundSet = state.minGrade != null || state.maxGrade != null;
  if (options?.personalGrades && (gradeBoundSet || state.sortBy === 'difficulty')) {
    input.useMyGrades = true;
  }

  // Climb-type filter. Both-on ("All") and both-off mean "no preference" for
  // the frames_count constraint, but they must NOT be handled the same way:
  //
  // - Both-off is genuinely omitted (unreachable via any current UI — web's
  //   never-both-off toggle and mobile's boulders/routes/both selector never
  //   produce it — kept as-is, out of scope for this fix).
  // - Both-on ("All") sends explicit boulders: true, routes: true rather than
  //   omitting both fields. Omission and explicit true/true are behaviourally
  //   identical (both parse to no frames_count constraint): the backend's
  //   ClimbSearchInputSchema has no `.default()` on these fields (#3975
  //   removed the dead-code default that searchClimbs's discarded
  //   validateInput() return used to make unreachable), and
  //   mapSearchInputToParams passes `undefined` through unchanged. Sending
  //   explicit true/true here is still the right call — it keeps this
  //   contract independent of the backend schema's defaulting choices. See
  //   create-climb-filters.ts for the SQL this maps to.
  const bouldersOn = state.boulders ?? true;
  const routesOn = state.routes ?? false;
  if (bouldersOn && routesOn) {
    input.boulders = true;
    input.routes = true;
  } else if (bouldersOn !== routesOn) {
    if (bouldersOn) input.boulders = true;
    if (routesOn) input.routes = true;
  }

  const statusFlags = statusToFlags(state.status);
  if (statusFlags.onlyDrafts) input.onlyDrafts = true;
  if (statusFlags.projectsOnly) input.projectsOnly = true;

  if (options?.name && options.name.length > 0) {
    input.name = options.name;
  }

  return input;
}
