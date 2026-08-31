export const ticksTypeDefs = /* GraphQL */ `
  # ============================================
  # Ticks Types (Local Ascent Tracking)
  # ============================================

  """
  Status of a climb attempt.
  """
  enum TickStatus {
    "Completed on first attempt"
    flash
    "Completed after multiple attempts"
    send
    "Did not complete"
    attempt
  }

  """
  A recorded climb attempt or completion.
  """
  type Tick {
    "Unique identifier for this tick"
    uuid: ID!
    "User who recorded this tick"
    userId: ID!
    "Board type"
    boardType: String!
    "UUID of the climb attempted"
    climbUuid: String!
    "Board angle when attempted"
    angle: Int!
    "Whether the climb was mirrored"
    isMirror: Boolean!
    "Result of the attempt"
    status: TickStatus!
    "Number of attempts before success (or total attempts if not sent)"
    attemptCount: Int!
    "User's quality rating (1-5). Raw per-tick value — null for a tick pulled from Kilter, which carries no per-tick quality. Read \`effectiveQuality\` for the value to display."
    quality: Int
    "Effective quality for display: COALESCE(quality, the climber's own synced star rating for this climb+angle from board_climb_ratings). Both are 1-5 native (no rescaling). Still nullable when neither exists. Populated by read queries; mutation responses don't compute it."
    effectiveQuality: Int
    "User's personal grade override as a difficulty_id. Null means the user did not attach a personal grade — read \`effectiveDifficulty\` for the value to display (it falls back to the climb's consensus). See docs/ascents-and-attempts.md."
    difficulty: Int
    "Effective grade for display and aggregation: COALESCE(difficulty, ROUND(consensus_difficulty)). Still nullable when the climb has no consensus yet."
    effectiveDifficulty: Int
    "Boardsesh grade on the shared difficulty scale (COALESCE of the cross-board universal grade and the within-board local grade), for this climb at the tick's angle. Null when no grade row exists. Fills the gap only for ungraded ascents: the user's own tick grade always wins, and the UI keeps the legacy consensus when this is null or 'setter_only'."
    boardseshDifficulty: Float
    "Boardsesh grade confidence tier: 'confirmed' | 'provisional' | 'setter_only' | 'cross_angle_estimate'. The estimate tier is projected from other angles and must not prefill a climber's first grade. Null when no grade row exists."
    boardseshConfidence: String
    "Whether this is a benchmark climb"
    isBenchmark: Boolean!
    "User's comment about the climb"
    comment: String!
    "When the climb was attempted (ISO 8601)"
    climbedAt: String!
    "When this record was created (ISO 8601)"
    createdAt: String!
    "When this record was last updated (ISO 8601)"
    updatedAt: String!
    "Session ID if climbed during a session"
    sessionId: String
    "Type of Aurora sync ('bid' or 'ascent')"
    auroraType: String
    "Aurora platform ID for this tick"
    auroraId: String
    "When synced to Aurora (ISO 8601)"
    auroraSyncedAt: String
    "Layout ID when the climb was attempted"
    layoutId: Int
    "Board entity ID if tick was associated with a board"
    boardId: Int
    # Social aggregates are only populated by read queries (e.g. \`ticks\`).
    # Mutation resolvers (\`saveTick\`, \`updateTick\`) don't compute them so they
    # are nullable here; when a client needs guaranteed counts, prefer
    # \`FollowingAscentFeedItem\` or a direct \`voteSummary\` / \`comments\` query.
    "Number of upvotes (likes) on this tick. Null unless populated by a read query."
    upvotes: Int
    "Number of downvotes on this tick. Null unless populated by a read query."
    downvotes: Int
    "Number of (non-deleted) comments on this tick. Null unless populated by a read query."
    commentCount: Int
  }

  """
  Input for recording a climb attempt.
  """
  input SaveTickInput {
    "Optional client-generated UUID for offline idempotent replay"
    uuid: ID
    "Board type"
    boardType: String!
    "Climb UUID"
    climbUuid: String!
    "Board angle"
    angle: Int!
    "Whether climb was mirrored"
    isMirror: Boolean!
    "Result of the attempt"
    status: TickStatus!
    "Number of attempts"
    attemptCount: Int!
    "Quality rating (1-5)"
    quality: Int
    "Difficulty rating"
    difficulty: Int
    "Whether this is a benchmark climb"
    isBenchmark: Boolean!
    "Comment about the climb"
    comment: String!
    "When the climb was attempted (ISO 8601)"
    climbedAt: String!
    "Session ID if in a session"
    sessionId: String
    "Layout ID for board resolution"
    layoutId: Int
    "Size ID for board resolution"
    sizeId: Int
    "Set IDs for board resolution"
    setIds: String
    "Specific board entity this tick is on, by uuid. When provided, takes precedence over (layoutId, sizeId, setIds) resolution and lets ticks attach to a board the climber doesn't own (e.g. a seeded gym board)."
    boardUuid: String
    "Resolved shared board id (from resolveBoardForSerial) for the BLE-connected wall everyone is logging to. Used when no boardUuid is given; falls back to board-config resolution if it doesn't match the payload."
    boardId: Int
    "Optional Instagram or TikTok video URL to attach as beta for the climb"
    videoUrl: String
  }

  """
  Input for updating an existing tick.
  All fields are optional — only provided fields are updated.
  """
  input UpdateTickInput {
    "Result of the attempt"
    status: TickStatus
    "Number of attempts"
    attemptCount: Int
    "User's quality rating (1-5)"
    quality: Int
    "User's difficulty rating"
    difficulty: Int
    "Whether this is a benchmark ascent"
    isBenchmark: Boolean
    "User comment"
    comment: String
    "When the climb was attempted (ISO 8601)"
    climbedAt: String
    "Board angle to move this ascent to"
    angle: Int
  }

  """
  Input for fetching user's ticks.
  """
  input GetTicksInput {
    "Board type to filter by"
    boardType: String!
    "Optional list of climb UUIDs to filter by"
    climbUuids: [String!]
  }

  """
  Number of ticks a user has logged on a given board type. A lightweight
  aggregate (COUNT grouped by board_type) used to infer a default "home board"
  without fetching every tick history per board.
  """
  type BoardTickCount {
    "Board type"
    boardType: String!
    "Number of ticks logged on this board type"
    count: Int!
  }

  """
  Input for attaching an Instagram or TikTok video as beta for a climb.
  """
  input AttachBetaLinkInput {
    "Board type"
    boardType: String!
    "Climb UUID"
    climbUuid: String!
    "Instagram or TikTok video URL"
    link: String!
    "Optional angle the video was climbed at"
    angle: Int
    "Optional tick UUID this beta video belongs to"
    tickUuid: ID
  }
`;
