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

    """
    Get viewer-specific session data for an Apple Health workout export.
    Requires authentication and returns only the requesting user's ticks.
    """
    sessionHealthExport(sessionId: ID!): SessionHealthExport

    """
    Lightweight, presence-independent lifecycle check for a session.
    Reads the durable session row (not live Redis presence), so it tells an
    ended session apart from one that is merely empty. Returns null when the
    session does not exist. Clients use this on cold start to decide whether
    to restore or drop a persisted session id.
    """
    sessionStatus(sessionId: ID!): SessionStatus

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
    Check whether MoonBoard climbs with exact hold-role selections already exist.
    Returns one result per submitted candidate.
    """
    checkMoonBoardClimbDuplicates(input: CheckMoonBoardClimbDuplicatesInput!): [MoonBoardClimbDuplicateMatch!]!

    """
    Find climbs on the same board+layout with at least \`threshold\` Jaccard
    similarity over hold positions (hold_id only, state-agnostic). Used by:
    - The playview drawer's "Similar climbs" section at threshold 0.5 —
      empirically the floor where matches feel related rather than
      coincidentally co-located on the wall.
    - The create-climb duplicate UX at threshold 1.0, which filters to
      true position-exact matches.
    The duplicate-publish gate uses state-aware (hold_id, hold_state)
    matching separately — see findExactDuplicateMatch.
    """
    similarClimbs(input: SimilarClimbsInput!): [SimilarClimb!]!

    """
    Get a single climb by its UUID.
    """
    climb(boardName: String!, layoutId: Int!, sizeId: Int!, setIds: String!, angle: Int!, climbUuid: ID!): Climb

    """
    Setter usernames with climb counts for the given board, optionally filtered by username substring.
    Powers the setter filter autocomplete.
    """
    setterStats(input: SetterStatsInput!): [SetterStat!]!

    """
    Get climb stats history for a climb over the last 12 months.
    Returns snapshots captured during shared sync for trend analysis.
    """
    climbStatsHistory(boardName: String!, climbUuid: ID!): [ClimbStatsHistoryEntry!]!

    """
    Get current per-angle statistics for a climb from the live stats table.
    Returns one entry for each angle the climb has been logged at.
    """
    climbStatsForAngles(boardName: String!, climbUuid: ID!): [ClimbStatsForAngle!]!

    """
    Get current per-angle statistics for 1-50 climbs in one primary-database
    read. Requires authentication. Duplicate UUIDs are folded before querying.
    """
    climbStatsForClimbs(boardName: String!, climbUuids: [ID!]!): [ClimbStatsForClimb!]!

    """
    Get the Boardsesh grade for a climb at a specific angle. When that angle
    has no ascents, the climb's other angles are projected onto it and the
    result comes back tiered cross_angle_estimate.
    Returns null when neither exists (e.g. MoonBoard, too few ascents, or fewer
    than two other ascent-backed angles to project from).
    """
    boardseshGrade(boardName: String!, climbUuid: String!, angle: Int!): BoardseshGrade

    """
    Get the Boardsesh grade for a climb at every angle, ordered by angle
    ascending: the computed grades, plus a cross_angle_estimate for each board
    angle nobody has climbed. Empty when the climb has no grades at all
    (e.g. MoonBoard, or too few ascents).
    """
    boardseshGradesForAngles(boardName: String!, climbUuid: String!): [BoardseshGradeForAngle!]!

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
    Per-board-type tick counts for a user, as a single grouped aggregate.
    Lets the home feed infer a default board without fetching every tick per
    board type (avoids one userTicks request per board on cold load).
    """
    userTickCountsByBoard(userId: ID!): [BoardTickCount!]!

    """
    Get public ascent activity feed for a user.
    Includes enriched climb data for display.
    """
    userAscentsFeed(userId: ID!, input: AscentFeedInput): AscentFeedResult!

    """
    Suggest the user's logged ascents that a shared reel caption is about, by
    matching the caption against their whole logbook's climb names. Returns full
    ascent rows (with board art) for the matched climbs, strongest match first.
    Powers the mobile share-beta picker.
    """
    userAscentCaptionMatches(userId: ID!, caption: String!): [AscentFeedItem!]!

    """
    Get public ascent feed grouped by climb and day.
    Useful for summary displays.
    """
    userGroupedAscentsFeed(userId: ID!, input: AscentFeedInput): GroupedAscentFeedResult!

    """
    Get profile statistics with distinct climb counts per grade.
    """
    userProfileStats(userId: ID!): ProfileStats!

    """
    Get a user's percentile ranking based on distinct climbs ascended.
    """
    userClimbPercentile(userId: ID!): UserClimbPercentile!

    # ============================================
    # Playlist Queries (require auth)
    # ============================================

    """
    Get current user's playlists for a board+layout.
    Requires authentication.
    """
    userPlaylists(input: GetUserPlaylistsInput!): [Playlist!]!

    """
    Get all current user's playlists across boards/layouts, paginated.
    Optional boardType/layoutId filter. Requires authentication.
    """
    allUserPlaylists(input: GetAllUserPlaylistsInput!): AllUserPlaylistsResult!

    """
    Get the authenticated user's pinned playlists, ordered by most recently pinned.
    Capped server-side (small grid surface). Requires authentication.
    """
    myPinnedPlaylists(input: GetMyPinnedPlaylistsInput!): [Playlist!]!

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

    """
    Get a smart (computed) playlist for a user — five-stars, most-repeated, or projects.
    Public — no authentication required.
    """
    smartPlaylist(input: GetSmartPlaylistInput!): SmartPlaylistResult!

    """
    Get climb counts for the current user's smart playlists.
    Used to render the smart-playlist cards on the library page.
    Requires authentication.
    """
    mySmartPlaylistCounts: [SmartPlaylistCount!]!

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
    Get all non-draft climbs created by a user.
    Includes both directly created climbs and Aurora-imported climbs linked via board credentials.
    """
    userClimbs(input: UserClimbsInput!): PlaylistClimbsResult!

    """
    Get activity feed of ascents from followed users.
    Requires authentication.
    Deprecated: Use activityFeed instead.
    """
    followingAscentsFeed(input: FollowingAscentsFeedInput): FollowingAscentsFeedResult!
      @deprecated(reason: "Use activityFeed query instead")

    """
    Get ticks from followed users for a specific climb.
    Requires authentication.
    """
    followingClimbAscents(input: FollowingClimbAscentsInput!): FollowingClimbAscentsResult!

    """
    Get global activity feed of all recent ascents.
    No authentication required.
    Deprecated: Use trendingFeed instead.
    """
    globalAscentsFeed(input: FollowingAscentsFeedInput): FollowingAscentsFeedResult!
      @deprecated(reason: "Use trendingFeed query instead")

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
    Groups ticks by explicitly-created sessions.
    """
    sessionGroupedFeed(input: ActivityFeedInput): SessionFeedResult!

    """
    Get full detail for a single explicitly-created session.
    """
    sessionDetail(sessionId: ID!): SessionDetail

    """
    Get a feed of newly created climbs for a board type and layout.
    """
    newClimbFeed(input: NewClimbFeedInput!): NewClimbFeedResult!

    """
    Backfill the recent "now on the wall" history for a board (last ~50, 1
    week window (BOARD_HISTORY_TTL)) from the Redis FIFO. Used by late joiners
    before the live \`boardNowPlaying\` subscription takes over.
    """
    boardRecentClimbs(boardId: Int!): [BoardPresenceClimb!]!

    """
    Durable history of what was pushed to a board (survives past the 1 week
    Redis window (BOARD_HISTORY_TTL)), newest-first by \`seq\`. For keyset
    paging pass the \`seq\` of the last item from the previous page as
    \`before\` (not \`sentAt\`) — \`seq\` is unique and monotonic per board, so
    paging never repeats or skips even when several sends share a \`sentAt\`
    second. A non-integer \`before\` is rejected with BAD_USER_INPUT. \`limit\`
    is capped at 100. This is the lasting "what was on the wall" record;
    \`boardRecentClimbs\` is the hot 1 week cache. Anonymous access is allowed
    for public and system-shared boards; private boards are masked as
    NOT_FOUND for anonymous callers.
    """
    boardHistory(boardId: Int!, limit: Int, before: String): [BoardPresenceClimb!]!

    """
    Lightweight stats for a board's wall feed — durable counts derived from
    \`boardsesh_ticks\` stamped with this board_id, plus the live window.
    Anonymous access is allowed for public and system-shared boards; private
    boards are masked as NOT_FOUND for anonymous callers.
    """
    boardPresenceStats(boardId: Int!): BoardPresenceStats!

    """
    The board's current connection holder — who's connected and writing right now
    (the most recent confirmed sender), or null when the board is free. For
    late-joiner initial state before the \`boardNowPlaying\` /
    \`BoardConnectionChanged\` stream warms up. Anonymous holders carry null
    user/name/avatar (clients render a "?").
    """
    boardConnection(boardId: Int!): BoardConnectionHolder

    """
    Redacted "Up next" snapshot of the party-session queue bound to a shared
    board, for anonymous public displays (gym kiosks). Auth-optional; for
    anonymous viewers a private board reads as NOT_FOUND (same existence
    hiding as \`boardNowPlaying\`).

    Double privacy gate — returns null unless BOTH hold:
    1. the board is anonymously readable (public / system-shared), and
    2. the bound session is \`isPublic: true\` and still active.

    Gate 2 deliberately widens \`board_sessions.is_public\` from "appears in
    discovery" to "queue observable on public displays" (documented product
    decision). Also null when no session is bound to the board. The bound
    session resolves from the live board→session binding stamped by
    \`reportBoardClimb\` (12h TTL), falling back to the newest active public
    \`board_sessions\` row for the board when the binding is absent or points
    at an ended session (a stale binding — bindings are never cleared on
    session end). A binding pointing at an ACTIVE private session returns
    null outright, never another session's queue. Items are redacted to
    climb-catalog fields only — never who added or ticked them.
    """
    boardQueuePreview(boardId: Int!): BoardQueuePreview

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
    Look up boards by controller serial numbers.
    Searches all boards (including unlisted/non-public).
    Capped at 20 serials per request — exceeding this throws a validation
    error rather than silently truncating, so callers must cap on their end.

    \`boardType\` is the type advertised in the BLE device name
    (\`Tension Board#12345@3\`). Aurora runs a separate serial sequence per board
    app, so the same serial exists on a Kilter and a Tension controller; pass it
    to keep the lookup on the hardware in front of the climber. Optional for
    backward compatibility with already-shipped clients.
    """
    boardsBySerialNumbers(serialNumbers: [String!]!, boardType: String): [UserBoard!]!

    """
    Recorded board configurations for the current user keyed by controller serial.
    Used as a fallback when boardsBySerialNumbers returns nothing for a serial,
    and to detect connect-time config mismatches. Requires authentication.
    """
    myBoardSerialConfigs(serialNumbers: [String!]!): [BoardSerialConfig!]!

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
    Get leaderboard for a board. Anonymous access is allowed for public and
    system-shared boards; private boards are masked as NOT_FOUND for anonymous
    callers. The 'day' period is a rolling last-24-hours window, not the
    calendar day so far (labelled "Today" for display, but not a UTC/local
    midnight boundary).
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
    Live gyms that resemble one the user is about to create, so they can view or
    claim an existing gym instead of making a duplicate. Authenticated + rate
    limited. Matches by exact normalized name within 5 km, any name within 150 m,
    or substring name similarity within 1 km; coordinates optional. Nearest first,
    capped at five.
    """
    findSimilarGyms(input: FindSimilarGymsInput!): [SimilarGym!]!

    """
    Get members of a gym.
    """
    gymMembers(input: GymMembersInput!): GymMemberConnection!

    """
    A gym's linked, non-deleted boards (user_boards.gym_id = gym.id), ordered by
    name. Auth-optional and viewer-scoped: viewers who can edit the gym (owner,
    gym admin/editor, or a covering community admin/leader) see every linked
    board; everyone else — including anonymous callers — sees only publicly
    listed boards (isPublic AND NOT isUnlisted, matching searchBoards' discovery
    convention: unlisted = link-only, never enumerated). Powers the manage-gym
    board pickers and the anonymous leaderboard embed. A missing gym, or a
    private gym seen by a non-editor, throws NOT_FOUND (existence is masked).
    Rate-limited.
    """
    gymBoards(gymUuid: ID!): [UserBoard!]!

    """
    Boards that probably belong to a gym but aren't linked to it yet, for the
    gym's Boards tab. Requires edit access to the gym. Returns two kinds of
    candidate: boards on a listing whose merged_into chain resolves to this gym
    (they should have followed the merge), and boards within ~150 m of the gym's
    location that are either unlinked or attached to a synced (SYSTEM) listing at
    the same spot. Merged-twin candidates first, then nearest. Capped at 25.
    """
    strayBoardsForGym(gymUuid: ID!): [StrayBoard!]!

    """
    List pending gym ownership claims for the admin review queue (admin only).
    """
    pendingGymClaims(input: PendingGymClaimsInput): GymClaimConnection!

    """
    List submitted app feedback (bug reports + ratings) for the admin feedback
    dashboard, enriched with the reporter's identity and triage state. Admin
    only. Supports filtering by type/status/platform and free-text search over
    the comment, with offset pagination.
    """
    adminAppFeedback(input: AdminAppFeedbackInput): AdminAppFeedbackResult!

    """
    Crowdsourced QA: the open pull requests among \`prNumbers\` (the tester's
    loadable \`pr-<n>\` OTA branches), each with its title, \`## Test plan\`
    steps, \`Risk: N/5\`, and the caller's latest verdict. Tester role required.
    Closed/unknown numbers are omitted; at most 50 per call.

    \`includeBuilding\` adds every open PR whose preview bundle is publishing
    right now. Those have no branch yet, so the caller cannot name them in
    \`prNumbers\` — the app shows them as an unloadable "building" row rather
    than leaving a tester who just pushed staring at an empty list.
    """
    qaPreviews(prNumbers: [Int!]!, includeBuilding: Boolean): [QaPreview!]!

    """
    A gym owner's activity snapshot: unique climbers, ascents, top climbs, and
    busiest weekdays for the current window plus the equally-long window before
    it (for week-over-week deltas). Requires gym edit access (owner, gym
    admin/editor, or a covering community admin/leader). Every aggregate is
    bounded to the gym's linked boards and the time window.
    """
    gymStats(input: GymStatsInput!): GymStats!

    """
    Candidate duplicate-gym clusters for the /admin/gym-duplicates review queue
    (admin only). Tiered by how tightly members sit together (A: within 20 m,
    B: within 150 m). Clusters an admin has dismissed are excluded. Paginated.
    """
    duplicateGymClusters(input: DuplicateGymClustersInput): DuplicateGymClusterConnection!

    """
    Alias-less, system-owned live gyms with no location-sync source — the orphan
    audit list (admin only). List-only; no bulk action.
    """
    orphanGyms(input: OrphanGymsInput): OrphanGymConnection!

    """
    Frozen gym or board rows awaiting an explicit location-sync release (global
    admin only). Includes soft-deleted rows because a later source sync may
    deliberately resurrect them. Merged gyms are excluded.
    """
    frozenLocationSyncEntities(input: FrozenLocationSyncEntitiesInput!): FrozenLocationSyncEntityConnection!

    """
    Resolve both halves of a proposed gym ownership handover — the gym and the
    incoming owner — so the confirm step can name them (global admin only).
    Read-only; nothing moves until reassignGymOwner is called.
    """
    gymOwnershipLookup(input: GymOwnershipLookupInput!): GymOwnershipLookupResult!

    """
    The traced hold silhouettes this backend ships for a board config, alongside
    the hand-drawn corrections that supersede them (admin only, scoped to the
    board). Read-only; the editor renders both and offers a revert.
    """
    holdOutlines(input: HoldOutlineConfigInput!): BoardHoldOutlines!

    # ============================================
    # Gym Kiosk Queries
    # ============================================

    """
    A gym's public kiosk (smart-TV wall dashboard) by gym slug, with an optional
    kiosk slug. Public read, rate-limited, no login: a public gym's kiosks are
    visible to anyone; a private gym's are visible only to a viewer who can edit
    it (everyone else gets null, indistinguishable from a missing gym/kiosk). When
    \`kioskSlug\` is omitted the gym's oldest live kiosk is returned as the default.
    Returns null when the gym or kiosk doesn't exist or isn't visible. The
    \`boards\` list is resolved in slot order with dead/hidden slots dropped; the
    \`layout\` JSON is read leniently (a corrupt stored layout degrades to empty).
    """
    gymKiosk(gymSlug: String!, kioskSlug: String): GymKiosk

    """
    All of a gym's live kiosks (oldest first) for the manage UI. Requires gym edit
    access (owner, gym admin/editor, or a covering community admin/leader).
    """
    gymKiosks(gymUuid: ID!): [GymKiosk!]!

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

    # ============================================
    # Beta Link Queries
    # ============================================

    """
    Get external (Instagram, TikTok) beta links for a climb.
    Live-checks each post and omits any that have been deleted or made private.
    Caches thumbnails to our S3 bucket on first read.
    """
    betaLinks(boardType: String!, climbUuid: String!): [BetaLink!]!

    """
    Most recent beta videos across all climbs. Returns only rows whose
    thumbnails are already cached in our S3; no live IG/TikTok enrichment.
    """
    recentBetaLinks(limit: Int = 20, boardType: String): [RecentBetaLink!]!

    """
    Beta videos contributed by a specific Boardsesh user, ordered
    most-recent-first. Matches both videos this user added directly and
    videos posted under the Instagram handle linked from their profile.
    Returns only rows whose thumbnails are cached in our S3.
    Paginate with offset (the page size is limit); the caller infers
    "has more" from a full page coming back.
    """
    userBetaLinks(userId: String!, limit: Int = 50, offset: Int = 0): [RecentBetaLink!]!

    """
    Resolve scraped Instagram posts against Boardsesh: which beta videos are
    missing, already linked, ambiguous, or unmatched. Read-only — the client
    attaches the missing ones via the attachBetaLink mutation.
    """
    instagramBetaScan(input: InstagramBetaScanInput!): InstagramBetaScanResult!

    """
    Live preview metadata for a shared Instagram/TikTok URL, before it's
    attached. Powers the mobile share flow: shows the post thumbnail/caption and
    lets the client auto-match the climb from the caption. Best-effort — returns
    null fields rather than throwing when the post is unavailable.
    """
    betaLinkPreview(link: String!): BetaLinkPreview!

    """
    Connection state of every supported external platform integration for the
    current user, including never-connected providers (connected: false).
    Requires authentication.
    """
    integrations: [IntegrationStatus!]!

    # ============================================
    # Offline Sync Pull Queries (Phase 2, require auth)
    # ============================================
    #
    # Incremental pull with a composite (updatedAt, syncSeq) cursor. Each returns
    # snake_case JSON documents (keys = mobile local columns). User-data queries
    # are scoped to the authenticated user; board-data queries are scoped by
    # boardType. See docs/sync-table-manifest.md.

    "Pull the authenticated user's ticks changed since the cursor."
    syncTicks(cursor: SyncCursorInput, limit: Int! = 500): SyncResult!

    "Pull the authenticated user's owned playlists changed since the cursor."
    syncPlaylists(cursor: SyncCursorInput, limit: Int! = 500): SyncResult!

    "Pull playlist-climb rows for the user's owned playlists, changed since the cursor."
    syncPlaylistClimbs(cursor: SyncCursorInput, limit: Int! = 500): SyncResult!

    "Pull the authenticated user's favorites changed since the cursor."
    syncFavorites(cursor: SyncCursorInput, limit: Int! = 500): SyncResult!

    "Pull the authenticated user's user-follows changed since the cursor."
    syncUserFollows(cursor: SyncCursorInput, limit: Int! = 500): SyncResult!

    "Pull the authenticated user's setter-follows changed since the cursor."
    syncSetterFollows(cursor: SyncCursorInput, limit: Int! = 500): SyncResult!

    "Pull the authenticated user's playlist-follows changed since the cursor."
    syncPlaylistFollows(cursor: SyncCursorInput, limit: Int! = 500): SyncResult!

    """
    Pull board climbs for a board type, changed since the cursor (reference data).
    Optional layoutId/sizeId narrow the pull to a single layout/size (all sets) so a
    downloaded board stays a fixed, cacheable superset. sizeId is ignored for moonboard.
    """
    syncClimbs(boardType: String!, layoutId: Int, sizeId: Int, cursor: SyncCursorInput, limit: Int! = 500): SyncResult!

    """
    Pull board climb stats for a board type, changed since the cursor (reference data).
    Optional layoutId/sizeId scope stats to the climbs of that layout/size via board_climbs.
    """
    syncClimbStats(
      boardType: String!
      layoutId: Int
      sizeId: Int
      cursor: SyncCursorInput
      limit: Int! = 500
    ): SyncResult!

    """
    Pull Boardsesh grades for a board type, changed since the cursor (reference data).
    Optional layoutId/sizeId scope grades to the climbs of that layout/size via board_climbs.
    """
    syncClimbGrades(
      boardType: String!
      layoutId: Int
      sizeId: Int
      cursor: SyncCursorInput
      limit: Int! = 500
    ): SyncResult!

    "Pull hard deletions (user-scoped + reference data) since the cursor."
    syncDeletions(cursor: SyncCursorInput, limit: Int! = 500): SyncDeletionsResult!
  }
`;
