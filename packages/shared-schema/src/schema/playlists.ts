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
  }

  """
  Input for creating a playlist.
  """
  input CreatePlaylistInput {
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
    "Total count"
    totalCount: Int!
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
    "Filter by generated recommendation status"
    generatedRecommendation: Boolean
    "Sort by: 'recent' (default) or 'popular'"
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
