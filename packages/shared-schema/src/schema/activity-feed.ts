export const activityFeedTypeDefs = /* GraphQL */ `
  # ============================================
  # Activity Feed Types
  # ============================================

  """
  A climb ascent with enriched data for activity feeds.
  """
  type AscentFeedItem {
    "Tick UUID"
    uuid: ID!
    "UUID of the climb"
    climbUuid: String!
    "Name of the climb"
    climbName: String!
    "Username of the setter"
    setterUsername: String
    "Board type"
    boardType: String!
    "Specific board entity id, when this ascent is safe to associate with a named board"
    boardId: Int
    "Specific board display name, when this ascent is safe to associate with a named board"
    boardDisplayName: String
    "Layout ID"
    layoutId: Int
    "Board angle"
    angle: Int!
    "Whether climb was mirrored"
    isMirror: Boolean!
    "Result of the attempt"
    status: TickStatus!
    "Number of attempts"
    attemptCount: Int!
    "Quality rating"
    quality: Int
    "Difficulty rating"
    difficulty: Int
    "Human-readable difficulty name"
    difficultyName: String
    "Consensus difficulty rounded to the nearest grade ID"
    consensusDifficulty: Int
    "Human-readable consensus difficulty name"
    consensusDifficultyName: String
    "Average quality rating from all users"
    qualityAverage: Float
    "Whether this is a benchmark climb"
    isBenchmark: Boolean!
    "Whether matching is disallowed on this climb"
    isNoMatch: Boolean!
    "Comment"
    comment: String!
    "When climbed (ISO 8601)"
    climbedAt: String!
    "Encoded hold frames for thumbnail display"
    frames: String
  }

  """
  Paginated ascent feed result.
  """
  type AscentFeedResult {
    "List of ascent feed items"
    items: [AscentFeedItem!]!
    "Total count for pagination"
    totalCount: Int!
    "Whether more items are available"
    hasMore: Boolean!
  }

  """
  Grouped climb attempts for a single climb on a single day.
  Useful for displaying activity summaries.
  """
  type GroupedAscentFeedItem {
    "Unique key for this group (climbUuid-date)"
    key: String!
    "UUID of the climb"
    climbUuid: String!
    "Name of the climb"
    climbName: String!
    "Username of the setter"
    setterUsername: String
    "Board type"
    boardType: String!
    "Layout ID"
    layoutId: Int
    "Board angle"
    angle: Int!
    "Whether climb was mirrored"
    isMirror: Boolean!
    "Encoded hold frames for thumbnail"
    frames: String
    "Human-readable difficulty name"
    difficultyName: String
    "Whether this is a benchmark climb"
    isBenchmark: Boolean!
    "Whether matching is disallowed on this climb"
    isNoMatch: Boolean!
    "Date of the attempts (YYYY-MM-DD)"
    date: String!
    "Number of flash sends"
    flashCount: Int!
    "Number of regular sends"
    sendCount: Int!
    "Number of attempts without send"
    attemptCount: Int!
    "Best quality rating from any attempt"
    bestQuality: Int
    "Most recent comment"
    latestComment: String
    "Individual items in this group"
    items: [AscentFeedItem!]!
  }

  """
  Paginated grouped ascent feed result.
  """
  type GroupedAscentFeedResult {
    "List of grouped items"
    groups: [GroupedAscentFeedItem!]!
    "Total count"
    totalCount: Int!
    "Whether more groups are available"
    hasMore: Boolean!
  }

  """
  Pagination input for ascent feeds.
  """
  input AscentFeedInput {
    "Maximum number of items to return"
    limit: Int
    "Number of items to skip"
    offset: Int
    "Optional board type filter (kilter, tension, moonboard)"
    boardType: String
    "Optional board type filter for multiple board types"
    boardTypes: [String!]
    "Optional layout filters within the selected board type"
    layoutIds: [Int!]
    "Legacy status filter (flash, send, attempt)"
    status: String
    "Status mode filter: both, send, attempt"
    statusMode: String
    "When true, only include flashes within the selected status mode"
    flashOnly: Boolean
    "Optional climb name search (case-insensitive partial match)"
    climbName: String
    "Optional minimum difficulty filter (difficulty_id)"
    minDifficulty: Int
    "Optional maximum difficulty filter (difficulty_id)"
    maxDifficulty: Int
    "Optional minimum wall angle filter"
    minAngle: Int
    "Optional maximum wall angle filter"
    maxAngle: Int
    "When true, only include benchmark climbs"
    benchmarkOnly: Boolean
    "Primary sort field"
    sortBy: String
    "Primary sort order: desc (default) or asc"
    sortOrder: String
    "Optional secondary sort field"
    secondarySortBy: String
    "Optional secondary sort order"
    secondarySortOrder: String
    "Optional start date filter (ISO date string, inclusive)"
    fromDate: String
    "Optional end date filter (ISO date string, inclusive)"
    toDate: String
  }

  """
  An ascent from a followed user, enriched with user and climb data.
  """
  type FollowingAscentFeedItem {
    "Tick UUID"
    uuid: ID!
    "User who climbed"
    userId: ID!
    "Display name of the user"
    userDisplayName: String
    "Avatar URL of the user"
    userAvatarUrl: String
    "UUID of the climb"
    climbUuid: String!
    "Name of the climb"
    climbName: String!
    "Username of the setter"
    setterUsername: String
    "Board type"
    boardType: String!
    "Layout ID"
    layoutId: Int
    "Board angle"
    angle: Int!
    "Whether climb was mirrored"
    isMirror: Boolean!
    "Result of the attempt"
    status: String!
    "Number of attempts"
    attemptCount: Int!
    "Quality rating"
    quality: Int
    "Difficulty rating"
    difficulty: Int
    "Human-readable difficulty name"
    difficultyName: String
    "Whether this is a benchmark climb"
    isBenchmark: Boolean!
    "Whether matching is disallowed on this climb"
    isNoMatch: Boolean!
    "Comment"
    comment: String!
    "When climbed (ISO 8601)"
    climbedAt: String!
    "Encoded hold frames for thumbnail display"
    frames: String
    # Social aggregates are only populated by resolvers that opt-in to the
    # tick comment / vote joins (e.g. \`followingClimbAscents\`). They are
    # nullable here so adapter paths like activity-feed or the paginated
    # \`followingAscentsFeed\` / \`globalAscentsFeed\` don't have to compute or
    # fake counts they don't need.
    "Number of upvotes (likes) on this tick. Null if the resolver doesn't compute it."
    upvotes: Int
    "Number of downvotes on this tick. Null if the resolver doesn't compute it."
    downvotes: Int
    "Number of (non-deleted) comments on this tick. Null if the resolver doesn't compute it."
    commentCount: Int
  }

  """
  Input for following ascents feed pagination.
  """
  input FollowingAscentsFeedInput {
    "Maximum number of items to return"
    limit: Int
    "Number of items to skip"
    offset: Int
  }

  """
  Paginated feed of ascents from followed users.
  """
  type FollowingAscentsFeedResult {
    "List of feed items"
    items: [FollowingAscentFeedItem!]!
    "Total count for pagination"
    totalCount: Int!
    "Whether more items are available"
    hasMore: Boolean!
  }

  """
  Input for fetching followed users' ticks on a specific climb.
  """
  input FollowingClimbAscentsInput {
    "Board type (kilter, tension, moonboard)"
    boardType: String!
    "Climb UUID"
    climbUuid: String!
  }

  """
  Unpaginated result: all ticks from followed users for a given climb.
  """
  type FollowingClimbAscentsResult {
    "List of feed items"
    items: [FollowingAscentFeedItem!]!
  }

  # ============================================
  # Materialized Activity Feed Types
  # ============================================

  enum ActivityFeedItemType {
    ascent
    new_climb
    comment
    proposal_approved
    session_summary
  }

  """
  A materialized activity feed item.
  """
  type ActivityFeedItem {
    "Feed item ID"
    id: ID!
    "Type of activity"
    type: ActivityFeedItemType!
    "Entity type this item relates to"
    entityType: SocialEntityType!
    "Entity ID"
    entityId: String!
    "Board UUID (for board-scoped filtering)"
    boardUuid: String
    "Actor user ID"
    actorId: String
    "Actor display name"
    actorDisplayName: String
    "Actor avatar URL"
    actorAvatarUrl: String
    "Name of the climb"
    climbName: String
    "UUID of the climb"
    climbUuid: String
    "Board type (kilter, tension, moonboard)"
    boardType: String
    "Layout ID"
    layoutId: Int
    "Grade name"
    gradeName: String
    "Ascent status (flash, send, attempt)"
    status: String
    "Board angle"
    angle: Int
    "Encoded hold frames for thumbnail"
    frames: String
    "Setter username"
    setterUsername: String
    "Comment body preview"
    commentBody: String
    "Whether climb was mirrored"
    isMirror: Boolean
    "Whether this is a benchmark climb"
    isBenchmark: Boolean
    "Whether matching is disallowed on this climb"
    isNoMatch: Boolean
    "Difficulty rating"
    difficulty: Int
    "Human-readable difficulty name"
    difficultyName: String
    "Quality rating"
    quality: Int
    "Number of attempts"
    attemptCount: Int
    "User comment on the ascent"
    comment: String
    "Number of comments on the social entity"
    commentCount: Int
    "When this feed item was created (ISO 8601)"
    createdAt: String!
    "JSON-encoded metadata for type-specific data (e.g., session summary stats)"
    metadata: String
  }

  """
  Cursor-based paginated activity feed result.
  """
  type ActivityFeedResult {
    "List of feed items"
    items: [ActivityFeedItem!]!
    "Cursor for next page"
    cursor: String
    "Whether more items are available"
    hasMore: Boolean!
  }

  """
  Input for activity feed queries.
  """
  input ActivityFeedInput {
    "Cursor from previous page"
    cursor: String
    "Maximum number of items to return"
    limit: Int
    "Filter by board UUID"
    boardUuid: String
    "Filter sessions where this user is a participant"
    userId: String
    "Restrict results to users followed by the authenticated viewer"
    followingOnly: Boolean
    "Include one daily hardest-send card for followed/user-filtered days without explicit sessions"
    includeDailyHighlights: Boolean
  }

  """
  Input for the global comment feed query.
  """
  input GlobalCommentFeedInput {
    "Cursor from previous page"
    cursor: String
    "Maximum number of comments to return"
    limit: Int
    "Filter by board UUID"
    boardUuid: String
  }

  # ============================================
  # Session-Grouped Feed Types
  # ============================================

  """
  A participant in a climbing session.
  """
  type SessionFeedParticipant {
    userId: ID!
    displayName: String
    avatarUrl: String
    sends: Int!
    flashes: Int!
    attempts: Int!
  }

  """
  Grade distribution item with flash/send/attempt breakdown.
  """
  type SessionGradeDistributionItem {
    grade: String!
    flash: Int!
    send: Int!
    attempt: Int!
  }

  """
  A highlighted tick used by session feed cards.
  """
  type SessionFeedTickHighlight {
    uuid: ID!
    userId: String!
    climbUuid: String!
    climbName: String
    boardType: String!
    layoutId: Int
    angle: Int!
    status: String!
    attemptCount: Int!
    difficulty: Int
    difficultyName: String
    quality: Int
    isMirror: Boolean!
    isBenchmark: Boolean!
    isNoMatch: Boolean!
    comment: String
    frames: String
    setterUsername: String
    climbedAt: String!
  }

  """
  A beta video paired with the tick it represents in a session feed card.
  """
  type SessionFeedBetaHighlight {
    tick: SessionFeedTickHighlight!
    betaLink: BetaLink!
  }

  """
  A session feed card representing a group of ticks from a climbing session.
  """
  type SessionFeedItem {
    sessionId: ID!
    sessionType: String!
    sessionName: String
    ownerUserId: ID
    participants: [SessionFeedParticipant!]!
    totalSends: Int!
    totalFlashes: Int!
    totalAttempts: Int!
    tickCount: Int!
    gradeDistribution: [SessionGradeDistributionItem!]!
    boardTypes: [String!]!
    hardestGrade: String
    hardestSend: SessionFeedTickHighlight
    featuredBeta: SessionFeedBetaHighlight
    socialEntityType: SocialEntityType!
    socialEntityId: String!
    firstTickAt: String!
    lastTickAt: String!
    durationMinutes: Int
    goal: String
    upvotes: Int!
    downvotes: Int!
    voteScore: Int!
    commentCount: Int!
  }

  """
  Paginated session-grouped feed result.
  """
  type SessionFeedResult {
    sessions: [SessionFeedItem!]!
    cursor: String
    hasMore: Boolean!
  }

  """
  An individual tick within a session detail view.
  """
  type SessionDetailTick {
    uuid: ID!
    userId: String!
    climbUuid: String!
    climbName: String
    boardType: String!
    layoutId: Int
    angle: Int!
    status: String!
    attemptCount: Int!
    difficulty: Int
    difficultyName: String
    quality: Int
    isMirror: Boolean!
    isBenchmark: Boolean!
    isNoMatch: Boolean!
    comment: String
    frames: String
    setterUsername: String
    climbedAt: String!
    upvotes: Int!
    "Total attempts (sum of attemptCount) since last successful ascent by this user on this climb"
    totalAttempts: Int
    "Stored beta videos attached to this climb, batched with the session detail (no live enrichment). Populated by the session-detail query; absent on other selections that reuse this type (e.g. the live SessionStatsUpdated subscription)."
    betaLinks: [BetaLink!]
  }

  """
  Full detail for a single session, including all ticks.
  """
  type SessionDetail {
    sessionId: ID!
    sessionType: String!
    sessionName: String
    ownerUserId: ID
    participants: [SessionFeedParticipant!]!
    totalSends: Int!
    totalFlashes: Int!
    totalAttempts: Int!
    tickCount: Int!
    gradeDistribution: [SessionGradeDistributionItem!]!
    boardTypes: [String!]!
    hardestGrade: String
    firstTickAt: String!
    lastTickAt: String!
    durationMinutes: Int
    goal: String
    ticks: [SessionDetailTick!]!
    upvotes: Int!
    downvotes: Int!
    voteScore: Int!
    commentCount: Int!
    healthKitWorkoutId: String
  }
`;
