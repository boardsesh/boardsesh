export const queriesTypeDefs = /* GraphQL */ `
  """
  Root query type for all read operations.
  """
  type Query {
    """
    Get details of a specific session by ID.
    Returns null if session doesn't exist.
    """
    session(sessionId: ID!): Session

    """
    Get buffered events since a sequence number for delta sync.
    Used to catch up after reconnection without full state transfer.
    """
    eventsReplay(sessionId: ID!, sinceSequence: Int!): EventsReplayResponse!

    """
    Find discoverable sessions near a GPS location.
    Default radius is 1000 meters.
    """
    nearbySessions(latitude: Float!, longitude: Float!, radiusMeters: Float): [DiscoverableSession!]!

    """
    Get current user's recently joined sessions.
    Requires authentication.
    """
    mySessions: [DiscoverableSession!]!

    """
    Get a session summary (stats, grade distribution, participants).
    Available for ended sessions or active sessions with ticks.
    """
    sessionSummary(sessionId: ID!): SessionSummary

    # ============================================
    # Board Configuration Queries
    # ============================================

    """
    Get all difficulty grades for a board type.
    """
    grades(boardName: String!): [Grade!]!

    """
    Get available angles for a board layout.
    """
    angles(boardName: String!, layoutId: Int!): [Angle!]!

    # ============================================
    # Climb Queries
    # ============================================

    """
    Search climbs with filtering, sorting, and pagination.
    Supports filtering by difficulty, setter, holds, and more.
    """
    searchClimbs(input: ClimbSearchInput!): ClimbSearchResult!

    """
    Get a single climb by its UUID.
    """
    climb(
      boardName: String!
      layoutId: Int!
      sizeId: Int!
      setIds: String!
      angle: Int!
      climbUuid: ID!
    ): Climb

    """
    Get climb stats history for a climb over the last 12 months.
    Returns snapshots captured during shared sync for trend analysis.
    """
    climbStatsHistory(boardName: String!, climbUuid: ID!): [ClimbStatsHistoryEntry!]!

    # ============================================
    # User Management Queries (require auth)
    # ============================================

    """
    Get the currently authenticated user's profile.
    Returns null if not authenticated.
    """
    profile: UserProfile

    """
    Get info needed before account deletion (published climb count).
    Requires authentication.
    """
    deleteAccountInfo: DeleteAccountInfo!

    """
    Get status of all stored Aurora credentials.
    Requires authentication.
    """
    auroraCredentials: [AuroraCredentialStatus!]!

    """
    Get Aurora credential for a specific board type.
    Includes token if available. Requires authentication.
    """
    auroraCredential(boardType: String!): AuroraCredential

    # ============================================
    # Favorites Queries
    # ============================================

    """
    Check which climbs from a list are favorited by the current user.
    Returns array of favorited climb UUIDs.
    """
    favorites(boardName: String!, climbUuids: [String!]!, angle: Int!): [String!]!

    """
    Get count of favorited climbs per board for the current user.
    Requires authentication.
    """
    userFavoritesCounts: [FavoritesCount!]!

    """
    Get board names where the current user has playlists or favorites.
    Requires authentication.
    """
    userActiveBoards: [String!]!

    """
    Get user's favorite climbs with full climb data.
    Requires authentication.
    """
    userFavoriteClimbs(input: GetUserFavoriteClimbsInput!): PlaylistClimbsResult!

    # ============================================
    # Ticks Queries (require auth)
    # ============================================

    """
    Get current user's ticks (recorded climb attempts).
    Requires authentication.
    """
    ticks(input: GetTicksInput!): [Tick!]!

    """
    Get public ticks for any user by their ID.
    """
    userTicks(userId: ID!, boardType: String!): [Tick!]!

    """
    Get public ascent activity feed for a user.
    Includes enriched climb data for display.
    """
    userAscentsFeed(userId: ID!, input: AscentFeedInput): AscentFeedResult!

    """
    Get public ascent feed grouped by climb and day.
    Useful for summary displays.
    """
    userGroupedAscentsFeed(userId: ID!, input: AscentFeedInput): GroupedAscentFeedResult!

    """
    Get profile statistics with distinct climb counts per grade.
    """
    userProfileStats(userId: ID!): ProfileStats!

    # ============================================
    # Playlist Queries (require auth)
    # ============================================

    """
    Get current user's playlists for a board+layout.
    Requires authentication.
    """
    userPlaylists(input: GetUserPlaylistsInput!): [Playlist!]!

    """
    Get all current user's playlists across boards/layouts.
    Optional boardType filter. Requires authentication.
    """
    allUserPlaylists(input: GetAllUserPlaylistsInput!): [Playlist!]!

    """
    Get a specific playlist by ID.
    Checks ownership/access permissions.
    """
    playlist(playlistId: ID!): Playlist

    """
    Get IDs of playlists that contain a specific climb.
    """
    playlistsForClimb(input: GetPlaylistsForClimbInput!): [ID!]!

    """
    Get playlist memberships for multiple climbs in a single request.
    """
    playlistsForClimbs(input: GetPlaylistsForClimbsInput!): [ClimbPlaylistMembership!]!

    """
    Get climbs in a playlist with full climb data.
    """
    playlistClimbs(input: GetPlaylistClimbsInput!): PlaylistClimbsResult!

    # ============================================
    # Playlist Discovery Queries (no auth required)
    # ============================================

    """
    Discover public playlists with at least 1 climb.
    """
    discoverPlaylists(input: DiscoverPlaylistsInput!): DiscoverPlaylistsResult!

    """
    Search public playlists globally by name.
    """
    searchPlaylists(input: SearchPlaylistsInput!): SearchPlaylistsResult!

    """
    Get playlist creators for autocomplete suggestions.
    """
    playlistCreators(input: GetPlaylistCreatorsInput!): [PlaylistCreator!]!

    # ============================================
    # ESP32 Controller Queries (require auth)
    # ============================================

    # Get current user's registered controllers
    myControllers: [ControllerInfo!]!

    # ============================================
    # Social / Follow Queries
    # ============================================

    """
    Get followers of a user.
    """
    followers(input: FollowListInput!): FollowConnection!

    """
    Get users that a user is following.
    """
    following(input: FollowListInput!): FollowConnection!

    """
    Check if the current user follows a specific user.
    Requires authentication.
    """
    isFollowing(userId: ID!): Boolean!

    """
    Get a public user profile by ID.
    """
    publicProfile(userId: ID!): PublicUserProfile

    """
    Search for users by name or email.
    """
    searchUsers(input: SearchUsersInput!): UserSearchConnection!

    """
    Search for users and setters by name.
    Returns unified results with both Boardsesh users and climb setters.
    """
    searchUsersAndSetters(input: SearchUsersInput!): UnifiedSearchConnection!

    """
    Get a setter profile by username.
    """
    setterProfile(input: SetterProfileInput!): SetterProfile

    """
    Get climbs created by a setter.
    """
    setterClimbs(input: SetterClimbsInput!): SetterClimbsConnection!

    """
    Get climbs created by a setter with full Climb data (for thumbnails).
    Supports multi-board mode when boardType is omitted.
    """
    setterClimbsFull(input: SetterClimbsFullInput!): PlaylistClimbsResult!

    """
    Get activity feed of ascents from followed users.
    Requires authentication.
    Deprecated: Use activityFeed instead.
    """
    followingAscentsFeed(input: FollowingAscentsFeedInput): FollowingAscentsFeedResult! @deprecated(reason: "Use activityFeed query instead")

    """
    Get global activity feed of all recent ascents.
    No authentication required.
    Deprecated: Use trendingFeed instead.
    """
    globalAscentsFeed(input: FollowingAscentsFeedInput): FollowingAscentsFeedResult! @deprecated(reason: "Use trendingFeed query instead")

    """
    Get materialized activity feed for the authenticated user.
    Requires authentication.
    """
    activityFeed(input: ActivityFeedInput): ActivityFeedResult!

    """
    Get trending feed of recent activity (public, no auth required).
    """
    trendingFeed(input: ActivityFeedInput): ActivityFeedResult!

    """
    Get session-grouped activity feed (public, no auth required).
    Groups ticks into sessions (party mode or inferred by 4-hour gap).
    """
    sessionGroupedFeed(input: ActivityFeedInput): SessionFeedResult!

    """
    Get full detail for a single session (party mode or inferred).
    """
    sessionDetail(sessionId: ID!): SessionDetail

    """
    Get a feed of newly created climbs for a board type and layout.
    """
    newClimbFeed(input: NewClimbFeedInput!): NewClimbFeedResult!

    """
    Get the current user's new climb subscriptions.
    Requires authentication.
    """
    myNewClimbSubscriptions: [NewClimbSubscription!]!

    # ============================================
    # Board Entity Queries
    # ============================================

    """
    Get a board by UUID.
    """
    board(boardUuid: ID!): UserBoard

    """
    Get a board by slug (for URL routing).
    """
    boardBySlug(slug: String!): UserBoard

    """
    Get current user's boards.
    Requires authentication.
    """
    myBoards(input: MyBoardsInput): UserBoardConnection!

    """
    Search public boards.
    """
    searchBoards(input: SearchBoardsInput!): UserBoardConnection!

    """
    Get popular board configurations ranked by climb count.
    """
    popularBoardConfigs(input: PopularBoardConfigsInput): PopularBoardConfigConnection!

    """
    Get leaderboard for a board.
    """
    boardLeaderboard(input: BoardLeaderboardInput!): BoardLeaderboard!

    """
    Get the user's default board (first owned, then most used).
    Requires authentication.
    """
    defaultBoard: UserBoard

    # ============================================
    # Gym Entity Queries
    # ============================================

    """
    Get a gym by UUID.
    """
    gym(gymUuid: ID!): Gym

    """
    Get a gym by slug (for URL routing).
    """
    gymBySlug(slug: String!): Gym

    """
    Get current user's gyms (owned + optionally followed).
    Requires authentication.
    """
    myGyms(input: MyGymsInput): GymConnection!

    """
    Search public gyms.
    """
    searchGyms(input: SearchGymsInput!): GymConnection!

    """
    Get members of a gym.
    """
    gymMembers(input: GymMembersInput!): GymMemberConnection!

    # ============================================
    # Notification Queries (require auth)
    # ============================================

    """
    Get notifications for the current user.
    """
    notifications(unreadOnly: Boolean, limit: Int, offset: Int): NotificationConnection!

    """
    Get grouped notifications for the current user.
    Groups notifications by (type, entity_type, entity_id).
    """
    groupedNotifications(limit: Int, offset: Int): GroupedNotificationConnection!

    """
    Get unread notification count for the current user.
    """
    unreadNotificationCount: Int!

    # ============================================
    # Community Proposals Queries
    # ============================================

    """
    Get proposals for a specific climb.
    """
    climbProposals(input: GetClimbProposalsInput!): ProposalConnection!

    """
    Browse proposals across all climbs with filters.
    """
    browseProposals(input: BrowseProposalsInput!): ProposalConnection!

    """
    Get community status for a specific climb at an angle.
    """
    climbCommunityStatus(climbUuid: String!, boardType: String!, angle: Int!): ClimbCommunityStatus!

    """
    Get community status for multiple climbs (batch).
    """
    bulkClimbCommunityStatus(climbUuids: [String!]!, boardType: String!, angle: Int!): [ClimbCommunityStatus!]!

    """
    Get classic status for a climb (angle-independent).
    """
    climbClassicStatus(climbUuid: String!, boardType: String!): ClimbClassicStatus!

    """
    Get community settings for a scope.
    """
    communitySettings(scope: String!, scopeKey: String!): [CommunitySetting!]!

    """
    Get all community role assignments.
    """
    communityRoles(boardType: String): [CommunityRoleAssignment!]!

    """
    Get the current user's community roles.
    """
    myRoles: [CommunityRoleAssignment!]!

    # ============================================
    # Comments & Votes Queries
    # ============================================

    """
    Get comments for an entity.
    """
    comments(input: CommentsInput!): CommentConnection!

    """
    Get a global feed of recent comments across all entities.
    Supports board filtering. Always chronological (newest first).
    """
    globalCommentFeed(input: GlobalCommentFeedInput): CommentConnection!

    """
    Get vote summary for a single entity.
    """
    voteSummary(entityType: SocialEntityType!, entityId: String!): VoteSummary!

    """
    Get vote summaries for multiple entities of the same type.
    """
    bulkVoteSummaries(input: BulkVoteSummaryInput!): [VoteSummary!]!
  }
`;
