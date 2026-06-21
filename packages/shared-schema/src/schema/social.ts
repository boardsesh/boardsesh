export const socialTypeDefs = /* GraphQL */ `
  # ============================================
  # Social Enums
  # ============================================

  enum SocialEntityType {
    playlist_climb
    climb
    tick
    comment
    proposal
    board
    gym
    session
  }

  enum SortMode {
    new
    top
    controversial
    hot
  }

  enum TimePeriod {
    hour
    day
    week
    month
    year
    all
  }

  # ============================================
  # Social / Follow Types
  # ============================================

  """
  Public-facing user profile for social features.
  """
  type PublicUserProfile {
    "User ID"
    id: ID!
    "Display name"
    displayName: String
    "Avatar URL"
    avatarUrl: String
    "Instagram profile URL, if the user has set one"
    instagramUrl: String
    "Number of followers"
    followerCount: Int!
    "Number of users being followed"
    followingCount: Int!
    "Whether the current user follows this user"
    isFollowedByMe: Boolean!
  }

  """
  Paginated list of user profiles (for follower/following lists).
  """
  type FollowConnection {
    "List of user profiles"
    users: [PublicUserProfile!]!
    "Total number of users"
    totalCount: Int!
    "Whether more users are available"
    hasMore: Boolean!
  }

  """
  A user search result with relevance metadata.
  """
  type UserSearchResult {
    "The matching user profile"
    user: PublicUserProfile!
    "Number of recent ascents (last 30 days)"
    recentAscentCount: Int!
    "Why this user matched the search"
    matchReason: String
  }

  """
  Paginated user search results.
  """
  type UserSearchConnection {
    "List of search results"
    results: [UserSearchResult!]!
    "Total number of matching users"
    totalCount: Int!
    "Whether more results are available"
    hasMore: Boolean!
  }

  # ============================================
  # Setter Profile & Search Types
  # ============================================

  """
  Profile of a climb setter (may or may not be a Boardsesh user).
  """
  type SetterProfile {
    "The setter's Aurora username"
    username: String!
    "Total number of climbs set across all boards"
    climbCount: Int!
    "Board types this setter has climbs on"
    boardTypes: [String!]!
    "Number of followers"
    followerCount: Int!
    "Whether the current user follows this setter"
    isFollowedByMe: Boolean!
    "Linked Boardsesh user ID (if setter has a Boardsesh account)"
    linkedUserId: ID
    "Linked user's display name"
    linkedUserDisplayName: String
    "Linked user's avatar URL"
    linkedUserAvatarUrl: String
  }

  """
  A setter result from unified search.
  """
  type SetterSearchResult {
    "The setter's Aurora username"
    username: String!
    "Total number of climbs set"
    climbCount: Int!
    "Board types this setter has climbs on"
    boardTypes: [String!]!
    "Whether the current user follows this setter"
    isFollowedByMe: Boolean!
  }

  """
  A unified search result (can be a Boardsesh user, a setter, or both).
  """
  type UnifiedSearchResult {
    "Boardsesh user profile (if result is a registered user)"
    user: PublicUserProfile
    "Setter profile (if result is a setter)"
    setter: SetterSearchResult
    "Number of recent ascents"
    recentAscentCount: Int!
    "Why this result matched the search"
    matchReason: String
  }

  """
  Paginated unified search results.
  """
  type UnifiedSearchConnection {
    "List of search results"
    results: [UnifiedSearchResult!]!
    "Total number of matching results"
    totalCount: Int!
    "Whether more results are available"
    hasMore: Boolean!
  }

  """
  A climb created by a setter, for display on profile pages.
  """
  type SetterClimb {
    "Climb UUID"
    uuid: String!
    "Climb name"
    name: String
    "Board type (kilter, tension, etc.)"
    boardType: String!
    "Layout ID"
    layoutId: Int!
    "Board angle in degrees"
    angle: Int
    "Display difficulty name (e.g. 'V5')"
    difficultyName: String
    "Average quality rating"
    qualityAverage: Float
    "Number of ascensionists"
    ascensionistCount: Int
    "When the climb was created"
    createdAt: String
  }

  """
  Paginated list of setter climbs.
  """
  type SetterClimbsConnection {
    "List of climbs"
    climbs: [SetterClimb!]!
    "Total number of climbs"
    totalCount: Int!
    "Whether more climbs are available"
    hasMore: Boolean!
  }

  """
  Input for following/unfollowing a setter.
  """
  input FollowSetterInput {
    "The setter's Aurora username"
    setterUsername: String!
  }

  """
  Input for following/unfollowing a playlist.
  """
  input FollowPlaylistInput {
    "The playlist UUID"
    playlistUuid: ID!
  }

  """
  Input for getting a setter profile.
  """
  input SetterProfileInput {
    "The setter's Aurora username"
    username: String!
  }

  """
  Input for fetching setter climbs.
  """
  input SetterClimbsInput {
    "The setter's Aurora username"
    username: String!
    "Optional board type filter"
    boardType: String
    "Optional layout ID filter"
    layoutId: Int
    "Sort order: popular (by ascents, default) or new (by creation date)"
    sortBy: String
    "Maximum number of climbs to return"
    limit: Int
    "Number of climbs to skip"
    offset: Int
  }

  """
  Input for fetching setter climbs with full Climb data.
  Used by the setter profile page for thumbnail rendering.
  """
  input SetterClimbsFullInput {
    "The setter's Aurora username"
    username: String!
    "Board type filter (omit for 'All Boards')"
    boardType: String
    "Layout ID (required when boardType is provided)"
    layoutId: Int
    "Size ID (required when boardType is provided)"
    sizeId: Int
    "Set IDs (required when boardType is provided)"
    setIds: String
    "Board angle (required when boardType is provided)"
    angle: Int
    "Sort order: 'popular' (default) or 'new'"
    sortBy: String
    "Maximum number of climbs to return (default 20)"
    limit: Int
    "Number of climbs to skip (default 0)"
    offset: Int
  }

  """
  Input for fetching all climbs created by a user.
  Looks up both directly created climbs (by userId) and Aurora-imported climbs (via linked setter usernames).
  """
  input UserClimbsInput {
    "The Boardsesh user ID"
    userId: ID!
    "Sort order: 'popular' (default) or 'new'"
    sortBy: String
    "Maximum number of climbs to return (default 20)"
    limit: Int
    "Number of climbs to skip (for pagination)"
    offset: Int
  }

  # ============================================
  # Comments & Votes Types
  # ============================================

  """
  A comment on a social entity (climb, tick, playlist_climb, etc).
  """
  type Comment {
    "Public unique identifier"
    uuid: ID!
    "User who posted the comment"
    userId: ID!
    "Display name of the comment author"
    userDisplayName: String
    "Avatar URL of the comment author"
    userAvatarUrl: String
    "Entity type this comment belongs to"
    entityType: SocialEntityType!
    "Entity ID this comment belongs to"
    entityId: String!
    "Parent comment UUID for replies (null for top-level)"
    parentCommentUuid: String
    "Comment body text (null if deleted)"
    body: String
    "Whether this comment has been deleted"
    isDeleted: Boolean!
    "Number of replies to this comment"
    replyCount: Int!
    "Number of upvotes"
    upvotes: Int!
    "Number of downvotes"
    downvotes: Int!
    "Net vote score (upvotes - downvotes)"
    voteScore: Int!
    "Current user's vote (-1, 0, or 1)"
    userVote: Int!
    "When the comment was created (ISO 8601)"
    createdAt: String!
    "When the comment was last updated (ISO 8601)"
    updatedAt: String!
  }

  """
  Paginated list of comments.
  """
  type CommentConnection {
    "List of comments"
    comments: [Comment!]!
    "Total number of matching comments"
    totalCount: Int!
    "Whether more comments are available"
    hasMore: Boolean!
    "Cursor for next page (used by globalCommentFeed)"
    cursor: String
  }

  """
  Vote summary for an entity.
  """
  type VoteSummary {
    "Entity type"
    entityType: SocialEntityType!
    "Entity ID"
    entityId: String!
    "Number of upvotes"
    upvotes: Int!
    "Number of downvotes"
    downvotes: Int!
    "Net vote score"
    voteScore: Int!
    "Current user's vote (-1, 0, or 1)"
    userVote: Int!
  }

  """
  Input for adding a comment.
  """
  input AddCommentInput {
    "Entity type to comment on"
    entityType: SocialEntityType!
    "Entity ID to comment on"
    entityId: String!
    "Parent comment UUID for replies"
    parentCommentUuid: String
    "Comment body text"
    body: String!
  }

  """
  Input for updating a comment.
  """
  input UpdateCommentInput {
    "UUID of the comment to update"
    commentUuid: ID!
    "New body text"
    body: String!
  }

  """
  Input for voting on an entity.
  """
  input VoteInput {
    "Entity type to vote on"
    entityType: SocialEntityType!
    "Entity ID to vote on"
    entityId: String!
    "Vote value (+1 or -1)"
    value: Int!
  }

  """
  Input for fetching comments.
  """
  input CommentsInput {
    "Entity type"
    entityType: SocialEntityType!
    "Entity ID"
    entityId: String!
    "Parent comment UUID to fetch replies for"
    parentCommentUuid: String
    "Sort mode"
    sortBy: SortMode
    "Time period filter"
    timePeriod: TimePeriod
    "Maximum number of comments to return"
    limit: Int
    "Number of comments to skip"
    offset: Int
  }

  """
  Input for fetching vote summaries in bulk.
  """
  input BulkVoteSummaryInput {
    "Entity type"
    entityType: SocialEntityType!
    "List of entity IDs"
    entityIds: [String!]!
  }

  """
  Input for follow/unfollow operations.
  """
  input FollowInput {
    "User ID to follow/unfollow"
    userId: ID!
  }

  """
  Input for listing followers or following.
  """
  input FollowListInput {
    "User ID whose followers/following to list"
    userId: ID!
    "Maximum number of users to return"
    limit: Int
    "Number of users to skip"
    offset: Int
  }

  """
  Input for searching users.
  """
  input SearchUsersInput {
    "Search query (min 2 characters)"
    query: String!
    "Optional board type filter"
    boardType: String
    "Maximum number of results"
    limit: Int
    "Number of results to skip"
    offset: Int
  }
`;
