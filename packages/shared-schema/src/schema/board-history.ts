export const boardHistoryTypeDefs = /* GraphQL */ `
  """
  Source of a board history entry. \`BLE_SEND\` is the MVP source emitted when
  the BLE-connected user successfully sends a climb to the board. The other
  variants are reserved for future surfaces (manual log entries, or a relay
  of a shared-playlist current-climb change when no BLE user is paired).
  """
  enum BoardHistorySource {
    BLE_SEND
    MANUAL
    SHARED_QUEUE_RELAY
  }

  """
  A single entry in a board's chronological send log.
  """
  type BoardHistoryEntry {
    "Surrogate PK of the underlying row"
    id: ID!
    "Client-generated idempotency key; same logical send shares one uuid across retries"
    uuid: ID!
    "Canonical room key — BLE serial of the controller the climb was sent to"
    boardSerial: String!
    "Best-effort link to a saved userBoards row; null for unregistered boards"
    boardId: ID
    climbUuid: ID!
    angle: Int!
    isMirror: Boolean!
    source: BoardHistorySource!
    "Stable user ID of the BLE-connected sender"
    userId: ID!
    "Display name of the sender at write time (best-effort lookup from users)"
    username: String
    "Party session active at send time, if any"
    sessionId: ID
    "ISO 8601 timestamp when the send occurred"
    sentAt: String!
    "Monotonic per-board_serial sequence (allocated by board_history_sequences)"
    sequence: Int!
  }

  """
  Full sync emitted on initial subscription. Carries the most recent N entries
  in reverse-chronological order and the highest sequence the client has seen.
  """
  type BoardHistoryFullSync {
    sequence: Int!
    entries: [BoardHistoryEntry!]!
  }

  """
  Incremental event emitted whenever a new entry is appended to the log.
  """
  type BoardHistoryEntryAdded {
    sequence: Int!
    entry: BoardHistoryEntry!
  }

  """
  Union of possible board-history events.
  """
  union BoardHistoryEvent = BoardHistoryFullSync | BoardHistoryEntryAdded

  """
  Input for the \`recordBoardSend\` mutation. \`uuid\` is the idempotency key
  (matches the boardsesh_ticks.uuid precedent — server trusts client uuid and
  does ON CONFLICT (uuid) DO NOTHING).
  """
  input RecordBoardSendInput {
    uuid: ID!
    boardSerial: String!
    boardId: ID
    climbUuid: ID!
    "Board family the climb belongs to (e.g. 'kilter', 'tension'). Denormalised onto the history row so per-board-type filters don't need to join userBoards."
    boardType: String!
    "Aurora layout id the climb belongs to. Denormalised for the same reason as boardType."
    layoutId: Int!
    angle: Int!
    isMirror: Boolean
    frames: String
    source: BoardHistorySource!
    sessionId: ID
    "Was the shared-playlist queue active at send time? Recorded for attribution."
    sharedPlaylistMode: Boolean!
  }

  """
  Slim view of a board_sessions row returned by setSharedPlaylistEnabled.
  Distinct from \`Session\` — only carries the fields a client needs to react
  to a shared-playlist toggle without joining the room state.
  """
  type BoardSession {
    id: ID!
    boardPath: String!
    name: String
    sharedPlaylistEnabled: Boolean!
    "ISO 8601 timestamp"
    startedAt: String
    "ISO 8601 timestamp"
    endedAt: String
  }
`;
