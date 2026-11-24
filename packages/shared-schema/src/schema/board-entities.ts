export const boardEntitiesTypeDefs = /* GraphQL */ `
  input ObservedBoardSerialInput {
    boardType: String!
    observedSerialNumber: String!
  }
  type ObservedBoardSerialMatch {
    boardType: String!
    observedSerialNumber: String!
    candidates: [UserBoard!]!
  }
  "A public climb preview without sender identity. See each field for its presence or logbook source."
  type BoardDiscoveryClimb {
    uuid: ID!
    name: String
    frames: String!
    angle: Int!
  }

  """
  Headline usage numbers for the marketing site.

  Counted from board_climb_events, which records every climb pushed to a board's
  LEDs and is dwell-gated at ~60s of presence — so these are climbs someone stood
  in front of, not app-swiping noise. Deliberately NOT counted from ticks, whose
  board attribution was under 1% before 2026-04 and would shrink the number the
  further back it reached.
  """
  type CommunityStats {
    "Distinct climbers who lit a climb on a real board in the last 30 days."
    climbersLast30Days: Int!
    "Climbs lit on real boards in the last 30 days."
    litLast30Days: Int!
    computedAt: String!
  }

  "A public, listed physical board at a public gym. No owner or controller identity is exposed."
  type BoardDiscoveryBoard {
    uuid: ID!
    slug: String!
    name: String!
    boardType: String!
    layoutId: Int!
    sizeId: Int!
    setIds: String!
    angle: Int!
    gymUuid: ID!
    gymName: String!
    gymSlug: String!
    locationName: String
    "Distinct climbers with a send or flash recorded on this physical board."
    uniqueClimbers: Int!
    "Null when there is no verified live holder, including unavailable Redis. Not a live subscription."
    currentClimb: BoardDiscoveryClimb
    "Most publicly logged climb on this physical board, at its most-logged angle. Gym-scoped reads only; null without eligible records."
    popularClimb: BoardDiscoveryClimb
  }

  input BoardDiscoveryInput {
    gymUuid: ID
    "Maximum number of boards, from 1 to 12 (default 8)."
    limit: Int
  }

  # ============================================
  # Board Entity Types
  # ============================================

  """
  A named physical board installation (board type + layout + size + hold sets).
  """
  type UserBoard {
    sprayImport: SprayWallImportProgress
    "Unique identifier"
    uuid: ID!
    "URL slug for this board"
    slug: String!
    "Owner user ID"
    ownerId: ID
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
    "Whether this wall has an LED light kit"
    hasLeds: Boolean!
    """
    Whether an internet-connected wall device (a laser projector, an LED
    controller) lights this wall from the board feed. Climbers take the wall
    with no Bluetooth link.
    """
    litByWallDevice: Boolean!
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
    "Numeric board-presence channel id (userBoards.id); set whenever the viewer may read the board. Feeds boardNowPlaying(boardId); the id alone is the no-link reading, so an Unlisted board's presence also needs boardUuid."
    boardId: Int
    "Gym UUID if linked to a gym"
    gymUuid: String
    "Gym name if linked to a gym"
    gymName: String
    "Whether the linked gym participates in discovery; null when no gym is linked."
    gymIsListed: Boolean
    "Distance in meters from search origin (only set for proximity queries)"
    distanceMeters: Float
    "Controller box serial number"
    serialNumber: String
    "Paired Rogue Fitness timer's advertised BLE name"
    timerName: String
    "Whether the current viewer may edit this board (owner, community admin/leader for its board type, or owner/admin of its linked gym)"
    canEdit: Boolean!
    "Whether the current viewer may delete this board with deleteBoard: its owner; the owner or an admin of its linked gym, on a synced (system-owned) board only; or a global admin. False for a deleted board and when signed out."
    canDelete: Boolean!
    """
    Whether the current viewer may take this board off its gym's listing. True when
    the board is linked to a gym and the viewer is its owner (call linkBoardToGym
    with gymUuid null) or can edit that gym: its owner, a gym admin or editor, or a
    community admin/leader covering it (call detachBoardFromGym). Gym staff use this
    instead of deleting a climber's board. A synced (system-owned) board is deleted,
    not removed: false for it unless the viewer is a global admin. False when
    signed out.
    """
    canRemoveFromGym: Boolean!
    "Whether the current viewer has pinned this board to the front of their board list (false when unauthenticated)"
    isPinnedByMe: Boolean!
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
    userId: ID
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
    audience: PrivacyResourceAudience
    locationAudience: PrivacyLocationAudience
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
    "Whether this wall has an LED light kit (default true)"
    hasLeds: Boolean
    "Whether a wall device lights this wall from the board feed (default false)"
    litByWallDevice: Boolean
    "Controller box serial number"
    serialNumber: String
    "Paired Rogue Fitness timer's advertised BLE name"
    timerName: String
    """
    Create this board even though the caller already owns one with the same
    configuration at the same place. Set only after the user has confirmed it is
    a physically different wall (another gym, another room) — never by default.
    """
    allowDuplicateConfig: Boolean
    "Create even when the serial is already registered to another user's board with the same configuration (default false — such creates fail with BOARD_SERIAL_EXISTS so clients can route the user to the existing board)"
    allowDuplicateSerial: Boolean
    """
    Opt in to the existing-wall recheck (#8151). Absent: no check, exactly the
    behaviour before it existed. Set: when the board has no serial and lands on a
    gym (named, auto-attached or minted), the server looks for walls the caller
    can see at that gym, its merged listings and public listings within 150 m,
    and refuses with BOARD_EXISTING_WALLS per the mode.
    """
    existingWallCheck: ExistingWallCheck
    """
    With CONFIRMED_SEPARATE: the walls the climber was shown and said are
    different from theirs. At most 40.
    """
    acknowledgedWallUuids: [ID!]
  }

  """
  How createBoard treats walls that already exist where the new board lands.
  """
  enum ExistingWallCheck {
    "Refuse when a wall with the same layout and size exists (same sets or not)."
    REJECT_IF_FOUND
    """
    The climber confirmed theirs is a separate wall. Refuse only for a
    same-setup wall missing from acknowledgedWallUuids. With an empty list, only
    honoured when the server finds no same-layout wall at all.
    """
    CONFIRMED_SEPARATE
  }

  """
  How an existing wall compares with the setup the climber is entering. Angle is
  never compared.
  """
  enum WallMatchKind {
    "Same layout, size and hold sets."
    EXACT
    "Same layout and size, different hold sets."
    SETS_DIFFER
    "Same board type, another layout or size. Advisory only; never blocks a create."
    LAYOUT_OR_SIZE_DIFFERS
  }

  """
  Where an existing wall was found relative to the chosen gym.
  """
  enum WallCandidateSource {
    "Linked to the chosen gym."
    SELECTED_GYM
    "Linked to a listing an admin merged into the chosen gym."
    MERGED_LISTING
    "Linked to another public, listed gym within 150 m."
    NEARBY_LISTING
  }

  """
  Input for existingWallCandidates.
  """
  input ExistingWallCandidatesInput {
    "Board type. Spray walls are not supported."
    boardType: String!
    "The chosen gym. A merged listing's uuid resolves to the gym it merged into."
    gymUuid: ID!
    "The draft's layout. Send layoutId, sizeId and setIds together, or none of them."
    layoutId: Int
    "The draft's size."
    sizeId: Int
    "The draft's comma-separated hold sets."
    setIds: String
    "Most candidates to return (default 20, max 40)."
    limit: Int
  }

  """
  A wall the climber can see that may be the one they are about to add.
  """
  type ExistingWallCandidate {
    board: UserBoard!
    "How it compares with the draft; null when no draft setup was sent."
    matchKind: WallMatchKind
    "Hold sets the draft has and the wall lacks (SETS_DIFFER only)."
    missingSetIds: [Int!]!
    "Hold sets the wall has and the draft lacks (SETS_DIFFER only)."
    extraSetIds: [Int!]!
    source: WallCandidateSource!
    "Name of the gym the wall is linked to."
    gymName: String!
    "Metres from the chosen gym to a nearby listing; null for the chosen gym and merged listings."
    gymDistanceMeters: Float
  }

  """
  Existing walls at a gym, best match first.
  """
  type ExistingWallCandidates {
    candidates: [ExistingWallCandidate!]!
    "True when more walls matched than were returned."
    truncated: Boolean!
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
    "New LED light kit flag"
    hasLeds: Boolean
    "New wall device flag"
    litByWallDevice: Boolean
    "New layout ID (authorized editors only; existing ticks are preserved untouched)"
    layoutId: Int
    "New size ID (authorized editors only; existing ticks are preserved untouched)"
    sizeId: Int
    "New set IDs (authorized editors only; existing ticks are preserved untouched)"
    setIds: String
    "Controller box serial number"
    serialNumber: String
    "Paired Rogue Fitness timer's advertised BLE name"
    timerName: String
    """
    Save this edit even though the board's owner already has another board with
    the resulting configuration at the same place. Set only after the user has
    confirmed it is a physically different wall (another gym, another room) —
    never by default.
    """
    allowDuplicateConfig: Boolean
  }

  """
  Input for board leaderboard query.
  """
  input BoardLeaderboardInput {
    "Board UUID"
    boardUuid: ID!
    "Time period (day, week, month, year, all). 'day' is a rolling last-24-hours window (NOW() - INTERVAL '1 day'), not the calendar day so far."
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
    """
    Also list the viewer's OWN spray walls that have never been published, so
    My Boards and Manage can show their import progress. Off by default: board
    pickers must only offer walls that can be climbed on. Other people's
    unfinished walls and archived walls are never listed.
    """
    includeUnfinishedSprayWalls: Boolean = false
  }

  """
  Input for following/unfollowing a board.
  """
  input FollowBoardInput {
    "Board UUID"
    boardUuid: ID!
  }

  """
  Input for pinning/unpinning a board.
  """
  input PinBoardInput {
    "Board UUID"
    boardUuid: ID!
  }

  """
  Input for recording that the viewer opened a board.
  """
  input RecordBoardOpenedInput {
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
    "Filter by board type (OR) — multi-select; composes with boardType if both are set"
    boardTypes: [String!]
    "Filter by layout id (OR)"
    layoutIds: [Int!]
    "Filter by size id (OR)"
    sizeIds: [Int!]
    "Filter by the board's recorded angle (OR), including adjustable boards"
    angles: [Int!]
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
