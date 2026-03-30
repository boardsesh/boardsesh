export const boardDataTypeDefs = /* GraphQL */ `
  # ============================================
  # Board Data Types (ported from REST APIs)
  # ============================================

  """
  Climb difficulty statistics for a specific angle.
  """
  type ClimbStatsForAngle {
    "Board angle in degrees"
    angle: Int!
    "Number of ascensionists at this angle"
    ascensionistCount: Int!
    "Average quality rating"
    qualityAverage: Float
    "Average difficulty rating"
    difficultyAverage: Float
    "Display difficulty value"
    displayDifficulty: Float
    "First ascensionist username"
    faUsername: String
    "First ascent date"
    faAt: String
    "Human-readable grade name"
    difficulty: String
  }

  """
  A YouTube/Instagram beta link for a climb.
  """
  type BetaLink {
    "Climb UUID"
    climbUuid: String!
    "URL to the beta video"
    link: String!
    "Username of the beta poster"
    foreignUsername: String
    "Board angle the beta was recorded at"
    angle: Int
    "Video thumbnail URL"
    thumbnail: String
    "Whether the beta link is listed publicly"
    isListed: Boolean
    "When the beta link was created"
    createdAt: String
  }

  """
  Hold usage statistics for heatmap display.
  """
  type HoldStat {
    "Hold identifier"
    holdId: Int!
    "Total times this hold is used across matching climbs"
    totalUses: Int!
    "Number of times used as a starting hold"
    startingUses: Int!
    "Total ascents across climbs using this hold"
    totalAscents: Int!
    "Number of times used as a hand hold"
    handUses: Int!
    "Number of times used as a foot hold"
    footUses: Int!
    "Number of times used as a finish hold"
    finishUses: Int!
    "Average difficulty of climbs using this hold"
    averageDifficulty: Float
    "Number of user ascents on climbs using this hold"
    userAscents: Int
    "Number of user attempts on climbs using this hold"
    userAttempts: Int
  }

  """
  Input for heatmap query with board configuration and search filters.
  """
  input HeatmapInput {
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
    "Grade accuracy filter"
    gradeAccuracy: String
    "Minimum difficulty grade ID"
    minGrade: Int
    "Maximum difficulty grade ID"
    maxGrade: Int
    "Minimum number of ascents"
    minAscents: Int
    "Minimum quality rating"
    minRating: Float
    "Field to sort by"
    sortBy: String
    "Sort direction"
    sortOrder: String
    "Filter by climb name"
    name: String
    "Filter by setter name"
    settername: String
    "Only show classic climbs"
    onlyClassics: Boolean
    "Only show tall climbs"
    onlyTallClimbs: Boolean
    "Hold filter object"
    holdsFilter: JSON
  }

  """
  Enum for slug resolution type.
  """
  enum SlugType {
    LAYOUT
    SIZE
    SETS
  }

  """
  Result of resolving a slug to board configuration IDs.
  """
  type SlugResult {
    "Resolved layout row"
    layout: SlugLayout
    "Resolved size row"
    size: SlugSize
    "Resolved set rows"
    sets: [SlugSet!]
  }

  type SlugLayout {
    id: Int!
    name: String!
  }

  type SlugSize {
    id: Int!
    name: String!
    description: String!
  }

  type SlugSet {
    id: Int!
    name: String!
  }

  """
  Full climb detail including lit-up holds map.
  Same as Climb type but returned from the detail endpoint.
  """
  type ClimbDetail {
    "Unique identifier"
    uuid: ID!
    "Setter username"
    setter_username: String!
    "Climb name"
    name: String!
    "Climb description"
    description: String!
    "Encoded hold frames"
    frames: String!
    "Board angle"
    angle: Int!
    "Number of ascensionists"
    ascensionist_count: Int!
    "Difficulty grade string"
    difficulty: String!
    "Average quality"
    quality_average: String!
    "Difficulty error margin"
    difficulty_error: String!
    "Benchmark difficulty if applicable"
    benchmark_difficulty: String
    "Map of hold IDs to their lit-up state"
    litUpHoldsMap: JSON!
  }

  """
  Setter statistics with climb count.
  """
  type SetterStat {
    "Setter username"
    setterUsername: String!
    "Number of climbs set"
    climbCount: Int!
  }

  """
  Input for setter stats query.
  """
  input SetterInput {
    "Board type"
    boardName: String!
    "Layout ID"
    layoutId: Int!
    "Size ID"
    sizeId: Int!
    "Comma-separated set IDs"
    setIds: String!
    "Board angle in degrees"
    angle: Int!
    "Optional search query to filter setter names"
    search: String
  }

  # ============================================
  # Aurora Proxy Types
  # ============================================

  """
  Result of Aurora login.
  """
  type AuroraLoginResult {
    "Aurora session token"
    token: String!
    "Aurora user ID"
    userId: Int!
  }

  """
  Input for saving an ascent via Aurora.
  """
  input SaveAscentInput {
    "Aurora session token"
    token: String!
    "Ascent UUID"
    uuid: String!
    "Aurora user ID"
    userId: Int!
    "Climb UUID"
    climbUuid: String!
    "Board angle"
    angle: Int!
    "Whether the climb is mirrored"
    isMirror: Boolean!
    "Attempt ID (1=flash)"
    attemptId: Int!
    "Number of bids/tries"
    bidCount: Int!
    "Quality rating"
    quality: Int!
    "Difficulty rating"
    difficulty: Int!
    "Whether this is a benchmark climb"
    isBenchmark: Boolean!
    "Comment"
    comment: String!
    "Date/time climbed"
    climbedAt: String!
  }

  """
  Result of saving an ascent.
  """
  type SaveAscentResult {
    "Whether the save was successful"
    success: Boolean!
  }

  """
  Result of Aurora user data sync.
  """
  type SyncResult {
    "Whether the sync was successful"
    success: Boolean!
    "Optional message"
    message: String
  }

  # ============================================
  # User Management Types (new)
  # ============================================

  """
  Result of setting a password.
  """
  type SetPasswordResult {
    "Success message"
    message: String!
  }

  """
  Counts of unsynced items per board.
  """
  type UnsyncedCounts {
    kilter: UnsyncedBoardCounts!
    tension: UnsyncedBoardCounts!
  }

  type UnsyncedBoardCounts {
    ascents: Int!
    climbs: Int!
  }

  """
  A user's board account mapping.
  """
  type UserBoardMapping {
    id: ID!
    userId: String!
    boardType: String!
    boardUserId: Int!
    boardUsername: String
    linkedAt: String!
  }

  # ============================================
  # Admin/Internal Types
  # ============================================

  """
  A user's hold classification.
  """
  type HoldClassification {
    id: ID!
    userId: String!
    boardType: String!
    layoutId: Int!
    sizeId: Int!
    holdId: Int!
    holdType: String
    handRating: Int
    footRating: Int
    pullDirection: Int
    createdAt: String!
    updatedAt: String!
  }

  """
  Input for saving a hold classification.
  """
  input SaveHoldClassificationInput {
    boardType: String!
    layoutId: Int!
    sizeId: Int!
    holdId: Int!
    holdType: String
    handRating: Int
    footRating: Int
    pullDirection: Int
  }

  """
  Input for querying hold classifications.
  """
  input HoldClassificationsInput {
    boardType: String!
    layoutId: Int!
    sizeId: Int!
  }

  """
  Result of resolving a climb UUID to a URL.
  """
  type ClimbRedirectResult {
    "Resolved URL path"
    url: String!
  }
`;
