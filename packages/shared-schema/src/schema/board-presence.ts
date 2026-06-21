export const boardPresenceTypeDefs = /* GraphQL */ `
  # ============================================
  # Board Presence — "now on the wall"
  #
  # Real-time view of the climb currently lit on a shared physical board,
  # keyed on a shared board_id (userBoards.id, resolved from the BLE serial).
  # Decoupled from sessions: anyone who has connected to the board can watch
  # its live feed. Membership-free, no driver. See docs / the board-presence epic.
  # ============================================

  """
  A climb reported as lit on a physical board. Denormalised for display (mirrors
  the ESP32 LedUpdate payload) plus server-derived attribution and ordering.
  """
  type BoardPresenceClimb {
    "UUID of the climb lit on the wall"
    climbUuid: String!
    "Queue item UUID that triggered the send, if any (disambiguates duplicates)"
    queueItemUuid: String
    "Climb name"
    name: String
    "Grade name (e.g. V6 / 7A+) at the reported angle"
    grade: String
    "Grade colour as a hex string"
    gradeColor: String
    "Aurora frames string for rendering a thumbnail"
    frames: String
    "Board angle in degrees. Null means unspecified (0 is a valid angle)."
    angle: Int
    "Catalog route setter display name (who set the climb)"
    setter: String
    "Display name of the Boardsesh user who lit it. Server-derived from the caller; never client-supplied."
    sentByDisplayName: String
    "Avatar URL of the user who lit it. Server-derived."
    sentByAvatarUrl: String
    "Boardsesh user id of the climber who lit it, for linking to their profile. Server-derived; null for an anonymous sender."
    sentByUserId: ID
    "ISO 8601 timestamp when the report was received (server-stamped)"
    sentAt: String!
    "Monotonic per-board sequence number for ordering and late-joiner dedup"
    seq: Int!
  }

  """
  Event: a climb was set (lit) on the wall.
  """
  type BoardClimbSet {
    "The climb now on the wall"
    climb: BoardPresenceClimb!
  }

  """
  Event: the wall was cleared (best-effort — only emitted on a deliberate
  disconnect; an involuntary BLE drop leaves the last climb sticky).
  """
  type BoardClimbCleared {
    "ISO 8601 timestamp when the wall was cleared"
    clearedAt: String!
    "Monotonic per-board sequence number"
    seq: Int!
  }

  """
  Event: this board's durable stats changed (a tick was logged on the wall).
  Carries the freshly recomputed snapshot so subscribers update their tiles live
  instead of re-fetching — the stat counterpart of \`BoardClimbSet\`.
  """
  type BoardStatsUpdated {
    "Recomputed stats snapshot for the board"
    stats: BoardPresenceStats!
    "Monotonic per-board sequence number (shared counter with climb events)"
    seq: Int!
  }

  """
  The current "who's connected / writing" holder for a board. The holder is the
  emitter of the most recent confirmed send (\`reportBoardClimb\`). A logged-in
  holder carries name + avatar; an anonymous holder carries only nulls (clients
  render a "?"). A null holder means the board is free.
  """
  type BoardConnectionHolder {
    "Logged-in user id; null for an anonymous holder."
    userId: ID
    "Display name; null for an anonymous holder."
    displayName: String
    "Avatar URL; null for an anonymous holder."
    avatarUrl: String
    "ISO 8601 timestamp of the holder's most recent confirmed send."
    lastSentAt: String
  }

  """
  Event: the board's connection holder changed (a different emitter took the wall
  via a confirmed send, or the holder disconnected). \`holder\` is null when the
  board went free.
  """
  type BoardConnectionChanged {
    "The current holder, or null when the board is free."
    holder: BoardConnectionHolder
    "Monotonic per-board sequence number (shared counter with climb events)."
    seq: Int!
  }

  """
  Union of board-presence events streamed by \`boardNowPlaying\`.
  """
  union BoardPresenceEvent = BoardClimbSet | BoardClimbCleared | BoardStatsUpdated | BoardConnectionChanged

  """
  The first climber to send the hardest grade logged on this wall.
  """
  type BoardPresenceHardestSend {
    "UUID of the hardest sent climb"
    climbUuid: String!
    "Climb name"
    name: String
    "Grade name (e.g. V6 / 7A+)"
    grade: String!
    "Boardsesh user id of the climber"
    sentByUserId: String!
    "Display name of the climber"
    sentByDisplayName: String
    "Avatar URL of the climber"
    sentByAvatarUrl: String
    "ISO 8601 timestamp of the send"
    sentAt: String!
  }

  """
  A board resolved from a BLE serial — the one shared board everyone at this
  physical wall sees. \`boardId\` is the shared key for the presence channel.
  """
  type ResolvedBoard {
    "Shared board id (userBoards.id), keyed 1:1 to the serial"
    boardId: Int!
    "Display name of the board (e.g. 'Garage Kilter')"
    boardName: String!
    "Board type (kilter, tension, ...)"
    boardType: String!
    "Layout id"
    layoutId: Int!
    "Size id"
    sizeId: Int!
    "Comma-separated set ids"
    setIds: String!
  }

  """
  One board sharing a (non-unique) BLE serial, shown to the user when a serial
  maps to more than one board so they can pick which wall they're at. Location
  fields are redacted for non-public boards the caller doesn't own.
  """
  type BoardCandidate {
    "Shared board id (userBoards.id)"
    boardId: Int!
    "Board uuid"
    boardUuid: ID!
    "Display name of the board"
    boardName: String!
    "Board type (kilter, tension, ...)"
    boardType: String!
    "Layout id"
    layoutId: Int!
    "Size id"
    sizeId: Int!
    "Comma-separated set ids"
    setIds: String!
    "Human-readable location (null when redacted)"
    locationName: String
    "Linked gym name (null when redacted or no gym)"
    gymName: String
    "True when the calling user owns this board"
    isOwnedByMe: Boolean!
    "Whether the board is publicly listed"
    isPublic: Boolean!
    "ISO 8601 of the most recent tick on this board, if any"
    lastSentAt: String
  }

  """
  Result of resolving a BLE serial that may map to several boards. Exactly one
  of \`board\` / \`candidates\` is set: \`board\` when the serial is unambiguous
  (remembered choice, only one match, or freshly created), \`candidates\` when
  the user must pick which wall they're at (confirm with \`chooseBoardForSerial\`).
  """
  type ResolveBoardResult {
    "Set when the serial resolves to a single board"
    board: ResolvedBoard
    "Set when several boards share the serial and the user must choose"
    candidates: [BoardCandidate!]
  }

  """
  Lightweight live + durable stats for a board's wall feed. Durable counts are
  derived from \`boardsesh_ticks\` stamped with this board_id; "right now" comes
  from the live Redis window.
  """
  type BoardPresenceStats {
    "Distinct climbs sent/logged on this wall"
    climbsSentCount: Int!
    "Distinct climbers seen on this wall"
    distinctClimbersCount: Int!
    "Hardest grade sent on this wall (name), if any"
    hardestGrade: String
    "First send at the hardest grade logged on this wall, if any"
    hardestSend: BoardPresenceHardestSend
    "Most-sent grade on this wall (name), if any"
    topGrade: String
    "ISO 8601 timestamp of the most recent send on this wall"
    lastSentAt: String
  }
`;
