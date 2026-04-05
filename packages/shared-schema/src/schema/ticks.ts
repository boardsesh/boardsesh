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
    "User's quality rating (0-3)"
    quality: Int
    "User's difficulty rating"
    difficulty: Int
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
    "Quality rating (0-3)"
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
  }

  """
  Input for updating an existing tick.
  """
  input UpdateTickInput {
    "UUID of the tick to update"
    uuid: ID!
    "New status (flash, send, attempt)"
    status: TickStatus
    "New attempt count"
    attemptCount: Int
    "New quality rating (1-5, or null to clear)"
    quality: Int
    "New comment"
    comment: String
  }

  """
  Input for deleting a tick.
  """
  input DeleteTickInput {
    "UUID of the tick to delete"
    uuid: ID!
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
`;
