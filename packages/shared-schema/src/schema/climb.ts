export const climbTypeDefs = /* GraphQL */ `
  """
  A climbing problem/route on an interactive training board.
  Contains all information needed to display and light up the climb on the board.
  """
  type Climb {
    "Unique identifier for the climb"
    uuid: ID!
    "Layout ID the climb belongs to (used to identify cross-layout climbs)"
    layoutId: Int
    "Username of the person who created this climb"
    setter_username: String!
    "Boardsesh user ID of the climb owner (null for Aurora-synced climbs). Used as the stable identity for ownership gates like the post-publish edit window."
    userId: ID
    "Name/title of the climb"
    name: String!
    "Description or notes about the climb (nullable - omitted from search results, fetch separately via climb detail query)"
    description: String
    "Encoded hold positions and colors for lighting up the board"
    frames: String!
    "Board angle in degrees when this climb was set"
    angle: Int!
    "Number of people who have completed this climb"
    ascensionist_count: Int!
    "Difficulty grade of the climb (e.g., 'V5', '6B+')"
    difficulty: String!
    "Average quality rating from users"
    quality_average: String!
    "Star rating (0-5), rounded from quality_average"
    stars: Float!
    "Difficulty uncertainty/spread"
    difficulty_error: String!
    "Whether the climb should be displayed mirrored"
    mirrored: Boolean
    "Official benchmark difficulty if this is a benchmark climb"
    benchmark_difficulty: String
    "Whether this climb is a draft (unpublished)"
    is_draft: Boolean
    "Number of times the current user has sent this climb"
    userAscents: Int
    "Number of times the current user has attempted this climb"
    userAttempts: Int
    "Board type this climb belongs to (e.g. 'kilter', 'tension'). Populated in multi-board contexts."
    boardType: String
    "Whether this climb disallows matching (both hands on the same hold)"
    is_no_match: Boolean
    "ISO timestamp of when this climb was first published (null while still a draft)"
    published_at: String
    "ISO timestamp of when this climb row was created"
    created_at: String
    "Number of animation frames encoded in the frames string. 1 for static climbs; >1 for variable-speed Aurora routes/circuits."
    framesCount: Int
    "Animation pace between frames, in Aurora's native unit (treated as milliseconds). 0 when not set."
    framesPace: Int
  }

  """
  Input type for creating or updating a climb.
  """
  input ClimbInput {
    uuid: ID!
    setter_username: String!
    "Boardsesh user ID of the climb owner (null for Aurora-synced climbs)."
    userId: ID
    name: String!
    description: String
    frames: String!
    angle: Int!
    ascensionist_count: Int!
    difficulty: String!
    quality_average: String!
    stars: Float!
    difficulty_error: String!
    mirrored: Boolean
    benchmark_difficulty: String
    is_no_match: Boolean
    "Whether this climb is still a draft."
    is_draft: Boolean
    "ISO timestamp of when this climb was first published."
    published_at: String
    userAscents: Int
    userAttempts: Int
    "Number of animation frames encoded in \`frames\`. 1 for static climbs."
    framesCount: Int
    "Native per-frame pace, in milliseconds. 0 when unset."
    framesPace: Int
  }

  # ============================================
  # Climb Search Types
  # ============================================

  """
  Bounding box defining a board region for filtering climbs.
  Coordinates are in the same grid space as board placements
  (board_holes.x/y) and board_climbs edge columns.
  """
  input ZoneBoxInput {
    "Left edge of the zone (smaller x)"
    edgeLeft: Int!
    "Right edge of the zone (larger x)"
    edgeRight: Int!
    "Bottom edge of the zone (smaller y)"
    edgeBottom: Int!
    "Top edge of the zone (larger y)"
    edgeTop: Int!
  }

  """
  How a drawn zone should match climbs.
  allHolds keeps the existing behavior: every climb hold must fit inside the box.
  anyHold matches climbs that use at least one hold inside the box.
  """
  enum ZoneMatchMode {
    allHolds
    anyHold
  }

  """
  Input parameters for searching climbs.
  Supports filtering, sorting, and pagination.
  """
  input ClimbSearchInput {
    "Board type (e.g., 'kilter', 'tension')"
    boardName: String!
    "Layout ID"
    layoutId: Int!
    "Size ID"
    sizeId: Int!
    "Comma-separated set IDs"
    setIds: String!
    "Board angle in degrees"
    angle: Int!
    "Page number for pagination (1-indexed)"
    page: Int
    "Number of results per page"
    pageSize: Int
    "Grade accuracy filter ('tight', 'moderate', 'loose')"
    gradeAccuracy: String
    "Minimum difficulty grade ID"
    minGrade: Int
    "Maximum difficulty grade ID"
    maxGrade: Int
    "Minimum number of ascents"
    minAscents: Int
    "Minimum quality rating"
    minRating: Float
    "Field to sort by ('ascents', 'difficulty', 'name', 'quality', 'popular')"
    sortBy: String
    "Sort direction ('asc' or 'desc')"
    sortOrder: String
    "Filter by climb name (partial match)"
    name: String
    "Filter by setter usernames"
    setter: [String!]
    "Filter by setter ID"
    setterId: Int
    "Only show benchmark climbs"
    onlyBenchmarks: Boolean
    "Only show tall/steep climbs"
    onlyTallClimbs: Boolean
    "Only show Kilter Homewall climbs that use the 10x10 side expansion"
    onlyWideClimbs: Boolean
    "Only show climbs that have a beta video"
    onlyWithBetaVideos: Boolean
    "Hold filter object: { holdId: 'ANY' | 'NOT', ... }"
    holdsFilter: JSON
    "Hide climbs the user has attempted (requires auth)"
    hideAttempted: Boolean
    "Hide climbs the user has completed (requires auth)"
    hideCompleted: Boolean
    "Only show climbs the user has attempted (requires auth)"
    showOnlyAttempted: Boolean
    "Only show climbs the user has completed (requires auth)"
    showOnlyCompleted: Boolean
    "Show only the user's draft climbs (requires auth)"
    onlyDrafts: Boolean
    "Show only unclimbed projects (climbs with 0 ascents)"
    projectsOnly: Boolean
    "Include single-frame climbs (boulders). Default true. Set to false (paired with routes=true) to filter to routes only."
    boulders: Boolean
    "Include multi-frame climbs (routes). Default false. Set to true to include or filter to routes."
    routes: Boolean
    "Restrict results using this drawn zone"
    zoneBox: ZoneBoxInput
    "How the zone should match climb holds. Defaults to allHolds when omitted."
    zoneMode: ZoneMatchMode
  }

  """
  Result of a climb search query.
  """
  type ClimbSearchResult {
    "List of climbs matching the search criteria"
    climbs: [Climb!]!
    "Total number of climbs matching (for pagination)"
    totalCount: Int!
    "Whether there are more results available"
    hasMore: Boolean!
  }

  """
  Per-hold aggregate usage for the search heatmap overlay.
  Counts respect the same filters supplied to ClimbSearchInput.
  """
  type HoldHeatmapPoint {
    "Board hold identifier"
    holdId: Int!
    "Number of matching climbs using this hold"
    totalUses: Int!
    "Number of matching climbs using this hold as a start"
    startingUses: Int!
    "Total community ascents across matching climbs using this hold"
    totalAscents: Int!
    "Number of matching climbs using this hold as a hand"
    handUses: Int!
    "Number of matching climbs using this hold as a foot"
    footUses: Int!
    "Number of matching climbs using this hold as a finish"
    finishUses: Int!
    "Average displayed difficulty across matching climbs using this hold"
    averageDifficulty: Float
    "Current user's sends on climbs using this hold, when authenticated"
    userAscents: Int
    "Current user's attempts on climbs using this hold, when authenticated"
    userAttempts: Int
  }

  """
  Input for fetching setter usernames with their climb counts.
  Used to power the setter filter autocomplete in the search drawer.
  """
  input SetterStatsInput {
    "Board type (e.g., 'kilter', 'tension')"
    boardName: String!
    "Layout ID"
    layoutId: Int!
    "Size ID"
    sizeId: Int!
    "Comma-separated set IDs"
    setIds: String!
    "Board angle in degrees"
    angle: Int!
    "Case-insensitive substring filter on setter username (for autocomplete)"
    search: String
  }

  """
  A setter username paired with the number of climbs they've authored
  for a given board configuration and angle.
  """
  type SetterStat {
    "Setter's username"
    setterUsername: String!
    "Number of climbs authored by this setter for the board configuration"
    climbCount: Int!
  }
`;
