import type { BoardName, ZoneMatchMode } from '@boardsesh/shared-schema';
import type { ConfidenceTier } from '../grade-model/constants';

/**
 * Route parameters identifying a specific board configuration.
 */
export type BoardRouteParams = {
  board_name: BoardName;
  layout_id: number;
  size_id: number;
  set_ids: number[];
  angle: number;
};

/**
 * Bounding box on the board grid (same coordinate space as
 * board_holes.x/y and board_climbs.edge_*). Used to keep search
 * results inside a region the user drew on the board.
 */
export type ZoneBox = {
  edgeLeft: number;
  edgeRight: number;
  edgeBottom: number;
  edgeTop: number;
};

/**
 * Search parameters for the climb search query.
 * Shared between web and backend packages.
 */
export type ClimbSearchParams = {
  // Pagination
  page?: number;
  pageSize?: number;
  // Sorting
  sortBy?: 'ascents' | 'difficulty' | 'name' | 'quality' | 'popular' | 'creation' | 'random' | (string & {});
  sortOrder?: 'asc' | 'desc' | (string & {});
  // Seed for the 'random' sort. Salts md5(uuid || sortSeed) so a shuffle stays
  // stable across OFFSET-paginated pages; a new seed reshuffles.
  sortSeed?: string;
  // Filters
  gradeAccuracy?: number;
  minGrade?: number;
  maxGrade?: number;
  minRating?: number;
  minAscents?: number;
  name?: string;
  settername?: string[];
  onlyFollowedAuthors?: boolean;
  setternameSuggestion?: string;
  onlyBenchmarks?: boolean;
  onlyTallClimbs?: boolean;
  onlyWideClimbs?: boolean;
  onlyWithBetaVideos?: boolean;
  // Hold filters: per-hold partial map of {STATE: 'include' | 'exclude'} entries.
  // Walked at SQL build time by `createClimbFilters`. Shape is intentionally
  // loose (Record<string, unknown>) here so this package doesn't depend on
  // web-only hold-filter types — the validator gates input shape upstream.
  holdsFilter?: Record<string, unknown>;
  // Personal progress filters
  hideAttempted?: boolean;
  hideCompleted?: boolean;
  showOnlyAttempted?: boolean;
  showOnlyCompleted?: boolean;
  // Personal rating filters over the user's own ticks at the browsed angle.
  // `minUserRating` (1-5) hides climbs whose latest rating is below it while
  // keeping never-rated climbs; `onlyRatedByMe` keeps only rated climbs.
  minUserRating?: number;
  onlyRatedByMe?: boolean;
  /**
   * Key the grade filter and the difficulty sort off the climber's OWN grade —
   * the difficulty of their latest tick for (user, board_type, climb_uuid,
   * angle) that carries one, clamped to the boulder scale, falling back to
   * ROUND(display_difficulty) where they never graded the climb (#4828).
   * Needs a userId; ignored for anonymous searches and for drafts queries.
   */
  useMyGrades?: boolean;
  onlyDrafts?: boolean;
  projectsOnly?: boolean;
  /**
   * Hold integrity, for spray walls: 'intact' keeps climbs that have lost no
   * holds, 'broken' keeps only the ones that have, 'any' (the default, and what
   * `undefined` means) adds no predicate at all.
   *
   * Reads the materialised `board_climbs.missing_hold_count`, which a reset
   * re-computes (`recomputeMissingHoldCounts`). Lower case because that is what
   * every other param here uses; the GraphQL enum arrives SCREAMING and is
   * lowered by the validator.
   */
  holdIntegrity?: 'any' | 'intact' | 'broken';
  // Resolve each climb's stats through its own set angle when the browsed angle
  // has no row (issue #5405). Opt-in on every board: omitted means off. On an
  // angle-bound board (Woods) off also restricts the list to the climbs that
  // belong to the browsed angle, and a by-name search turns it on by itself; see
  // `resolveCrossAngleStats` and `resolveBrowsedAngleRestriction` in
  // ./effective-stats (issue #5642).
  crossAngleStats?: boolean;
  /**
   * Which grade minGrade/maxGrade compare against — see `gradeValueSql` in
   * ./create-climb-filters. 'upstream' (and `undefined`, which is what the mapper
   * turns it into so existing search-cache keys are unchanged) reads the board's
   * own catalogue grade (display_difficulty) first; 'boardsesh' reads the
   * model-generated Boardsesh grade first, so a
   * climber who sees Boardsesh grades on the list filters on those labels.
   */
  gradeSource?: 'upstream' | 'boardsesh';
  // Climb-type toggles. Default to undefined (treated as both selected → no
  // SQL filter on frames_count). Set boulders=true to constrain to single-
  // frame climbs, routes=true to constrain to multi-frame climbs. Both true
  // (or both undefined) returns everything.
  boulders?: boolean;
  routes?: boolean;
  // Zone filter — restrict climbs using a user-drawn bounding box.
  zoneBox?: ZoneBox | null;
  zoneMode?: ZoneMatchMode | null;
  // Allow dynamic hold keys (e.g., hold_123)
  [key: `hold_${number}`]: unknown;
};

/**
 * Structural shape accepted by `mapSearchInputToParams`. Loose enough that
 * both the GraphQL `ClimbSearchInput` (camelCase, validated by Zod) and the
 * web `SearchRequestPagination` (URL-derived) satisfy it. The mapper collapses
 * falsy strings/arrays to `undefined` and passes booleans through unchanged.
 */
export type ClimbSearchInputLike = {
  page?: number | null;
  pageSize?: number | null;
  gradeAccuracy?: string | number | null;
  minGrade?: number | null;
  maxGrade?: number | null;
  minAscents?: number | null;
  minRating?: number | null;
  sortBy?: string | null;
  sortOrder?: string | null;
  sortSeed?: string | null;
  name?: string | null;
  // GraphQL field is `setter`; web field is `settername`. Accept both — the
  // mapper picks `settername` if present, otherwise `setter`.
  setter?: string[] | null;
  settername?: string[] | null;
  onlyFollowedAuthors?: boolean | null;
  onlyBenchmarks?: boolean | null;
  onlyTallClimbs?: boolean | null;
  onlyWideClimbs?: boolean | null;
  onlyWithBetaVideos?: boolean | null;
  holdsFilter?: Record<string, unknown> | null;
  hideAttempted?: boolean | null;
  hideCompleted?: boolean | null;
  showOnlyAttempted?: boolean | null;
  showOnlyCompleted?: boolean | null;
  minUserRating?: number | null;
  onlyRatedByMe?: boolean | null;
  useMyGrades?: boolean | null;
  onlyDrafts?: boolean | null;
  projectsOnly?: boolean | null;
  holdIntegrity?: string | null;
  crossAngleStats?: boolean | null;
  gradeSource?: string | null;
  boulders?: boolean | null;
  routes?: boolean | null;
  zoneBox?: ZoneBox | null;
  zoneMode?: ZoneMatchMode | null;
};

const SEARCH_SORT_ALIASES: Record<string, NonNullable<ClimbSearchParams['sortBy']>> = {
  ascents: 'ascents',
  difficulty: 'difficulty',
  name: 'name',
  quality: 'quality',
  popular: 'popular',
  creation: 'creation',
  random: 'random',
  created_at: 'creation',
  published_at: 'creation',
};

/**
 * Whether this search is an explicit by-name lookup.
 *
 * Two rules key on it and must agree on what counts: the community-hidden filter
 * (`hiddenClimbCondition` in ./create-climb-filters — a named climb is findable
 * even when hidden) and the angle-bound browse restriction
 * (`resolveCrossAngleStats` in ./effective-stats — a named climb is findable at
 * any angle). It lives here rather than beside either of them because
 * create-climb-filters already imports effective-stats, and each needs it.
 *
 * The offline mirror reads `input.name` the same way in
 * packages/mobile/src/db/queries/search-climbs-local.ts (`hasNameQuery`).
 */
export function hasNameQuery(searchParams: Pick<ClimbSearchParams, 'name'>): boolean {
  return typeof searchParams.name === 'string' && searchParams.name.length > 0;
}

/**
 * Map a wire `holdIntegrity` value onto the param.
 *
 * Unknown strings collapse to undefined rather than throwing: the validator has
 * already rejected anything off the enum by the time a GraphQL search gets here,
 * and the SSR path builds this shape from URL text where an unreadable value must
 * not blank the page.
 */
export function normalizeHoldIntegrity(raw: string | null | undefined): ClimbSearchParams['holdIntegrity'] {
  if (!raw) return undefined;
  const value = raw.toLowerCase();
  if (value === 'intact' || value === 'broken') return value;
  return undefined;
}

/**
 * Map a wire `gradeSource` value onto the param. Only BOARDSESH survives: UPSTREAM
 * is the default, so it collapses to undefined like an omitted value — the
 * search-cache key hashes the params, and an explicit default would split one
 * cached page into two keys. Unknown strings collapse too, for the same reason
 * `normalizeHoldIntegrity` gives.
 */
export function normalizeGradeSource(raw: string | null | undefined): ClimbSearchParams['gradeSource'] {
  if (!raw) return undefined;
  return raw.toLowerCase() === 'boardsesh' ? 'boardsesh' : undefined;
}

export function normalizeSearchSortBy(sortBy: string | null | undefined): NonNullable<ClimbSearchParams['sortBy']> {
  if (!sortBy) return 'ascents';
  return SEARCH_SORT_ALIASES[sortBy] ?? 'creation';
}

/**
 * Map an input shape (GraphQL `ClimbSearchInput` or web
 * `SearchRequestPagination`) onto the `ClimbSearchParams` shape consumed by
 * `searchClimbs` / `createClimbFilters`. Centralises the "falsy → undefined"
 * collapse for strings, arrays, and objects so the SSR path and the GraphQL
 * resolver can't drift.
 *
 * Booleans pass through unchanged so explicit `false` from the caller (e.g.
 * `routes: false`) reaches the SQL builder rather than being silently widened.
 * Numeric defaults (page 0, pageSize 20, sortBy 'ascents', sortOrder 'desc')
 * are applied here so both call sites agree.
 */
export function mapSearchInputToParams(input: ClimbSearchInputLike): ClimbSearchParams {
  const setter = input.settername ?? input.setter ?? undefined;
  const sortBy = normalizeSearchSortBy(input.sortBy);
  // The grade source only reaches SQL through the grade range and the difficulty
  // sort. Dropped otherwise, so a search that uses neither keeps one cache key
  // whatever the climber's grade preference is.
  const gradeSourceMatters = !!input.minGrade || !!input.maxGrade || sortBy === 'difficulty';
  const gradeAccuracyRaw = input.gradeAccuracy;
  const gradeAccuracy =
    typeof gradeAccuracyRaw === 'string'
      ? gradeAccuracyRaw
        ? parseFloat(gradeAccuracyRaw)
        : undefined
      : (gradeAccuracyRaw ?? undefined) || undefined;

  return {
    page: input.page ?? 0,
    pageSize: input.pageSize ?? 20,
    gradeAccuracy,
    minGrade: input.minGrade || undefined,
    maxGrade: input.maxGrade || undefined,
    minAscents: input.minAscents || undefined,
    minRating: input.minRating || undefined,
    sortBy,
    sortOrder: input.sortOrder || 'desc',
    sortSeed: input.sortSeed || undefined,
    name: input.name || undefined,
    settername: setter && setter.length > 0 ? setter : undefined,
    onlyFollowedAuthors: input.onlyFollowedAuthors ?? undefined,
    onlyBenchmarks: input.onlyBenchmarks ?? undefined,
    onlyTallClimbs: input.onlyTallClimbs ?? undefined,
    onlyWideClimbs: input.onlyWideClimbs ?? undefined,
    onlyWithBetaVideos: input.onlyWithBetaVideos ?? undefined,
    holdsFilter: input.holdsFilter && Object.keys(input.holdsFilter).length > 0 ? input.holdsFilter : undefined,
    hideAttempted: input.hideAttempted ?? undefined,
    hideCompleted: input.hideCompleted ?? undefined,
    showOnlyAttempted: input.showOnlyAttempted ?? undefined,
    showOnlyCompleted: input.showOnlyCompleted ?? undefined,
    // An explicit 0 means "no minimum" (the same idiom as the community
    // minRating above), so collapse it rather than emitting `>= 0`.
    minUserRating: input.minUserRating || undefined,
    onlyRatedByMe: input.onlyRatedByMe ?? undefined,
    useMyGrades: input.useMyGrades ?? undefined,
    onlyDrafts: input.onlyDrafts ?? undefined,
    projectsOnly: input.projectsOnly ?? undefined,
    // The GraphQL enum is SCREAMING_CASE and the param is lower case. ANY is the
    // "no filter" value, so it collapses to undefined here rather than travelling
    // down to `createClimbFilters` as a predicate that matches everything.
    holdIntegrity: normalizeHoldIntegrity(input.holdIntegrity),
    crossAngleStats: input.crossAngleStats ?? undefined,
    gradeSource: gradeSourceMatters ? normalizeGradeSource(input.gradeSource) : undefined,
    boulders: input.boulders ?? undefined,
    routes: input.routes ?? undefined,
    zoneBox: input.zoneBox || undefined,
    zoneMode: input.zoneBox ? (input.zoneMode ?? undefined) : undefined,
  };
}

/**
 * Result of a climb search query.
 */
export type ClimbSearchResult = {
  climbs: ClimbRow[];
  hasMore: boolean;
};

/**
 * A single row from the climb search query.
 */
export type ClimbRow = {
  uuid: string;
  setter_username: string;
  /** Owner (creator) user id; null for Aurora-imported climbs. Used for edit-ownership gating. */
  userId: string | null;
  name: string;
  description: string;
  frames: string;
  /** Board the climb belongs to (the searched board). Carried so the queue's BLE
   *  spill guard can skip a climb set for a different board/layout. */
  boardType: string;
  layoutId: number;
  angle: number;
  /** The angle the grade, ascents and quality on this row were actually read from.
   *  Equals `angle` normally; differs when the browsed angle had no stats row and
   *  the climb's own set angle supplied them (a search that set `crossAngleStats`,
   *  or a by-name search on Woods). Null when the climb has no stats at any angle — a
   *  genuine project. Display only: `angle` stays the BROWSED angle, which is what
   *  ticks, the queue and the BLE spill guard key on. See ./effective-stats. */
  statsAngle: number | null;
  ascensionist_count: number;
  difficulty: string;
  quality_average: string;
  stars: number;
  difficulty_error: string;
  benchmark_difficulty: string | null;
  /** Structured climb characteristics (e.g. 'no_match', 'method_footless'). */
  characteristics: string[] | null;
  is_draft: boolean;
  /** Community-moderation flag (`board_climbs.is_hidden`). Browse queries filter
   *  hidden climbs out entirely, so a row that carries `true` reached the caller
   *  through a surface that deliberately still shows them — an explicit name
   *  search, or the setter's own climbs list. */
  is_hidden?: boolean | null;
  created_at: string | null;
  published_at: string | null;
  /** Animation frame count (1 for static climbs, >1 for variable-speed routes/circuits). */
  framesCount: number | null;
  /** Per-frame playback pace in Aurora's native unit (treated as ms). 0/null when unset. */
  framesPace: number | null;
  /** Boardsesh grade for this climb+angle: COALESCE(universal_grade, local_grade) on the
   *  shared difficulty scale. Null when no grade row exists (MoonBoard, too few ascents). */
  boardseshDifficulty: number | null;
  /** Boardsesh grade confidence tier; null when no grade row (or a DB value outside
   *  the known tiers, narrowed by `toConfidenceTier` at the mapping site). */
  boardseshConfidence: ConfidenceTier | null;
  /** The climber's OWN grade for this climb at this angle: the difficulty of
   *  their latest graded tick, clamped to the boulder scale. Null when they
   *  never graded it, when the search was anonymous, or when `useMyGrades` was
   *  not asked for — the row was then filtered and ordered by the crowd's grade
   *  and must not claim otherwise (#4828). */
  myDifficulty?: number | null;
  /** `board_climbs.compatible_size_ids` — the product sizes this climb fits on.
   *  Null when the denormalised columns haven't been populated (drafts, legacy
   *  rows), which imposes no constraint. Carried so client-side size checks
   *  (`canAddClimbToBoard`) can separate Woods' two sizes, whose hold ids
   *  overlap without meaning the same holds. */
  compatibleSizeIds: number[] | null;
  /** `board_climbs.missing_hold_count` — how many of this climb's holds have come
   *  off the wall. Spray only; null on every catalogue board and on any row the
   *  reset recompute has never touched, both of which mean "intact". */
  missingHoldCount: number | null;
};
