import type { HoldRenderData } from '../components/board-renderer/types';
import type { BoardName as SharedBoardName } from '@boardsesh/shared-schema';
import type { SetIdList } from './board-data';

export type Climb = {
  uuid: string;
  layoutId?: number | null; // Layout the climb belongs to - used to identify cross-layout climbs
  boardType?: string; // Board type this climb belongs to (e.g. 'kilter', 'tension'). Populated in multi-board contexts.
  setter_username: string;
  // Boardsesh user ID of the climb owner. Null for Aurora-synced climbs
  // that pre-date Boardsesh accounts. Used for ownership gates (e.g. the
  // Edit affordance in queue-list) instead of the mutable setter_username.
  userId?: string | null;
  name: string;
  description?: string;
  frames: string;
  angle: number;
  ascensionist_count: number;
  difficulty: string;
  quality_average: string;
  stars: number;
  difficulty_error: string;
  mirrored?: boolean;
  benchmark_difficulty: string | null; // Benchmark difficulty, can be null
  is_draft?: boolean;
  is_no_match?: boolean;
  userAscents?: number;
  userAttempts?: number;
  // ISO timestamp of when this climb row was created
  created_at?: string | null;
  // ISO timestamp of when this climb was first published (null while still a draft)
  published_at?: string | null;
};

export type ClimbQueryResult = {
  uuid: string; // UUID of the climb
  setter_username: string; // Username of the setter
  name: string; // Name of the climb
  description: string; // Description of the climb
  frames: string; // Holds and placement frames for the climb
  angle: number; // Angle of the climb
  ascensionist_count: number; // Number of people who completed the climb
  difficulty: string | null; // Difficulty grade of the climb, can be null
  quality_average: number; // Average quality rating of the climb
  difficulty_error: string; // Difficulty error, represented as a string (e.g., "0.00")
  benchmark_difficulty: string | null; // Benchmark difficulty, can be null
};

// Example of an array of ClimbQueryResult
export type ClimbQueryResults = ClimbQueryResult[];

// Layout Type
export type LayoutsResponse = {
  id: number;
  name: string;
};

// Size Type
export type SizesResponse = {
  id: number;
  name: string;
  description: string;
};

// Set Type
export type SetsResponse = {
  id: number;
  name: string;
};

// Search Request Type
export type HoldCode = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 42 | 43 | 44 | 45 | 12 | 13 | 14 | 15;
export type HoldState = 'STARTING' | 'HAND' | 'FOOT' | 'FINISH' | 'OFF' | 'ANY' | 'NOT';

export type HoldStateFilter = {
  holdId: string;
  stateCode: HoldCode;
};

export type HoldStateWithColor = {
  state: HoldState;
  color: string;
  displayColor: string;
};

// Search filter types: each hold can carry a partial map of type→mode filters,
// e.g. { STARTING: 'include', FOOT: 'exclude' }. ANY means "hold present in any
// state" (matches today's wildcard behaviour).
export type HoldFilterType = 'STARTING' | 'HAND' | 'FINISH' | 'FOOT' | 'ANY';
export type HoldFilterMode = 'include' | 'exclude';
export type HoldFilterEntry = Partial<Record<HoldFilterType, HoldFilterMode>>;
export type HoldsFilter = Record<number, HoldFilterEntry>;

/**
 * Bounding box on the board grid (board_holes.x/y coords). Used by the
 * Zone search filter to restrict results to climbs that fit inside it.
 */
export type ZoneBox = {
  edgeLeft: number;
  edgeRight: number;
  edgeBottom: number;
  edgeTop: number;
};

export type SearchRequest = {
  gradeAccuracy: number;
  maxGrade: number;
  minAscents: number;
  minGrade: number;
  minRating: number;
  sortBy: 'ascents' | 'difficulty' | 'name' | 'quality' | 'popular' | 'creation';
  sortOrder: 'asc' | 'desc';
  name: string;
  onlyClassics: boolean;
  onlyTallClimbs: boolean;
  settername: string[];
  setternameSuggestion: string;
  holdsFilter: HoldsFilter;
  hideAttempted: boolean;
  hideCompleted: boolean;
  showOnlyAttempted: boolean;
  showOnlyCompleted: boolean;
  minUserQuality: number;
  hideWithoutUserQuality: boolean;
  onlyDrafts: boolean;
  projectsOnly: boolean;
  zoneBox: ZoneBox | null;
};

export type SearchRequestPagination = SearchRequest & {
  page: number;
  pageSize: number;
};

// Search Result Type
export type SearchResult = {
  uuid: string;
  setter_username: string;
  name: string;
  description: string;
  frames: number;
  angle: number;
  ascensionist_count: number;
  difficulty: string;
  quality_average: number;
  difficulty_error: number;
  benchmark_difficulty: number;
};

export type BoardRouteParametersWithUuid = BoardRouteParameters & {
  climb_uuid: ClimbUuid;
};

export type ParsedBoardRouteParameters = {
  board_name: BoardName;
  layout_id: number;
  size_id: number;
  set_ids: SetIdList;
  angle: number;
  uuid?: string;
};

export type ParsedBoardRouteParametersWithUuid = ParsedBoardRouteParameters & {
  climb_uuid: ClimbUuid;
};

export type ClimbUuid = string;

export type BoardName = SharedBoardName;
export type LayoutId = number;
export type Angle = number;
export type Size = number;
export type FetchResultsResponse = {
  rows: Climb[];
  totalCount?: number;
  hasMore?: boolean;
};

export type SearchClimbsResult = {
  climbs: Climb[];
  totalCount?: number;
  hasMore?: boolean;
};

// Led Colors Type
export type LedColor = Record<number, string>;

// Grade Type
export type Grade = {
  difficulty_id: number;
  difficulty_name: string;
};

// Beta Link Type
export type BetaLink = {
  angle: number;
  foreign_username: string;
  link: string;
};

// Define a tuple type for each hold
export type HoldTuple = [number, number | null, number, number];

export type PlacementsMap = HoldRenderData[];

// Ensure imagesToHolds is typed as a Record where each key maps to an array of HoldTuples
export type ImageFileName = string;
export type ImagesToHolds = Record<ImageFileName, HoldTuple[]>;
export type LedPlacements = Record<number, number>;

export type BoardDetails = {
  images_to_holds: ImagesToHolds;
  holdsData: PlacementsMap;
  edge_left: number;
  edge_right: number;
  edge_bottom: number;
  edge_top: number;
  boardHeight: number;
  boardWidth: number;
  board_name: BoardName;
  layout_id: number;
  size_id: number;
  set_ids: SetIdList;
  supportsMirroring?: boolean;
  // Added for slug-based URLs
  layout_name?: string;
  size_name?: string;
  size_description?: string;
  set_names?: string[];
  // Moonboard-specific fields for grid-based rendering
  layoutFolder?: string; // e.g., 'moonboard2024'
  holdSetImages?: string[]; // e.g., ['holdsetd.png', 'holdsete.png']
};

/**
 * Minimal board identity needed for URL construction.
 * Use this instead of full BoardDetails when only building URLs.
 */
export type BoardRouteIdentity = {
  board_name: BoardName;
  layout_id: number;
  size_id: number;
  set_ids: SetIdList;
  layout_name?: string;
  size_name?: string;
  size_description?: string;
  set_names?: string[];
};

export type BoardRouteParameters = {
  board_name: string;
  layout_id: string;
  size_id: string;
  set_ids: string;
  angle: string;
  climb_uuid?: string;
};

// Route parameters for routes with only board_name
export type BoardOnlyRouteParameters = {
  board_name: string;
};

export type FetchCurrentProblemResponse = Climb;

export type ErrorResponse = {
  error: string;
};
