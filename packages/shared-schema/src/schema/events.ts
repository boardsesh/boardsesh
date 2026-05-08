export const eventsTypeDefs = /* GraphQL */ `
  """
  Union of possible session events.
  """
  union SessionEvent = UserJoined | UserLeft | LeaderChanged | SessionEnded | SessionStatsUpdated

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
  Event when session leadership changes.
  """
  type LeaderChanged {
    "ID of the new leader"
    leaderId: ID!
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
    | PickChanged
    | ActiveClimberChanged
    | BoardSendAdded

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
    "UUID of the removed item"
    uuid: ID!
  }

  """
  Event when queue order changes.
  """
  type QueueReordered {
    "Sequence number of this event"
    sequence: Int!
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
    "New mirror state"
    mirrored: Boolean!
  }

  """
  Event when a participant updates their current pick.
  """
  type PickChanged {
    "Sequence number of this event"
    sequence: Int!
    "User whose pick changed"
    userId: ID!
    "New pick, or null when cleared"
    pick: ClimbQueueItem
    "Correlation ID for request tracking"
    correlationId: ID
  }

  """
  Event when the participant controlling the board changes.
  """
  type ActiveClimberChanged {
    "Sequence number of this event"
    sequence: Int!
    "Current active climber, or null when none"
    userId: ID
    "Correlation ID for request tracking"
    correlationId: ID
  }

  """
  Event when a climb is appended to the sent-to-board history.
  """
  type BoardSendAdded {
    "Sequence number of this event"
    sequence: Int!
    "New board-send history row"
    boardSend: BoardSend!
  }
`;
