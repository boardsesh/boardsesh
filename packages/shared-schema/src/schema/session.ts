export const sessionTypeDefs = /* GraphQL */ `
  """
  Current realtime connection state for a session participant.
  """
  enum SessionConnectionState {
    CONNECTED
    RECONNECTING
  }

  """
  A user participating in a climbing session.
  """
  type SessionUser {
    "Stable participant identifier within this session"
    id: ID!
    "Display name"
    username: String!
    "Whether this user is the session leader (presentation/backward compatibility only)"
    isLeader: Boolean!
    "URL to user's avatar image"
    avatarUrl: String
    "Stable database user UUID (null for unauthenticated connections)"
    userId: ID
    "Realtime connection state for this participant"
    connectionState: SessionConnectionState!
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
    "Whether the current client is the session leader (presentation/backward compatibility only)"
    isLeader: Boolean!
    driverParticipantId: ID
      @deprecated(
        reason: "Sessions are always-live; there is no driver. Always null. Kept one release for stale clients (cached web bundles, un-OTA'd native apps); remove after rollout."
      )
    "Most recently observed BLE board serial for this session. Set when a participant pairs their phone to a physical board; broadcast as SessionBoardSerialChanged so late-joiners can auto-connect to the same board. Null when no board has been recorded."
    lastConnectedBoardSerial: String
    "Unique identifier for this client's connection"
    clientId: ID!
    "Backend-resolved participant id for the requesting client. For authenticated users this is the user UUID; for anonymous users it equals clientId. Use this (not the locally generated activeSession.participantId) for self-checks against broadcast participant ids — the backend always ignores client-supplied participantIds for security and uses this resolved value as the broadcast identity. TEMPORARILY NULLABLE: a follow-up release will flip this back to ID! once every Session-returning resolver has been audited to confirm it populates the field. Clients should treat null as 'unknown — fall back to clientId for self-checks'."
    participantId: ID
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
  }

  """
  Durable session lifecycle status, independent of live presence. Backed by
  the persisted session row rather than Redis, so an ended session reads as
  ended even when no participants are currently connected. Lowercase values
  match the strings stored in board_sessions.status so resolvers and clients
  pass them through without mapping (same convention as TickStatus).
  """
  enum SessionStatus {
    "Live or dormant; safe for a client to restore on cold start"
    active
    "Explicitly ended, or auto-finished by the inactivity sweep"
    ended
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

  """
  One viewer-owned lap/event included in an Apple Health workout export.
  """
  type SessionHealthExportLap {
    "Tick UUID"
    tickUuid: ID!
    "Climb UUID"
    climbUuid: String!
    "Climb name"
    climbName: String
    "Grade name"
    grade: String
    "Tick status (flash, send, attempt)"
    status: String!
    "Number of attempts represented by this tick"
    attemptCount: Int!
    "Board type"
    boardType: String!
    "Climb angle"
    angle: Int
    "When the lap was logged"
    climbedAt: String!
  }

  """
  Viewer-specific export payload for writing a finished session to Apple Health.
  It intentionally contains only the requesting user's ticks and saved workout id.
  """
  type SessionHealthExport {
    "Session ID"
    sessionId: ID!
    "When the session started"
    startedAt: String
    "When the session ended"
    endedAt: String
    "Duration in minutes"
    durationMinutes: Int
    "Primary board type for this viewer's workout"
    boardType: String!
    "Viewer-owned sends"
    totalSends: Int!
    "Viewer-owned attempts, including the successful attempt on sends"
    totalAttempts: Int!
    "Hardest climb the viewer sent during the session"
    hardestClimb: SessionHardestClimb
    "Viewer-owned lap events"
    laps: [SessionHealthExportLap!]!
    "Existing Apple Health workout id saved for this viewer/session"
    healthKitWorkoutId: String
  }

  """
  Result of the App Store screenshot fixture: a freshly seeded, ACTIVE
  multi-climber party session the screenshot run deep-links into. Inert in
  production (gated on the SCREENSHOT_FIXTURE_USER_ID env var + the configured
  screenshot user).
  """
  type ScreenshotSession {
    "Deterministic id of the seeded session"
    sessionId: ID!
    "Board path the session lives on, for deep-linking into the in-session view"
    boardPath: String!
  }
`;
