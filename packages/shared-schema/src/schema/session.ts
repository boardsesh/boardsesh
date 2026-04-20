export const sessionTypeDefs = /* GraphQL */ `
  """
  A user participating in a climbing session.
  """
  type SessionUser {
    "Unique user identifier"
    id: ID!
    "Display name"
    username: String!
    "Whether this user is the session leader (controls the queue)"
    isLeader: Boolean!
    "URL to user's avatar image"
    avatarUrl: String
    "Stable database user UUID (null for unauthenticated connections)"
    userId: ID
  }

  """
  An active climbing session where users can collaborate on a queue.
  """
  type Session {
    "Unique session identifier"
    id: ID!
    "Optional name for the session"
    name: String
    "Board configuration path (board_name/layout_id/size_id/set_ids/angle)"
    boardPath: String!
    "Users currently in the session"
    users: [SessionUser!]!
    "Current queue state"
    queueState: QueueState!
    "Whether the current client is the session leader"
    isLeader: Boolean!
    "Unique identifier for this client's connection"
    clientId: ID!
    "Optional session goal text"
    goal: String
    "Whether session is publicly discoverable"
    isPublic: Boolean!
    "When the session was started (ISO 8601)"
    startedAt: String
    "When the session was ended (ISO 8601)"
    endedAt: String
    "Whether session is exempt from auto-end"
    isPermanent: Boolean!
    "Hex color for multi-session display"
    color: String
    "Boards attached to this session. First entry is the primary board (matches boardPath). Derived from the queue when no explicit boards were sent on create."
    boards: [BoardConfig!]!
  }

  """
  A session that can be discovered by nearby users via GPS.
  """
  type DiscoverableSession {
    "Unique session identifier"
    id: ID!
    "Optional session name"
    name: String
    "Board configuration path"
    boardPath: String!
    "GPS latitude of the session location"
    latitude: Float!
    "GPS longitude of the session location"
    longitude: Float!
    "When the session was created (ISO 8601)"
    createdAt: String!
    "User ID of the session creator"
    createdByUserId: ID
    "Number of users currently in the session"
    participantCount: Int!
    "Distance from the querying user's location (meters)"
    distance: Float
    "Whether the session is still active"
    isActive: Boolean!
    "Optional session goal"
    goal: String
    "Whether session is publicly discoverable"
    isPublic: Boolean
    "Whether session is exempt from auto-end"
    isPermanent: Boolean
    "Hex color for multi-session display"
    color: String
  }

  """
  Input for creating a new climbing session.
  """
  input CreateSessionInput {
    "Board configuration path (e.g., 'kilter/1/1/1,2/40')"
    boardPath: String!
    "GPS latitude for session discovery"
    latitude: Float!
    "GPS longitude for session discovery"
    longitude: Float!
    "Optional session name"
    name: String
    "Whether this session should appear in nearby searches"
    discoverable: Boolean!
    "Optional session goal text"
    goal: String
    "Whether session is exempt from auto-end"
    isPermanent: Boolean
    "Board entity IDs for multi-board sessions"
    boardIds: [Int!]
    "Hex color for multi-session display"
    color: String
    "Extra board configs to attach beyond the primary board encoded in boardPath. Omit for single-board sessions."
    boards: [BoardConfigInput!]
  }

  # ============================================
  # Session Summary Types
  # ============================================

  """
  Grade count for session summary grade distribution.
  """
  type SessionGradeCount {
    "Grade name (e.g., 'V5')"
    grade: String!
    "Number of sends at this grade"
    count: Int!
  }

  """
  Hardest climb sent during a session.
  """
  type SessionHardestClimb {
    "Climb UUID"
    climbUuid: String!
    "Climb name"
    climbName: String!
    "Grade name"
    grade: String!
  }

  """
  Participant stats in a session summary.
  """
  type SessionParticipant {
    "User ID"
    userId: String!
    "Display name"
    displayName: String
    "Avatar URL"
    avatarUrl: String
    "Total sends"
    sends: Int!
    "Total attempts"
    attempts: Int!
  }

  """
  Summary of a completed session including stats, grade distribution, and participants.
  """
  type SessionSummary {
    "Session ID"
    sessionId: ID!
    "Total successful sends"
    totalSends: Int!
    "Total attempts (including sends)"
    totalAttempts: Int!
    "Grade distribution of sends"
    gradeDistribution: [SessionGradeCount!]!
    "Hardest climb sent during the session"
    hardestClimb: SessionHardestClimb
    "Participants with their stats"
    participants: [SessionParticipant!]!
    "When the session started"
    startedAt: String
    "When the session ended"
    endedAt: String
    "Duration in minutes"
    durationMinutes: Int
    "Session goal text"
    goal: String
  }
`;
