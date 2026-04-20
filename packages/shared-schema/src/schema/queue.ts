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
  The board configuration a queue item should render and send against.
  Denormalized onto the item so multi-board queues don't need a per-render
  lookup to resolve a saved UserBoard.
  """
  type BoardConfig {
    boardName: String!
    layoutId: Int!
    sizeId: Int!
    setIds: [Int!]!
    angle: Int!
  }

  """
  Input type for BoardConfig.
  """
  input BoardConfigInput {
    boardName: String!
    layoutId: Int!
    sizeId: Int!
    setIds: [Int!]!
    angle: Int!
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
    "Board configuration this item was queued against. Optional for back-compat; ingress normalizers fill it in from the session's primary board when absent."
    boardConfig: BoardConfig
    "UUID of a named UserBoard this item was queued against, when applicable. Always co-present with boardConfig — boardConfig is the authoritative render target."
    boardId: ID
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
    boardConfig: BoardConfigInput
    boardId: ID
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
