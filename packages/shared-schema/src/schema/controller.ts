export const controllerTypeDefs = /* GraphQL */ `
  # ============================================
  # ESP32 Controller Types
  # ============================================

  # LED command for controller - pre-computed RGB values
  type LedCommand {
    position: Int!
    r: Int!
    g: Int!
    b: Int!
  }

  # Input version of LED command
  input LedCommandInput {
    position: Int!
    r: Int!
    g: Int!
    b: Int!
    role: Int
  }

  # Minimal climb info for ESP32 navigation display
  type QueueNavigationItem {
    name: String!
    grade: String!
    gradeColor: String!
  }

  # Navigation context sent with LED updates
  type QueueNavigationContext {
    "Previous climbs in queue (up to 3, most recent first)"
    previousClimbs: [QueueNavigationItem!]!
    "Next climb in queue (null if at end)"
    nextClimb: QueueNavigationItem
    "Current position in queue (0-indexed)"
    currentIndex: Int!
    "Total number of items in queue"
    totalCount: Int!
  }

  # LED update event sent to controller
  type LedUpdate {
    commands: [LedCommand!]!
    "Queue item UUID (for reconciling optimistic UI)"
    queueItemUuid: String
    climbUuid: String
    climbName: String
    climbGrade: String
    gradeColor: String
    boardPath: String
    "Compact Aurora frames string for rendering a climb thumbnail."
    frames: String
    """
    Board angle in degrees. Nullable - null means angle not specified.
    Note: 0 is a valid angle value, so null should be used to indicate "no angle"
    rather than defaulting to 0.
    """
    angle: Int
    navigation: QueueNavigationContext
    "ID of client that triggered this update (null if system-initiated). ESP32 uses this to decide whether to disconnect BLE client."
    clientId: String
  }

  # Ping event to keep controller connection alive
  type ControllerPing {
    timestamp: String!
  }

  # Minimal queue item for controller display (subset of ClimbQueueItem)
  type ControllerQueueItem {
    "Queue item UUID (unique per queue position, used for navigation)"
    uuid: ID!
    "Climb UUID (for display matching)"
    climbUuid: ID!
    "Climb name (truncated for display)"
    name: String!
    "Grade string"
    grade: String!
    "Grade color as hex string"
    gradeColor: String!
  }

  # Queue sync event sent to controller
  type ControllerQueueSync {
    "Complete queue state for controller"
    queue: [ControllerQueueItem!]!
    "Index of current climb in queue (-1 if none)"
    currentIndex: Int!
  }

  # Union of events sent to controller
  union ControllerEvent = LedUpdate | ControllerPing | ControllerQueueSync

  # Controller info for management UI
  type ControllerInfo {
    id: ID!
    name: String
    boardName: String!
    layoutId: Int!
    sizeId: Int!
    setIds: String!
    isOnline: Boolean!
    lastSeen: String
    createdAt: String!
  }

  # Result of controller registration
  type ControllerRegistration {
    apiKey: String!
    controllerId: ID!
  }

  # Input for registering a controller
  input RegisterControllerInput {
    boardName: String!
    layoutId: Int!
    sizeId: Int!
    setIds: String!
    name: String
  }

  # Result of climb matching from LED positions
  type ClimbMatchResult {
    matched: Boolean!
    climbUuid: String
    climbName: String
  }

  # ============================================
  # Device Logging Types (ESP32 -> Axiom)
  # ============================================

  # A single log entry from a device
  input DeviceLogEntry {
    ts: Float!
    level: String!
    component: String!
    message: String!
    metadata: String # JSON string for flexibility
  }

  # Input for sending device logs
  input SendDeviceLogsInput {
    logs: [DeviceLogEntry!]!
  }

  # Response from sending device logs
  type SendDeviceLogsResponse {
    success: Boolean!
    accepted: Int!
  }
`;
