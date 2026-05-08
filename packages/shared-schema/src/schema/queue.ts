export const queueTypeDefs = /* GraphQL */ `
  """
  User information displayed in queue items.
  """
  type QueueItemUser {
    "Unique user identifier"
    id: ID!
    "Display name shown in the queue"
    username: String!
    "URL to user's avatar image"
    avatarUrl: String
  }

  """
  Input type for queue item user information.
  """
  input QueueItemUserInput {
    id: ID!
    username: String!
    avatarUrl: String
  }

  """
  An item in the climb queue, representing a climb that someone wants to attempt.
  """
  type ClimbQueueItem {
    "Unique identifier for this queue item"
    uuid: ID!
    "The climb data"
    climb: Climb!
    "Username of who added this to the queue (legacy)"
    addedBy: String
    "User who added this climb to the queue"
    addedByUser: QueueItemUser
    "List of user IDs who have completed (ticked) this climb in the session"
    tickedBy: [String!]
    "Whether this climb was suggested by the system"
    suggested: Boolean
  }

  """
  A participant's current personal pick in a collaborative session.
  """
  type UserPick {
    "Stable user identifier, falling back to connection ID for anonymous users"
    userId: ID!
    "The climb currently selected by this participant"
    item: ClimbQueueItem!
    "ISO timestamp when this pick last changed"
    updatedAt: String!
  }

  """
  A durable record of a climb sent to the physical board.
  """
  type BoardSend {
    "Unique identifier for this board-send event"
    id: ID!
    "Session this board-send belongs to"
    sessionId: ID!
    "Queue item/climb that was sent to the board"
    item: ClimbQueueItem!
    "Climb UUID for history deduplication"
    climbUuid: ID!
    "User who performed the send/hand-off action"
    sentByUserId: ID!
    "User whose pick became active on the board"
    activeClimberUserId: ID!
    "Correlation ID for request tracking"
    correlationId: ID
    "Queue-event sequence associated with this send"
    sequence: Int!
    "ISO timestamp for history ordering"
    createdAt: String!
  }

  """
  Input type for adding items to the queue.
  """
  input ClimbQueueItemInput {
    uuid: ID!
    climb: ClimbInput!
    addedBy: String
    addedByUser: QueueItemUserInput
    tickedBy: [String!]
    suggested: Boolean
  }

  """
  The complete state of a session's climb queue.
  Used for synchronization between clients.
  """
  type QueueState {
    "Monotonically increasing sequence number for ordering events"
    sequence: Int!
    "Hash of the current state for consistency checking"
    stateHash: String!
    "List of climbs in the queue"
    queue: [ClimbQueueItem!]!
    "The climb currently being attempted"
    currentClimbQueueItem: ClimbQueueItem
    "Per-participant current picks"
    picks: [UserPick!]!
    "User whose pick is currently mirrored to the board"
    activeClimberUserId: ID
  }

  """
  Response containing events since a given sequence number.
  Used for delta synchronization when reconnecting.
  """
  type EventsReplayResponse {
    "List of events since the requested sequence"
    events: [QueueEvent!]!
    "Current sequence number after all events"
    currentSequence: Int!
  }
`;
