import type { BoardName } from '@boardsesh/shared-schema';

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
  sortBy?: 'ascents' | 'difficulty' | 'name' | 'quality' | 'popular' | 'creation' | (string & {});
  sortOrder?: 'asc' | 'desc' | (string & {});
  // Filters
  gradeAccuracy?: number;
  minGrade?: number;
  maxGrade?: number;
  minRating?: number;
  minAscents?: number;
  name?: string;
  settername?: string[];
  setternameSuggestion?: string;
  onlyClassics?: boolean;
  onlyTallClimbs?: boolean;
  // Hold filters: per-hold partial map of {STATE: 'include' | 'exclude'} entries.
  // Walked at SQL build time by `createClimbFilters`. Shape is intentionally
  // loose (Record<string, unknown>) here so this package doesn't depend on the
  // shared-schema types — the validator gates input shape upstream.
  holdsFilter?: Record<string, unknown>;
  // Personal progress filters
  hideAttempted?: boolean;
  hideCompleted?: boolean;
  showOnlyAttempted?: boolean;
  showOnlyCompleted?: boolean;
  // Minimum quality threshold the current user has given a climb (1-5 stars).
  // 0 / undefined means no filter.
  minUserQuality?: number;
  // When true, climbs the user has never rated are excluded. When false (default),
  // unrated climbs still pass through and only ratings below `minUserQuality`
  // are filtered out.
  hideWithoutUserQuality?: boolean;
  onlyDrafts?: boolean;
  projectsOnly?: boolean;
  // Zone filter — restrict to climbs whose bounding box fits inside this box
  zoneBox?: ZoneBox | null;
  // Allow dynamic hold keys (e.g., hold_123)
  [key: `hold_${number}`]: unknown;
};

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
  name: string;
  description: string;
  frames: string;
  angle: number;
  ascensionist_count: number;
  difficulty: string;
  quality_average: string;
  stars: number;
  difficulty_error: string;
  benchmark_difficulty: string | null;
  is_draft: boolean;
  created_at: string | null;
  published_at: string | null;
};
