// Climb and Hold types
import type { MoonBoardHoldsInput } from './new-climb-feed';

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
};

// Input type for Climb (matches GraphQL ClimbInput)
export type ClimbInput = {
  uuid: string;
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
  onlyDrafts?: boolean;
  projectsOnly?: boolean;
  // Climb-type toggles. Both undefined or both true means all climbs.
  // Boulders only means `frames_count = 1`. Routes only means `frames_count > 1`.
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
};

export type UpdateClimbResult = {
  uuid: string;
  /** ISO timestamp of when the row was created */
  createdAt?: string | null;
  /** ISO timestamp of when the row was first published (null while still a draft) */
  publishedAt?: string | null;
  isDraft: boolean;
};
