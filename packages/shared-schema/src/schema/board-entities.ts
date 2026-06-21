export const boardEntitiesTypeDefs = /* GraphQL */ `
  # ============================================
  # Board Entity Types
  # ============================================

  """
  A named physical board installation (board type + layout + size + hold sets).
  """
  type UserBoard {
    "Unique identifier"
    uuid: ID!
    "URL slug for this board"
    slug: String!
    "Owner user ID"
    ownerId: ID!
    "Owner display name"
    ownerDisplayName: String
    "Owner avatar URL"
    ownerAvatarUrl: String
    "Board type (kilter, tension, moonboard)"
    boardType: String!
    "Layout ID"
    layoutId: Int!
    "Size ID"
    sizeId: Int!
    "Comma-separated set IDs"
    setIds: String!
    "Board name"
    name: String!
    "Optional description"
    description: String
    "Location name"
    locationName: String
    "GPS latitude"
    latitude: Float
    "GPS longitude"
    longitude: Float
    "Whether publicly visible"
    isPublic: Boolean!
    "Whether hidden from search results (accessible via direct link only)"
    isUnlisted: Boolean!
    "Whether hidden from proximity/nearby search"
    hideLocation: Boolean!
    "Whether the user owns the physical board"
    isOwned: Boolean!
    "Default angle for this board"
    angle: Int!
    "Whether the board's angle is physically adjustable"
    isAngleAdjustable: Boolean!
    "When created"
    createdAt: String!
    "Human-readable layout name"
    layoutName: String
    "Human-readable size name"
    sizeName: String
    "Human-readable size description"
    sizeDescription: String
    "Human-readable set names"
    setNames: [String!]
    "Total ascents on this board"
    totalAscents: Int!
    "Number of unique climbers"
    uniqueClimbers: Int!
    "Number of followers"
    followerCount: Int!
    "Number of comments"
    commentCount: Int!
    "Whether the current user follows this board"
    isFollowedByMe: Boolean!
    "Gym ID if linked to a gym"
    gymId: Int
    "Gym UUID if linked to a gym"
    gymUuid: String
    "Gym name if linked to a gym"
    gymName: String
    "Distance in meters from search origin (only set for proximity queries)"
    distanceMeters: Float
    "Controller box serial number"
    serialNumber: String
  }

  """
  Paginated list of boards.
  """
  type UserBoardConnection {
    "List of boards"
    boards: [UserBoard!]!
    "Total number of boards"
    totalCount: Int!
    "Whether more boards are available"
    hasMore: Boolean!
  }

  """
  Auto-recorded board configuration that the current user was on the last time
  they connected to a controller with the given serial. Acts as a fallback for
  serial→board lookups when no deliberately-saved \`UserBoard\` matches.
  """
  type BoardSerialConfig {
    "Controller box serial number"
    serialNumber: String!
    "Board type (kilter, tension, ...)"
    boardName: String!
    "Layout ID at last connect"
    layoutId: Int!
    "Size ID at last connect"
    sizeId: Int!
    "Comma-separated set IDs at last connect"
    setIds: String!
    "API/protocol level from the BLE device name (the @N suffix); null if never observed"
    apiLevel: Int
    "When the recording was last updated"
    updatedAt: String!
    "Linked saved board UUID (when the connect happened from a /b/{slug}/... route)"
    boardUuid: ID
    "Linked saved board slug (resolved from boardUuid)"
    boardSlug: String
  }

  """
  A leaderboard entry for a board.
  """
  type BoardLeaderboardEntry {
    "User ID"
    userId: ID!
    "Display name"
    userDisplayName: String
    "Avatar URL"
    userAvatarUrl: String
    "Rank on the leaderboard"
    rank: Int!
    "Total sends (flash + send)"
    totalSends: Int!
    "Total flashes"
    totalFlashes: Int!
    "Hardest grade sent (difficulty ID)"
    hardestGrade: Int
    "Human-readable hardest grade name"
    hardestGradeName: String
    "Total sessions"
    totalSessions: Int!
  }

  """
  Board leaderboard result.
  """
  type BoardLeaderboard {
    "Board UUID"
    boardUuid: ID!
    "Leaderboard entries"
    entries: [BoardLeaderboardEntry!]!
    "Total number of entries"
    totalCount: Int!
    "Whether more entries are available"
    hasMore: Boolean!
    "Label for the time period"
    periodLabel: String!
  }

  """
  Input for creating a board.
  """
  input CreateBoardInput {
    "Board type"
    boardType: String!
    "Layout ID"
    layoutId: Int!
    "Size ID"
    sizeId: Int!
    "Comma-separated set IDs"
    setIds: String!
    "Board name"
    name: String!
    "Optional description"
    description: String
    "Location name"
    locationName: String
    "GPS latitude"
    latitude: Float
    "GPS longitude"
    longitude: Float
    "Whether publicly visible (default true)"
    isPublic: Boolean
    "Hide from search results (default false)"
    isUnlisted: Boolean
    "Hide from proximity search unless owner follows searcher (default false)"
    hideLocation: Boolean
    "Whether user owns the physical board (default true)"
    isOwned: Boolean
    "Optional gym UUID to link board to"
    gymUuid: String
    "Default angle for this board (default 40)"
    angle: Int
    "Whether the board's angle is physically adjustable (default true)"
    isAngleAdjustable: Boolean
    "Controller box serial number"
    serialNumber: String
  }

  """
  Input for updating a board.
  """
  input UpdateBoardInput {
    "Board UUID to update"
    boardUuid: ID!
    "New name"
    name: String
    "New slug"
    slug: String
    "New description"
    description: String
    "New location name"
    locationName: String
    "New GPS latitude"
    latitude: Float
    "New GPS longitude"
    longitude: Float
    "New visibility"
    isPublic: Boolean
    "Hide from search results"
    isUnlisted: Boolean
    "Hide from proximity search unless owner follows searcher"
    hideLocation: Boolean
    "New ownership flag"
    isOwned: Boolean
    "New default angle"
    angle: Int
    "New angle adjustable flag"
    isAngleAdjustable: Boolean
    "New layout ID (only allowed when board has zero ticks)"
    layoutId: Int
    "New size ID (only allowed when board has zero ticks)"
    sizeId: Int
    "New set IDs (only allowed when board has zero ticks)"
    setIds: String
    "Controller box serial number"
    serialNumber: String
  }

  """
  Input for board leaderboard query.
  """
  input BoardLeaderboardInput {
    "Board UUID"
    boardUuid: ID!
    "Time period (week, month, year, all)"
    period: String
    "Max entries to return"
    limit: Int
    "Offset for pagination"
    offset: Int
  }

  """
  Input for listing user's boards.
  """
  input MyBoardsInput {
    "Max boards to return"
    limit: Int
    "Offset for pagination"
    offset: Int
  }

  """
  Input for following/unfollowing a board.
  """
  input FollowBoardInput {
    "Board UUID"
    boardUuid: ID!
  }

  """
  Input for searching boards.
  """
  input SearchBoardsInput {
    "Search query"
    query: String
    "Filter by board type"
    boardType: String
    "Latitude for proximity search"
    latitude: Float
    "Longitude for proximity search"
    longitude: Float
    "Radius in km for proximity search (default 50)"
    radiusKm: Float
    "Max results to return"
    limit: Int
    "Offset for pagination"
    offset: Int
  }

  """
  Input for recording the board configuration seen when connecting to a
  controller over BLE (serial + config + advertised API level).
  """
  input RecordBoardSerialInput {
    "Controller box serial number"
    serialNumber: String!
    "Board type (kilter, tension, ...)"
    boardName: String!
    "Layout ID at connect"
    layoutId: Int!
    "Size ID at connect"
    sizeId: Int!
    "Comma-separated set IDs at connect"
    setIds: String!
    "API/protocol level parsed from the BLE device name (the @N suffix)"
    apiLevel: Int
    "Optional UUID of a saved board to link (when connecting from a /b/{slug}/... route)"
    boardUuid: String
  }

  # ============================================
  # Popular Board Config Types
  # ============================================

  """
  A popular board configuration (board type + layout + size + hold sets),
  derived from the catalog of valid configurations ranked by climb count.
  """
  type PopularBoardConfig {
    "Board type (kilter, tension, moonboard)"
    boardType: String!
    "Layout ID"
    layoutId: Int!
    "Human-readable layout name"
    layoutName: String
    "Size ID"
    sizeId: Int!
    "Human-readable size name"
    sizeName: String
    "Human-readable size description"
    sizeDescription: String
    "Set IDs for this configuration"
    setIds: [Int!]!
    "Human-readable set names"
    setNames: [String!]!
    "Number of listed climbs for this layout"
    climbCount: Int!
    "Total sends across all climbs and angles"
    totalAscents: Int!
    "Number of registered boards with this layout/size combination"
    boardCount: Int!
    "Pre-formatted display name for UI (e.g. 'OG 12x12 Full Ride')"
    displayName: String!
  }

  """
  Paginated list of popular board configurations.
  """
  type PopularBoardConfigConnection {
    "List of configurations"
    configs: [PopularBoardConfig!]!
    "Total number of configurations"
    totalCount: Int!
    "Whether more configurations are available"
    hasMore: Boolean!
  }

  """
  Input for querying popular board configurations.
  """
  input PopularBoardConfigsInput {
    "Filter by board type"
    boardType: String
    "Max results to return (default 12)"
    limit: Int
    "Offset for pagination (default 0)"
    offset: Int
  }
`;
