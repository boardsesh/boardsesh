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
    | WallDisconnected
    | SessionBoardSerialChanged
    | SessionBoardPathChanged
    | SessionEnded
    | SessionStatsUpdated

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
  DEPRECATED. Sessions are always-live; there is no wall driver. This type and its
  SessionEvent union membership are kept one release purely so stale clients (cached web
  bundles, un-OTA'd native apps) whose \`sessionUpdates\` documents still contain
  \`... on DriverChanged\` keep passing GraphQL validation. The backend never publishes it.
  Remove after the rollout window. (GraphQL has no @deprecated for union members/object
  types, hence this comment.)
  """
  type DriverChanged {
    driverParticipantId: ID
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
  Event broadcast when the device that was relaying the session's climb to the
  wall over BLE drops its connection (an explicit lightbulb-off, a detected BLE
  drop, or the WebSocket closing). Clients turn the queue-control-bar lightbulb
  off — the session no longer knows its climb is lit, and someone outside the
  session may have changed the wall. The current climb is unchanged; pressing the
  lightbulb re-asserts (re-sends) it. Symmetric with WallConfirmedClimb.
  """
  type WallDisconnected {
    "Stable participant id of the member whose connection was relaying the climb, or null for a system/crash backstop (WebSocket close)"
    disconnectedByParticipantId: ID
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
  Event when the session's stored boardPath changes — today carries angle
  changes from any participant's angle selector. Recipients update their
  local URL (\`router.replace\`) so all members stay on the same angle
  view. Skipped when the originating client's own participant id matches
  \`changedByParticipantId\` (the optimistic URL push already happened
  locally). \`boardPath\` is the full route string (\`/<board>/<layout>/<size>/<sets>/<angle>/...\`).
  """
  type SessionBoardPathChanged {
    "New full boardPath for the session"
    boardPath: String!
    "Participant id of the member who triggered the change, or null for system-initiated updates"
    changedByParticipantId: ID
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
  Union of possible queue events.
  """
  union QueueEvent =
    | FullSync
    | QueueItemAdded
    | QueueItemRemoved
    | QueueReordered
    | CurrentClimbChanged
    | ClimbMirrored
    | PlaybackStateChanged

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
    "Raw Aurora frames for an unknown BLE climb when no database match exists"
    frames: String
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

  """
  Input shape for \`publishPlaybackState\`. Carries everything peers need to
  extrapolate the current frame without round-tripping back to the publisher.
  """
  input PlaybackStateInput {
    "Climb the playback applies to. Peers ignore the event if it's for a different climb than they're showing."
    climbUuid: ID!
    "Frame index that became current at \`anchorTimestamp\`."
    frameIndex: Int!
    "Whether the engine is auto-advancing."
    isPlaying: Boolean!
    "Playback multiplier (1.0 = native pace)."
    speed: Float!
    "Climb's native pace, in milliseconds per frame."
    paceMs: Int!
    """
    Stable identifier for the publisher's playback engine instance. Peers use
    it to suppress echoes of their own events when the broadcast reflects back.
    Falls back to the WebSocket connection id when omitted, which is safe but
    coarser (a single connection driving multiple engines can't disambiguate).
    """
    clientId: ID
  }

  """
  Event when a peer's playback engine state changes (play/pause/seek/speed)
  for a variable-speed climb. Peers converge by extrapolating frames since
  \`anchorTimestamp\`. The publisher's own clients echo-suppress by \`clientId\`.
  """
  type PlaybackStateChanged {
    "Sequence number of this event"
    sequence: Int!
    "UUID of the climb whose playback changed"
    climbUuid: ID!
    "Frame index that was current at \`anchorTimestamp\`"
    frameIndex: Int!
    "Whether the engine is auto-advancing"
    isPlaying: Boolean!
    "Playback multiplier (1.0 = native pace)"
    speed: Float!
    "Climb's native pace, in milliseconds per frame"
    paceMs: Int!
    "Server wall-clock (epoch ms) when the broadcast was emitted; peers extrapolate elapsed frames from this"
    anchorTimestamp: String!
    "Client ID of the publisher, used for echo suppression"
    clientId: ID
  }
`;
