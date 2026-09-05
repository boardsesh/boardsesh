// Climb and Hold types
import type { MoonBoardHoldsInput } from './new-climb-feed';
import type { RenderBoardConfig } from './activity-feed';

export type HoldState = 'OFF' | 'STARTING' | 'FINISH' | 'HAND' | 'FOOT' | 'ANY' | 'NOT' | 'AUX';
export type LitupHold = { state: HoldState; color: string; displayColor: string };
export type LitUpHoldsMap = Record<number, LitupHold>;

// Search filter shape: each hold can carry a partial map of type→mode filters,
// e.g. { STARTING: 'include', FOOT: 'exclude' }. ANY means "hold present in any
// state". A hold with an empty entry should be removed from the filter.
export type HoldFilterType = 'STARTING' | 'HAND' | 'FINISH' | 'FOOT' | 'ANY';
export type HoldFilterMode = 'include' | 'exclude';
export type HoldFilterEntry = Partial<Record<HoldFilterType, HoldFilterMode>>;
export type HoldsFilter = Record<string, HoldFilterEntry>;

export type Climb = {
  uuid: string;
  layoutId?: number | null; // GraphQL nullable Int - layout the climb belongs to
  setter_username: string;
  // Boardsesh user ID of the climb owner. Null for Aurora-synced climbs
  // that pre-date Boardsesh accounts. Used for ownership gates instead of
  // the mutable setter_username.
  userId?: string | null;
  name: string;
  description?: string | null;
  frames: string;
  angle: number;
  ascensionist_count: number;
  difficulty: string;
  quality_average: string;
  stars: number;
  difficulty_error: string;
  mirrored?: boolean | null; // GraphQL nullable Boolean
  benchmark_difficulty: string | null;
  userAscents?: number | null; // GraphQL nullable Int
  userAttempts?: number | null; // GraphQL nullable Int
  boardType?: string; // Populated in multi-board contexts
  is_no_match?: boolean | null; // Whether matching is disallowed
  // Structured climb characteristics (e.g. 'no_match', 'method_footless').
  // Decode with the CLIMB_CHARACTERISTICS helpers (isNoMatch / getMoonBoardMethod).
  characteristics?: string[] | null;
  is_draft?: boolean | null; // Whether this climb is still a draft
  // ISO timestamp of when the climb was first published (transitioned out of
  // draft). Null while the climb is still a draft. Used by the create form
  // to enforce the 24h post-publish edit window.
  published_at?: string | null;
  // ISO timestamp of when the climb row was created.
  created_at?: string | null;
  // Number of animation frames encoded in `frames` (1 for static climbs;
  // >1 for variable-speed routes/circuits synced from Aurora). Null falls
  // back to "single frame" semantics on the playback engine.
  framesCount?: number | null;
  // Pace between frames, treated as milliseconds. Clamped on the engine
  // side. 0/null disables auto-advance.
  framesPace?: number | null;
  // Boardsesh grade for this climb+angle on the shared difficulty scale
  // (COALESCE(universal_grade, local_grade)). Null when no grade row exists
  // (MoonBoard, too few ascents) — the UI keeps the Aurora grade then.
  boardseshDifficulty?: number | null;
  // Boardsesh grade confidence tier ('confirmed' | 'provisional' |
  // 'setter_only'). Null when no grade row exists. The UI keeps the Aurora
  // grade when this is null or 'setter_only'.
  boardseshConfidence?: string | null;
  // Board configuration to draw this climb on, resolved against its setter's
  // boards. Populated by `userClimbs` (the profile Climbs tab, where no board is
  // in the route); null everywhere the board comes from the URL.
  renderBoard?: RenderBoardConfig | null;
  // `board_climbs.compatible_size_ids` — the product sizes this climb fits on.
  // Null/undefined means the server has no compatibility data for it (a legacy
  // row, or a fetch path that doesn't project the column) and imposes no
  // constraint. Load-bearing on Woods, whose two sizes number their holds from
  // their own origins, so hold-id containment alone can't tell them apart
  // (canAddClimbToBoard rule 5).
  compatibleSizeIds?: number[] | null;
};

// Input type for Climb (matches GraphQL ClimbInput)
export type ClimbInput = {
  uuid: string;
  // Board the climb belongs to. Round-tripped through the queue so a connected
  // board can skip a climb set for a different board/layout instead of
  // dark-firing the wall.
  boardType?: string;
  layoutId?: number | null;
  setter_username: string;
  // Boardsesh user ID of the climb owner; nullable for Aurora-synced climbs.
  userId?: string | null;
  name: string;
  description?: string | null;
  frames: string;
  angle: number;
  ascensionist_count: number;
  difficulty: string;
  quality_average: string;
  stars: number;
  difficulty_error: string;
  mirrored?: boolean | null;
  benchmark_difficulty?: string | null;
  is_no_match?: boolean | null;
  // Structured characteristics round-tripped so the queue keeps method/no-match tags.
  characteristics?: string[] | null;
  // Round-trips draft/publish state through the queue so peers can gate
  // the Edit affordance without re-querying the DB.
  is_draft?: boolean | null;
  published_at?: string | null;
  userAscents?: number | null;
  userAttempts?: number | null;
  // Round-trip through the queue input so peers reconstruct multi-frame climb
  // metadata without a /climb refetch — the playback engine reads these.
  framesCount?: number | null;
  framesPace?: number | null;
  // Boardsesh grade + confidence tier, round-tripped through the queue so party
  // peers render the grade without a per-climb refetch. Null when unavailable.
  boardseshDifficulty?: number | null;
  boardseshConfidence?: string | null;
  // `board_climbs.compatible_size_ids`, round-tripped through the queue so a
  // party peer on a different-sized wall can tell the climb doesn't fit theirs.
  // Null/undefined means unknown and imposes no constraint.
  compatibleSizeIds?: number[] | null;
};

/**
 * Bounding box on the board grid (same coordinate space as board_holes.x/y
 * and board_climbs edge columns). Used to filter search results to climbs
 * whose entire bounding box sits inside the zone.
 */
export type ZoneBoxInput = {
  edgeLeft: number;
  edgeRight: number;
  edgeBottom: number;
  edgeTop: number;
};

export type ZoneMatchMode = 'allHolds' | 'anyHold';

export type ClimbSearchInput = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  // Pagination
  page?: number;
  pageSize?: number;
  // Filters
  gradeAccuracy?: string;
  minGrade?: number;
  maxGrade?: number;
  minAscents?: number;
  minRating?: number;
  sortBy?: string;
  sortOrder?: string;
  // Seed for the 'random' sort, keeping OFFSET pagination stable across pages.
  sortSeed?: string;
  name?: string;
  setter?: string[];
  setterId?: number;
  onlyBenchmarks?: boolean;
  onlyTallClimbs?: boolean;
  onlyWideClimbs?: boolean;
  onlyWithBetaVideos?: boolean;
  // Hold filters: per-hold partial type→mode map (see HoldFilterEntry).
  holdsFilter?: HoldsFilter;
  // Personal progress filters
  hideAttempted?: boolean;
  hideCompleted?: boolean;
  showOnlyAttempted?: boolean;
  showOnlyCompleted?: boolean;
  // Personal rating filters, read from the user's own ticks at the browsed
  // angle. `minUserRating` keeps unrated climbs visible (0 = no minimum);
  // `onlyRatedByMe` drops them.
  minUserRating?: number;
  onlyRatedByMe?: boolean;
  onlyDrafts?: boolean;
  projectsOnly?: boolean;
  // Climb-type toggles. Both undefined / both true → no frames_count filter.
  // Boulders only → `frames_count = 1`. Routes only → `frames_count > 1`.
  boulders?: boolean;
  routes?: boolean;
  // Zone filter — restrict climbs based on a user-drawn bounding box.
  zoneBox?: ZoneBoxInput;
  zoneMode?: ZoneMatchMode;
};

/**
 * Search params that require a userId to have any effect on query results.
 * Used by caching layers (Redis, CDN, SSR) to decide whether results are
 * user-specific or can be shared across all users.
 *
 * Type-checked against ClimbSearchInput so adding/removing a field here
 * causes a compile error if the type doesn't match.
 */
export const USER_SPECIFIC_SEARCH_PARAMS = [
  'hideAttempted',
  'hideCompleted',
  'showOnlyAttempted',
  'showOnlyCompleted',
  'minUserRating',
  'onlyRatedByMe',
  'onlyDrafts',
] as const satisfies ReadonlyArray<keyof ClimbSearchInput>;

export type ClimbSearchResult = {
  climbs: Climb[];
  totalCount: number;
  hasMore: boolean;
};

export type SetterStatsInput = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  search?: string;
};

export type SetterStat = {
  setterUsername: string;
  climbCount: number;
};

/** Complete canonical row emitted by the layout-scoped live-stats stream. */
export type ClimbStatsEvent = {
  boardType: string;
  layoutId: number;
  climbUuid: string;
  angle: number;
  ascensionistCount: number;
  qualityAverage: number | null;
  difficultyAverage: number | null;
  displayDifficulty: number | null;
  difficulty: string | null;
  faUsername: string | null;
  faAt: string | null;
  syncSeq: string;
};

export type SaveClimbInput = {
  boardType: string;
  layoutId: number;
  name: string;
  description?: string | null;
  isDraft: boolean;
  frames: string;
  framesCount?: number | null;
  framesPace?: number | null;
  angle: number;
  // Freely-toggleable characteristics to set at creation. Only
  // CLIMB_CHARACTERISTICS.NO_KICKBOARD / .CAMPUS are accepted here — MoonBoard
  // method is creation-time-only via SaveMoonBoardClimbInput, and no_match /
  // any_feet ride the dedicated booleans below.
  characteristics?: string[] | null;
  /**
   * Matching disallowed. When set, this WINS over the legacy "No match\n"
   * description prefix; null/omitted falls back to that prefix (old clients) and
   * otherwise means false.
   */
  noMatch?: boolean | null;
  /** Any hold on the wall counts as a foot. Null/omitted means false. */
  anyFeet?: boolean | null;
  /**
   * Physical board size the climb is set on. Required on Woods (1 = 8x10,
   * 2 = 12x12), whose two walls number their holds from their own origins, so
   * the size is part of the climb's identity. Ignored on every other board,
   * which derives `compatible_size_ids` from the hold bounding box.
   */
  sizeId?: number | null;
};

export type SaveMoonBoardClimbInput = {
  boardType: string;
  layoutId: number;
  name: string;
  description?: string | null;
  holds: MoonBoardHoldsInput;
  angle: number;
  isDraft?: boolean | null;
  userGrade?: string | null;
  isBenchmark?: boolean | null;
  /** MoonBoard method as a characteristic token (method_footless / method_footless_kickboard /
   *  method_no_kickboard). Omit for the "feet follow hands" default. */
  method?: string | null;
  setter?: string | null;
};

export type SaveClimbResult = {
  uuid: string;
  synced: boolean;
  /** ISO timestamp of when the row was created */
  createdAt?: string | null;
  /** ISO timestamp of when the row was first published (null while still a draft) */
  publishedAt?: string | null;
};

/**
 * Input for updating an existing climb. Only the climb's owner can update
 * it, and only while the climb is still a draft OR within 24 hours of its
 * first publish. The backend enforces both rules.
 */
export type UpdateClimbInput = {
  uuid: string;
  boardType: string;
  name?: string | null;
  description?: string | null;
  frames?: string | null;
  angle?: number | null;
  /**
   * When set, flips the climb's draft state. A climb can go from draft→published
   * at any point (that's the publish action), but cannot be un-published.
   */
  isDraft?: boolean | null;
  framesCount?: number | null;
  framesPace?: number | null;
  // Freely-toggleable characteristics: the full desired boolean state of
  // CLIMB_CHARACTERISTICS.NO_KICKBOARD / .CAMPUS. Any other characteristic
  // already on the row (no_match, any_feet, MoonBoard method) is left untouched.
  characteristics?: string[] | null;
  /**
   * Matching disallowed. Null/omitted preserves whatever the row already says —
   * an old client that has never heard of this field can't clear it. When set it
   * WINS over the legacy "No match\n" description prefix in the same call.
   */
  noMatch?: boolean | null;
  /** Any hold counts as a foot. Null/omitted preserves the row's current value. */
  anyFeet?: boolean | null;
  /**
   * Physical board size, for boards where it is part of the climb's identity
   * (Woods). Immutable: sending a size that differs from the stored one is
   * rejected rather than silently moving the climb to the other wall. Null or
   * omitted keeps the stored size.
   */
  sizeId?: number | null;
};

export type UpdateClimbResult = {
  uuid: string;
  /** ISO timestamp of when the row was created */
  createdAt?: string | null;
  /** ISO timestamp of when the row was first published (null while still a draft) */
  publishedAt?: string | null;
  isDraft: boolean;
};
