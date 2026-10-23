export const playlistsTypeDefs = /* GraphQL */ `
  # ============================================
  # Playlist Types
  # ============================================

  """
  A user-created collection of climbs.
  """
  type Playlist {
    "Database ID"
    id: ID!
    "Unique identifier"
    uuid: ID!
    "Board type"
    boardType: String!
    "Layout ID (null for Aurora-synced circuits)"
    layoutId: Int
    "Playlist name"
    name: String!
    "Optional description"
    description: String
    "Whether publicly visible"
    isPublic: Boolean!
    "Display color"
    color: String
    "Display icon"
    icon: String
    "When created (ISO 8601)"
    createdAt: String!
    "When last updated (ISO 8601)"
    updatedAt: String!
    "When last accessed/viewed (ISO 8601)"
    lastAccessedAt: String
    "Number of climbs in playlist"
    climbCount: Int!
    "Current user's role (owner/editor/viewer)"
    userRole: String
    "Number of users following this playlist"
    followerCount: Int!
    "Whether the current user follows this playlist"
    isFollowedByMe: Boolean!
    "Whether the current user has pinned this playlist (false when unauthenticated)"
    isPinnedByMe: Boolean!
  }

  """
  Count of favorited climbs per board.
  """
  type FavoritesCount {
    "Board name"
    boardName: String!
    "Number of favorited climbs"
    count: Int!
  }

  """
  A climb within a playlist.
  """
  type PlaylistClimb {
    "Database ID"
    id: ID!
    "Playlist ID"
    playlistId: ID!
    "UUID of the climb"
    climbUuid: String!
    "Board angle (null for Aurora circuits)"
    angle: Int
    "Position in playlist"
    position: Int!
    "When added (ISO 8601)"
    addedAt: String!
    """
    Populated only by addClimbToPlaylist: true when the climb was already in the
    playlist and the add was an idempotent no-op, false when this call inserted
    the row. Null everywhere else (list/detail reads never set it). Clients read
    it to skip the optimistic climb-count bump on a duplicate add.
    """
    wasAlreadyInPlaylist: Boolean
  }

  """
  Input for creating a playlist.
  """
  input CreatePlaylistInput {
    privacy: PrivacyPublicationInput
    "Optional client-generated UUID for offline idempotent replay"
    uuid: ID
    "Board type"
    boardType: String!
    "Layout ID"
    layoutId: Int!
    "Playlist name"
    name: String!
    "Optional description"
    description: String
    "Display color"
    color: String
    "Display icon"
    icon: String
  }

  """
  Input for updating a playlist.
  """
  input UpdatePlaylistInput {
    privacy: PrivacyPublicationInput
    "Playlist ID to update"
    playlistId: ID!
    "New name"
    name: String
    "New description"
    description: String
    "New visibility setting"
    isPublic: Boolean
    "New color"
    color: String
    "New icon"
    icon: String
  }

  """
  Input for adding a climb to a playlist.
  """
  input AddClimbToPlaylistInput {
    "Target playlist ID"
    playlistId: ID!
    "Climb UUID to add"
    climbUuid: String!
    "Board angle for this entry"
    angle: Int!
  }

  """
  Input for removing a climb from a playlist.
  """
  input RemoveClimbFromPlaylistInput {
    "Playlist ID"
    playlistId: ID!
    "Climb UUID to remove"
    climbUuid: String!
  }

  """
  Input for reordering a climb within a playlist (single move).
  """
  input ReorderPlaylistClimbInput {
    "Playlist ID"
    playlistId: ID!
    "Climb UUID to move"
    climbUuid: String!
    "Target 0-based index in the playlist's full ordered list"
    newIndex: Int!
  }

  """
  Input for getting user's playlists.
  """
  input GetUserPlaylistsInput {
    "Filter by board type"
    boardType: String!
    "Filter by layout ID"
    layoutId: Int!
  }

  """
  Input for getting all user's playlists across boards.
  """
  input GetAllUserPlaylistsInput {
    "Optional filter by board type"
    boardType: String
    "Optional filter by layout ID (includes playlists with null layoutId)"
    layoutId: Int
    "Page number (0-indexed)"
    page: Int
    "Page size"
    pageSize: Int
  }

  """
  Result of fetching the authenticated user's playlists, paginated.
  """
  type AllUserPlaylistsResult {
    "List of playlists"
    playlists: [Playlist!]!
    "Total count across all pages"
    totalCount: Int!
    "Whether more are available"
    hasMore: Boolean!
  }

  """
  Input for pinning/unpinning a playlist.
  """
  input PinPlaylistInput {
    "The playlist UUID"
    playlistUuid: ID!
  }

  """
  Input for getting the authenticated user's pinned playlists.
  """
  input GetMyPinnedPlaylistsInput {
    "Optional filter by board type"
    boardType: String
    "Optional filter by layout ID (includes playlists with null layoutId)"
    layoutId: Int
  }

  """
  Input for getting playlists containing a climb.
  """
  input GetPlaylistsForClimbInput {
    "Board type"
    boardType: String!
    "Layout ID"
    layoutId: Int!
    "Climb UUID to search for"
    climbUuid: String!
  }

  """
  Input for getting playlists containing multiple climbs (batch).
  """
  input GetPlaylistsForClimbsInput {
    "Board type"
    boardType: String!
    "Layout ID"
    layoutId: Int!
    "Climb UUIDs to search for"
    climbUuids: [String!]!
  }

  """
  Playlist membership for a single climb in a batch query.
  """
  type ClimbPlaylistMembership {
    "Climb UUID"
    climbUuid: String!
    "UUIDs of playlists containing this climb"
    playlistUuids: [ID!]!
  }

  """
  How a playlist's climbs are ordered.
  position is the playlist's own order (the default), added is when each climb
  was added to the playlist. The others rank on the grade, quality and ascents
  each row displays, or shuffle with a seed.
  """
  enum PlaylistClimbSort {
    position
    added
    difficulty
    quality
    ascents
    name
    random
  }

  """
  Sort and filters for a playlist's climbs: the Climbs list's filters, applied to
  the playlist's own climbs. Every filter narrows the playlist and never adds a
  climb to it.

  Grade, quality, ascents and benchmark filters (and the matching sorts) read
  each row's stats at the angle the row displays: on the active board's type the
  wall angle, elsewhere the angle the climb was added at, and in both cases the
  most-ascended angle when the climb has no stats at that one.

  The personal and board-shaped filters (progress, your rating, liked, followed
  authors, beta videos, tall, wide, holds, zone and onlyActiveBoard) only pass
  climbs on the active board: the specific board in specific-board mode, the
  active* fields in all-boards mode. They need its board type, layout and angle;
  without them they match nothing.
  """
  input PlaylistClimbViewInput {
    "Order of the climbs. Omitted means position (the playlist's own order)."
    sortBy: PlaylistClimbSort
    "Sort direction ('asc' or 'desc'). Omitted means the sort's natural direction: asc for position, difficulty and name, desc for added, quality and ascents."
    sortOrder: String
    "Seed for the 'random' sort; keeps OFFSET pagination stable across pages for one shuffle"
    sortSeed: String
    "Filter by climb name (partial match)"
    name: String
    "Minimum difficulty grade ID"
    minGrade: Int
    "Maximum difficulty grade ID"
    maxGrade: Int
    "Grade accuracy filter (maximum gap between the displayed grade and the average grade)"
    gradeAccuracy: String
    "Which grade minGrade and maxGrade (and the difficulty sort) read. Omitted means UPSTREAM."
    gradeSource: ClimbGradeSource
    "Key the grade filter and the difficulty sort off the climber's own grade on the active board, falling back to the crowd's grade elsewhere. (requires auth)"
    useMyGrades: Boolean
    "Minimum number of ascents"
    minAscents: Int
    "Minimum quality rating"
    minRating: Float
    "Only show benchmark climbs"
    onlyBenchmarks: Boolean
    "Filter by setter usernames"
    setter: [String!]
    "Only climbs by followed setters or followed users, on the active board. (requires auth)"
    onlyFollowedAuthors: Boolean
    "Only climbs on the active board that need its full height"
    onlyTallClimbs: Boolean
    "Only climbs on the active board that need its full width"
    onlyWideClimbs: Boolean
    "Only climbs on the active board that have a beta video"
    onlyWithBetaVideos: Boolean
    "Include single-frame climbs (boulders). Omitting both boulders and routes matches all climb types."
    boulders: Boolean
    "Include multi-frame climbs (routes). Omitting both boulders and routes matches all climb types."
    routes: Boolean
    "Only climbs with no ascents at the displayed angle"
    projectsOnly: Boolean
    "Hide climbs the user has attempted on the active board (requires auth)"
    hideAttempted: Boolean
    "Hide climbs the user has completed on the active board (requires auth)"
    hideCompleted: Boolean
    "Only climbs the user has attempted on the active board (requires auth)"
    showOnlyAttempted: Boolean
    "Only climbs the user has completed on the active board (requires auth)"
    showOnlyCompleted: Boolean
    "Hide climbs whose latest rating from the user, at the active angle, is below this many stars. 0 means no minimum. (requires auth)"
    minUserRating: Int
    "Only climbs the user has rated at the active angle (requires auth)"
    onlyRatedByMe: Boolean
    "Only climbs the user has hearted on the active board (requires auth)"
    onlyFavorited: Boolean
    "Hold filter object: { holdId: { STATE: 'include' | 'exclude' } }, matched on the active board"
    holdsFilter: JSON
    "Restrict to climbs on the active board inside this drawn zone"
    zoneBox: ZoneBoxInput
    "How the zone should match climb holds. Defaults to allHolds when omitted."
    zoneMode: ZoneMatchMode
    "Only climbs that fit the active board: its board type, layout, size and hold sets"
    onlyActiveBoard: Boolean
  }

  """
  Input for getting climbs in a playlist with full data.
  """
  input GetPlaylistClimbsInput {
    "Playlist ID"
    playlistId: ID!
    "Board name for climb lookup (omit for all-boards mode)"
    boardName: String
    "Layout ID"
    layoutId: Int
    "Size ID"
    sizeId: Int
    "Set IDs"
    setIds: String
    "Board angle"
    angle: Int
    "Active board type for grade rendering in all-boards mode (omit in specific-board mode). On-board climbs render their grade at activeAngle."
    activeBoardName: String
    "Selected wall angle to render grades at for on-active-board climbs in all-boards mode"
    activeAngle: Int
    "Active board layout in all-boards mode. Needs activeBoardName. Used by the view's active-board filters."
    activeLayoutId: Int
    "Active board size in all-boards mode. Needs activeBoardName. Used by the view's active-board filters."
    activeSizeId: Int
    "Active board's comma-separated set IDs in all-boards mode. Needs activeBoardName. Used by the view's active-board filters."
    activeSetIds: String
    "Sort and filters. Omitted means the playlist's own order with no filter."
    view: PlaylistClimbViewInput
    "Page number"
    page: Int
    "Page size"
    pageSize: Int
  }

  """
  Result of fetching playlist climbs.
  """
  type PlaylistClimbsResult {
    "List of climbs with full data"
    climbs: [Climb!]!
    "Total number of climbs matching the supplied board, layout, size, and hold-set scope and the view's filters, before pagination"
    totalCount: Int!
    "Climbs the playlist shows in this board scope with no view filter applied. Null unless the view carries a filter (a sort alone leaves it null)."
    unfilteredCount: Int
    "Whether more are available"
    hasMore: Boolean!
  }

  """
  A user who has created public playlists.
  """
  type PlaylistCreator {
    "User ID"
    userId: ID!
    "Display name"
    displayName: String!
    "Number of public playlists"
    playlistCount: Int!
  }

  """
  A public playlist with creator information.
  """
  type DiscoverablePlaylist {
    "Database ID"
    id: ID!
    "Unique identifier"
    uuid: ID!
    "Board type"
    boardType: String!
    "Layout ID"
    layoutId: Int
    "Playlist name"
    name: String!
    "Description"
    description: String
    "Display color"
    color: String
    "Display icon"
    icon: String
    "When created"
    createdAt: String!
    "When last updated"
    updatedAt: String!
    "Number of climbs"
    climbCount: Int!
    "Creator's user ID"
    creatorId: ID!
    "Creator's display name"
    creatorName: String!
    "Whether this is a system-generated recommendation playlist"
    isGeneratedRecommendation: Boolean!
    "Grade spread of the playlist's climbs. Null when none of its climbs has a grade yet."
    gradeSummary: PlaylistGradeSummary
  }

  """
  The grade spread of a playlist's climbs. Every value is a difficulty id on the
  playlist board's grade scale (the same ids SearchClimbs' minGrade/maxGrade take),
  from ROUND(display_difficulty) at each climb's playlist angle. A climb saved
  without an angle (synced circuits) is graded at its most-repeated angle.
  Refreshed when climbs are added or removed, and daily for grade drift.
  """
  type PlaylistGradeSummary {
    "Climbs that have a grade; the values below cover only these"
    gradedClimbCount: Int!
    "Easiest graded climb"
    minDifficulty: Int!
    "10th percentile: the low end of the band cards show and the grade filter checks"
    p10Difficulty: Int!
    "Median grade"
    medianDifficulty: Int!
    "90th percentile: the high end of the band cards show and the grade filter checks"
    p90Difficulty: Int!
    "Hardest graded climb"
    maxDifficulty: Int!
  }

  """
  Input for discovering public playlists.
  """
  input DiscoverPlaylistsInput {
    "Board type (optional — omit to discover across all boards)"
    boardType: String
    "Layout ID (optional — omit to discover across all layouts)"
    layoutId: Int
    "Board size ID for generated recommendation filters"
    sizeId: Int
    "Board angle for generated recommendation filters"
    angle: Int
    "Filter by name (partial match)"
    name: String
    "Filter by creator IDs"
    creatorIds: [ID!]
    "Exclude these creators. The viewer's own playlists, for a discovery surface."
    excludeCreatorIds: [ID!]
    "Only playlists with at least this many climbs"
    minClimbs: Int
    "Only playlists with at most this many climbs. A 600-climb list is an export, not a playlist."
    maxClimbs: Int
    "Filter by generated recommendation status"
    generatedRecommendation: Boolean
    """
    Only playlists whose grade band starts at or above this difficulty id: the
    10th-percentile grade is >= minGrade, so one easy warm-up does not let a hard
    list in. A playlist with no graded climb is left out whenever a grade bound is set.
    """
    minGrade: Int
    """
    Only playlists whose grade band ends at or below this difficulty id: the
    90th-percentile grade is <= maxGrade, so one outlier V10 does not keep a V3
    list out of a V3-V5 search.
    """
    maxGrade: Int
    """
    Only playlists by climbers the signed-in viewer follows. Resolved on the server
    from the viewer's follows. Signed out, the result is empty.
    """
    followedOnly: Boolean
    "Sort by: 'recent' (default) or 'popular' (climbers who pinned or followed it, then size)"
    sortBy: String
    "Page number"
    page: Int
    "Page size"
    pageSize: Int
  }

  """
  Result of playlist discovery.
  """
  type DiscoverPlaylistsResult {
    "List of playlists"
    playlists: [DiscoverablePlaylist!]!
    "Total count"
    totalCount: Int!
    "Whether more are available"
    hasMore: Boolean!
  }

  """
  Input for searching playlists globally.
  """
  input SearchPlaylistsInput {
    "Search query"
    query: String!
    "Optional board type filter"
    boardType: String
    "Max results to return"
    limit: Int
    "Offset for pagination"
    offset: Int
  }

  """
  Result of global playlist search.
  """
  type SearchPlaylistsResult {
    "List of playlists"
    playlists: [DiscoverablePlaylist!]!
    "Total count"
    totalCount: Int!
    "Whether more are available"
    hasMore: Boolean!
  }

  """
  Input for getting playlist creators.
  """
  input GetPlaylistCreatorsInput {
    "Board type"
    boardType: String!
    "Layout ID"
    layoutId: Int!
    "Search query for autocomplete"
    searchQuery: String
  }

  """
  Input for getting user's favorite climbs with full data.
  """
  input GetUserFavoriteClimbsInput {
    "Board type"
    boardName: String!
    "Layout ID"
    layoutId: Int!
    "Size ID"
    sizeId: Int!
    "Set IDs"
    setIds: String!
    "Board angle"
    angle: Int!
    "Page number"
    page: Int
    "Page size"
    pageSize: Int
  }

  # ============================================
  # Smart (computed) Playlist Types
  # ============================================

  """
  A computed playlist generated from a user's logbook or favourites, or a
  recommendation computed from the catalog for the user's board.

  Logbook-derived:
  - FIVE_STARS: climbs the user has rated 5/5
  - MOST_REPEATED: climbs the user has logged the most attempts on
  - PROJECTS: climbs with the most attempts that have never been sent
  - LIKED_CLIMBS: climbs the user has favourited

  Recommendations (ranked within climbs that fit the user's biggest board,
  excluding ones they've already sent):
  - RECOMMENDED_CROWD_FAVORITES: proven classics for the board (ascents × rating)
  - RECOMMENDED_HIDDEN_GEMS: highly rated but low-ascent climbs
  - RECOMMENDED_AT_LEVEL: climbs near the user's grade band
  - RECOMMENDED_FRESH: recently set climbs, weighted toward popular setters
  """
  enum SmartPlaylistType {
    FIVE_STARS
    MOST_REPEATED
    PROJECTS
    LIKED_CLIMBS
    RECOMMENDED_CROWD_FAVORITES
    RECOMMENDED_HIDDEN_GEMS
    RECOMMENDED_AT_LEVEL
    RECOMMENDED_FRESH
  }

  """
  Metadata about a smart playlist (the user it belongs to + counts).
  """
  type SmartPlaylistMeta {
    "Smart playlist type"
    type: SmartPlaylistType!
    "User the playlist was generated for"
    userId: ID!
    "Display name of the user"
    userName: String!
    "Avatar URL of the user (or null)"
    userAvatar: String
    "Total number of climbs in the playlist"
    climbCount: Int!
  }

  """
  Result of a smart playlist query.
  """
  type SmartPlaylistResult {
    "Playlist metadata"
    meta: SmartPlaylistMeta!
    "Page of climbs with full data"
    climbs: [Climb!]!
    "Total number of climbs (matches meta.climbCount)"
    totalCount: Int!
    "Whether more pages are available"
    hasMore: Boolean!
  }

  """
  Input for fetching a smart playlist.
  """
  input GetSmartPlaylistInput {
    "Smart playlist type"
    type: SmartPlaylistType!
    "User whose logbook (or board) to compute from"
    userId: ID!
    "Filter to a board type (optional)"
    boardName: String
    "Recommendation: the specific owned board (uuid) to recommend for"
    boardUuid: String
    "Recommendation board-size override (the size the user is browsing)"
    sizeId: Int
    "Recommendation board-angle override"
    angle: Int
    "Page number"
    page: Int
    "Page size"
    pageSize: Int
  }

  """
  Climb count for a single smart playlist type (used to render library cards).
  """
  type SmartPlaylistCount {
    "Smart playlist type"
    type: SmartPlaylistType!
    "Number of climbs the smart playlist would contain"
    count: Int!
  }
`;
