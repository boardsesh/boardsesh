export const eventsTypeDefs = /* GraphQL */ `
  """
  Union of possible session events.
  """
  union SessionEvent =
    | UserJoined
    | UserLeft
    | UserPresenceChanged
    | LeaderChanged
    | DriverChanged
    | WallConfirmedClimb
    | SessionBoardSerialChanged
    | SessionEnded
    | SessionStatsUpdated
    | SharedPlaylistToggled

  """
  Event when a user joins the session.
  """
  type UserJoined {
    "The user who joined"
    user: SessionUser!
  }

  """
  Event when a user leaves the session.
  """
  type UserLeft {
    "ID of the user who left"
    userId: ID!
  }

  """
  Event when a participant's realtime presence state changes.
  """
  type UserPresenceChanged {
    "The participant whose presence changed"
    user: SessionUser!
  }

  """
  Event when session leadership changes.
  """
  type LeaderChanged {
    "Stable participant ID of the new leader"
    leaderId: ID!
    "Connection ID of the new leader, for current-client leadership checks"
    leaderConnectionId: ID
  }

  """
  Event when the wall driver changes (the participant authorized to drive the wall via the queue-control-bar pivot's lightbulb). Null when no member is currently driving.
  """
  type DriverChanged {
    "Stable participant id of the new driver, or null when control was released"
    driverParticipantId: ID
    "Stable participant id of the previous driver, or null when there was none (e.g. the very first take of the session, or after a release). Lets clients render 'X took the wall from Y' toasts and populate the Phase 5 previousDriver analytics property without local bookkeeping."
    previousDriverParticipantId: ID
  }

  """
  Event broadcast when a participant's phone successfully relays a climb to the
  wall over BLE. Other clients use this confirmation to flip the queue-control-bar
  lightbulb from pending to confirmed and to dismiss the local fallback timer.
  Server-stamped: \`confirmedAt\` is set by the backend on receipt to keep ordering
  authoritative across clients.
  """
  type WallConfirmedClimb {
    "UUID of the climb that was sent to the wall"
    climbUuid: ID!
    "Server timestamp when the confirmation was received (ISO 8601)"
    confirmedAt: String!
    "Stable participant id of the member whose phone relayed the climb"
    confirmedByParticipantId: ID!
    "UUID of the queue item that triggered this send, or null when the BLE-capable phone reported only a climb UUID. Lets clients disambiguate when the same climb is queued twice — without this, both queue entries' pending lightbulbs would clear on a single confirmation."
    queueItemUuid: ID
  }

  """
  Event when the session's last-connected BLE board serial changes.
  Used by mobile participants to auto-connect to the same board another
  member is already paired with — saves the chooser step on the second
  phone joining a session in a gym with multiple physical boards.
  Null when the board has been forgotten or never recorded.
  """
  type SessionBoardSerialChanged {
    "Most recently observed BLE board serial, or null when cleared/never set"
    lastConnectedBoardSerial: String
  }

  """
  Event when the session ends.
  """
  type SessionEnded {
    "Reason for session ending"
    reason: String!
    "Optional path to redirect to"
    newPath: String
  }

  """
  Event when session stats change due to logged attempts/sends.
  """
  type SessionStatsUpdated {
    "Session ID these stats belong to"
    sessionId: ID!
    "Total sends (flash + send)"
    totalSends: Int!
    "Total flashes"
    totalFlashes: Int!
    "Total failed attempts (excludes successful send attempts)"
    totalAttempts: Int!
    "Total ticks in this session"
    tickCount: Int!
    "Per-participant session stats"
    participants: [SessionFeedParticipant!]!
    "Grade distribution with flash/send/attempt counts"
    gradeDistribution: [SessionGradeDistributionItem!]!
    "Board types climbed in this session"
    boardTypes: [String!]!
    "Hardest sent grade in this session"
    hardestGrade: String
    "Session duration in minutes"
    durationMinutes: Int
    "Session goal"
    goal: String
    "Current session ticks (latest first)"
    ticks: [SessionDetailTick!]!
  }

  """
  Event when the shared-playlist (shared queue) mode is toggled on or off.
  Sent to all session subscribers so peers can re-route their queue
  mutations between WS (shared) and local IDB (local-only) without
  reconnecting.
  """
  type SharedPlaylistToggled {
    "Session ID this toggle belongs to"
    sessionId: ID!
    "New value of shared_playlist_enabled"
    enabled: Boolean!
  }

  """
  Union of possible queue events.
  """
  union QueueEvent = FullSync | QueueItemAdded | QueueItemRemoved | QueueReordered | CurrentClimbChanged | ClimbMirrored

  """
  Full queue state sync event.
  Sent on initial connection or when delta sync isn't possible.
  """
  type FullSync {
    "Current sequence number"
    sequence: Int!
    "Complete queue state"
    state: QueueState!
  }

  """
  Event when an item is added to the queue.
  """
  type QueueItemAdded {
    "Sequence number of this event"
    sequence: Int!
    "Queue state hash after this event is applied"
    stateHash: String!
    "The added item"
    item: ClimbQueueItem!
    "Position where item was inserted (null = end)"
    position: Int
  }

  """
  Event when an item is removed from the queue.
  """
  type QueueItemRemoved {
    "Sequence number of this event"
    sequence: Int!
    "Queue state hash after this event is applied"
    stateHash: String!
    "UUID of the removed item"
    uuid: ID!
  }

  """
  Event when queue order changes.
  """
  type QueueReordered {
    "Sequence number of this event"
    sequence: Int!
    "Queue state hash after this event is applied"
    stateHash: String!
    "UUID of the moved item"
    uuid: ID!
    "Previous position"
    oldIndex: Int!
    "New position"
    newIndex: Int!
  }

  """
  Event when the current climb changes.
  """
  type CurrentClimbChanged {
    "Sequence number of this event"
    sequence: Int!
    "Queue state hash after this event is applied"
    stateHash: String!
    "New current climb (null to clear)"
    item: ClimbQueueItem
    "ID of the client that made this change"
    clientId: ID
    "Correlation ID for request tracking"
    correlationId: ID
  }

  """
  Event when the current climb's mirror state changes.
  """
  type ClimbMirrored {
    "Sequence number of this event"
    sequence: Int!
    "Queue state hash after this event is applied"
    stateHash: String!
    "UUID of the mirrored queue item, when a current climb exists"
    uuid: ID
    "New mirror state"
    mirrored: Boolean!
  }
`;
