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
    "User's quality rating (1-5)"
    quality: Int
    "User's personal grade override as a difficulty_id. Null means the user did not attach a personal grade — read \`effectiveDifficulty\` for the value to display (it falls back to the climb's consensus). See docs/ascents-and-attempts.md."
    difficulty: Int
    "Effective grade for display and aggregation: COALESCE(difficulty, ROUND(consensus_difficulty)). Still nullable when the climb has no consensus yet."
    effectiveDifficulty: Int
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
    "Numeric user_boards.id for the selected or connected board. Used when no boardUuid is given; accepted only when the board config matches and the climber owns, can see, or is connected to that board."
    boardId: Int
    "Optional Instagram post or reel URL to attach as beta for the climb"
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
  Input for attaching an Instagram video as beta for a climb.
  """
  input AttachBetaLinkInput {
    "Board type"
    boardType: String!
    "Climb UUID"
    climbUuid: String!
    "Instagram post or reel URL"
    link: String!
    "Optional angle the video was climbed at"
    angle: Int
  }
`;
