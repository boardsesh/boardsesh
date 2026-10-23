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
  onlyFollowedAuthors?: boolean;
  onlyTallClimbs?: boolean;
  onlyWideClimbs?: boolean;
  onlyWithBetaVideos?: boolean;
  // Also list climbs set at another angle, graded and ranked at their own set
  // angle. Only angle-bound boards (Woods, `angleBoundClimbs` in
  // @boardsesh/board-config) offer the switch; there the browsed angle alone is
  // the default. Maps to ClimbSearchInput.crossAngleStats.
  includeOtherAngles?: boolean;
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
  // Only the climbs the signed-in climber has hearted on this board, at any
  // angle (a heart belongs to the climb). Auth-gated backend-side: signed out
  // the search returns nothing. Kept apart from `status` so web's status values
  // stay untouched. Maps to ClimbSearchInput.onlyFavorited.
  onlyFavorited?: boolean;
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
 * {@link ClimbFilterState} under any list's sort keys. The Climbs list sorts by
 * {@link SortOption}; a playlist has sorts of its own (`PlaylistSortOption`) but
 * the same filters, so the helpers that only read filters take this shape.
 */
export type AnySortClimbFilterState = Omit<ClimbFilterState, 'sortBy'> & { sortBy: string };

/** The climb-type toggles as `[boulders, routes]`, an unset toggle reading as its default. */
export function climbTypeSelection(
  state: Pick<ClimbFilterState, 'boulders' | 'routes'>,
  defaults: Pick<ClimbFilterState, 'boulders' | 'routes'> = DEFAULT_CLIMB_FILTER_STATE,
): [boolean, boolean] {
  const defaultBoulders = defaults.boulders ?? true;
  const defaultRoutes = defaults.routes ?? false;
  return [state.boulders ?? defaultBoulders, state.routes ?? defaultRoutes];
}

/** True when the climb-type toggles differ from `defaults` (boulders-only on the Climbs list). */
export function isClimbTypeFilterActive(
  state: Pick<ClimbFilterState, 'boulders' | 'routes'>,
  defaults: Pick<ClimbFilterState, 'boulders' | 'routes'> = DEFAULT_CLIMB_FILTER_STATE,
): boolean {
  const [boulders, routes] = climbTypeSelection(state, defaults);
  const [defaultBoulders, defaultRoutes] = climbTypeSelection(defaults, defaults);
  return boulders !== defaultBoulders || routes !== defaultRoutes;
}

/**
 * Returns true when any filter field differs from the default state.
 *
 * `defaults` is the list's own starting state: the Climbs list's
 * ({@link DEFAULT_CLIMB_FILTER_STATE}) unless a caller passes another, so a list
 * that starts with both climb types on (a playlist) doesn't read as filtered.
 */
export function hasActiveClimbFilters(
  state: AnySortClimbFilterState,
  defaults: AnySortClimbFilterState = DEFAULT_CLIMB_FILTER_STATE,
): boolean {
  if (state.sortBy !== defaults.sortBy) return true;
  if (state.sortOrder !== defaults.sortOrder) return true;
  if (state.status !== defaults.status) return true;
  if (state.minGrade != null) return true;
  if (state.maxGrade != null) return true;
  if (state.minAscents != null) return true;
  if (state.minRating != null) return true;
  if (state.gradeAccuracy != null) return true;
  if (state.setter != null && state.setter.length > 0) return true;
  if (state.onlyFollowedAuthors) return true;
  if (state.onlyTallClimbs) return true;
  if (state.onlyWideClimbs) return true;
  if (state.onlyWithBetaVideos) return true;
  if (state.includeOtherAngles) return true;
  if (state.hideAttempted) return true;
  if (state.hideCompleted) return true;
  if (state.showOnlyAttempted) return true;
  if (state.showOnlyCompleted) return true;
  if (state.minUserRating != null) return true;
  if (state.onlyRatedByMe) return true;
  if (state.onlyFavorited) return true;
  // The Climbs list defaults to boulders-only, so there "active" means routes
  // turned on or boulders off; a list with other defaults compares to its own.
  if (isClimbTypeFilterActive(state, defaults)) return true;
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
 * Filters an older app stored that no longer have a control, normalized on read
 * of a stored search or recent pill:
 *
 * - "established" is retired as a user-facing status (it's the same lever as
 *   `minAscents >= 2`, now folded into the Popularity control). Map it to `any`
 *   while preserving `minAscents`, so the UI never holds a status that has no
 *   control and the active-filter count doesn't double-count the one lever.
 *   The enum value is kept for back-compat.
 * - `holdIntegrity` was the spray-wall "Holds" filter (Current / All / Intact /
 *   Lost holds). It is gone: a climb that lost a hold is listed with a badge,
 *   and the app sends no integrity filter for a wall list. A stored value is
 *   dropped so it is not written back with the next save.
 *
 * Returns the same reference when there is nothing to change.
 */
export function normalizeRetiredFilters(state: ClimbFilterState): ClimbFilterState {
  const { holdIntegrity: retiredHoldIntegrity, ...withoutHoldIntegrity } = state as ClimbFilterState & {
    holdIntegrity?: unknown;
  };
  const statusRetired = state.status === 'established';
  if (retiredHoldIntegrity === undefined && !statusRetired) return state;
  const base: ClimbFilterState = retiredHoldIntegrity === undefined ? state : withoutHoldIntegrity;
  return statusRetired ? { ...base, status: 'any' } : base;
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
 * The filter fields {@link ClimbSearchInput} shares with a playlist's view input
 * (`PlaylistClimbViewInput`), under the same names.
 */
export type SharedClimbFilterInputFields = Pick<
  ClimbSearchInput,
  | 'sortSeed'
  | 'minGrade'
  | 'maxGrade'
  | 'minAscents'
  | 'minRating'
  | 'gradeAccuracy'
  | 'setter'
  | 'onlyFollowedAuthors'
  | 'onlyTallClimbs'
  | 'onlyWideClimbs'
  | 'onlyWithBetaVideos'
  | 'hideAttempted'
  | 'hideCompleted'
  | 'showOnlyAttempted'
  | 'showOnlyCompleted'
  | 'minUserRating'
  | 'onlyRatedByMe'
  | 'onlyFavorited'
  | 'useMyGrades'
  | 'boulders'
  | 'routes'
  | 'projectsOnly'
  | 'name'
>;

export type SharedClimbFilterInputOptions = {
  name?: string;
  personalGrades?: boolean;
  /** Whether the list sorts by difficulty, which is when personal grades change the order. */
  sortsByDifficulty: boolean;
  /** Whether the list is shuffled, which is when `sortSeed` is sent. */
  shuffled: boolean;
  /** The list's climb-type defaults, which decide what an unset toggle means. */
  climbTypeDefaults?: Pick<ClimbFilterState, 'boulders' | 'routes'>;
};

/**
 * Maps the filter state onto the input fields the Climbs search and a playlist's
 * view share. One mapping, so the two lists cannot read the same filter state
 * differently. `toClimbSearchInput` adds the Climbs-only fields on top.
 */
export function toSharedClimbFilterInputFields(
  state: AnySortClimbFilterState,
  options: SharedClimbFilterInputOptions,
): SharedClimbFilterInputFields {
  const fields: SharedClimbFilterInputFields = {};

  if (options.shuffled && state.sortSeed) fields.sortSeed = state.sortSeed;
  if (state.minGrade != null) fields.minGrade = state.minGrade;
  if (state.maxGrade != null) fields.maxGrade = state.maxGrade;
  if (state.minAscents != null) fields.minAscents = state.minAscents;
  if (state.minRating != null) fields.minRating = state.minRating;
  if (state.gradeAccuracy != null) fields.gradeAccuracy = state.gradeAccuracy;
  if (state.setter != null && state.setter.length > 0) fields.setter = state.setter;
  if (state.onlyFollowedAuthors) fields.onlyFollowedAuthors = true;
  if (state.onlyTallClimbs) fields.onlyTallClimbs = true;
  if (state.onlyWideClimbs) fields.onlyWideClimbs = true;
  if (state.onlyWithBetaVideos) fields.onlyWithBetaVideos = true;
  if (state.hideAttempted) fields.hideAttempted = true;
  if (state.hideCompleted) fields.hideCompleted = true;
  if (state.showOnlyAttempted) fields.showOnlyAttempted = true;
  if (state.showOnlyCompleted) fields.showOnlyCompleted = true;
  if (state.minUserRating != null) fields.minUserRating = state.minUserRating;
  if (state.onlyRatedByMe) fields.onlyRatedByMe = true;
  // Off is omitted, not sent as false: the flag is user-specific, so sending it
  // at all would move the everyday search out of the shared cache.
  if (state.onlyFavorited) fields.onlyFavorited = true;
  // Personal grades (#4796, #4828): the climber's own grade drives the grade
  // range and the difficulty sort, so a climb they re-graded lands in the band
  // the row already shows them.
  //
  // Sent ONLY when it can change the answer. Everywhere else the param would buy
  // nothing and cost the Redis cache: `useMyGrades` is user-specific, so a search
  // carrying it resolves a userId and leaves the cacheable set. Plain browse —
  // the app's busiest query — therefore stays byte-identical and stays cached.
  const gradeBoundSet = state.minGrade != null || state.maxGrade != null;
  if (options.personalGrades && (gradeBoundSet || options.sortsByDifficulty)) {
    fields.useMyGrades = true;
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
  const [bouldersOn, routesOn] = climbTypeSelection(state, options.climbTypeDefaults);
  if (bouldersOn && routesOn) {
    fields.boulders = true;
    fields.routes = true;
  } else if (bouldersOn !== routesOn) {
    if (bouldersOn) fields.boulders = true;
    if (routesOn) fields.routes = true;
  }

  if (statusToFlags(state.status).projectsOnly) fields.projectsOnly = true;

  if (options.name && options.name.length > 0) {
    fields.name = options.name;
  }

  return fields;
}

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
    ...toSharedClimbFilterInputFields(state, {
      name: options?.name,
      personalGrades: options?.personalGrades,
      sortsByDifficulty: state.sortBy === 'difficulty',
      shuffled: state.sortBy === 'random',
    }),
  };

  // Off is omitted, not sent as false: an angle-bound board already treats an
  // absent value as "browsed angle only", and omitting keeps the cache key of
  // the everyday search unchanged.
  if (state.includeOtherAngles) input.crossAngleStats = true;
  // A playlist has no drafts view, so this status flag is the Climbs list's own.
  if (statusToFlags(state.status).onlyDrafts) input.onlyDrafts = true;

  return input;
}
