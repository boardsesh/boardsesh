import type { BoardName, HoldState } from '@boardsesh/shared-schema';

/**
 * Route parameters identifying a specific board configuration.
 */
export interface BoardRouteParams {
  board_name: BoardName;
  layout_id: number;
  size_id: number;
  set_ids: number[];
  angle: number;
}

/**
 * Search parameters for the climb search query.
 * Shared between web and backend packages.
 */
export interface ClimbSearchParams {
  // Pagination
  page?: number;
  pageSize?: number;
  // Sorting
  sortBy?: 'ascents' | 'difficulty' | 'name' | 'quality' | 'popular' | 'creation' | string;
  sortOrder?: 'asc' | 'desc' | string;
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
  // Hold filters - 'ANY', 'NOT', or specific states like 'STARTING', 'HAND', etc.
  // Record<string, unknown> allows for both simple strings and the object-based LitUpHoldsMap
  holdsFilter?: Record<string, unknown>;
  // Personal progress filters
  hideAttempted?: boolean;
  hideCompleted?: boolean;
  showOnlyAttempted?: boolean;
  showOnlyCompleted?: boolean;
  onlyDrafts?: boolean;
  projectsOnly?: boolean;
  // Allow dynamic hold keys (e.g., hold_123)
  [key: `hold_${number}`]: unknown;
}

/**
 * Result of a climb search query.
 */
export interface ClimbSearchResult {
  climbs: ClimbRow[];
  hasMore: boolean;
}

/**
 * A single row from the climb search query.
 */
export interface ClimbRow {
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
  /** Board type this climb belongs to (e.g. 'kilter', 'tension'). */
  boardType: string;
  /** Layout ID this climb belongs to. */
  layoutId: number;
}
