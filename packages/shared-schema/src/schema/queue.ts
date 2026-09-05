// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

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
    "Order-insensitive hash (v1) of the current state for consistency checking (sorted UUIDs)"
    stateHash: String!
    "Order-SENSITIVE hash (v2) of the current state (UUIDs in queue order). Optional during the dual-hash rollout: old clients ignore it; new clients prefer it when present so a reorder that diverges is detectable."
    stateHashOrdered: String
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
