// ESP32 Controller Types

// LED command for controller - pre-computed RGB values
export type LedCommand = {
  position: number;
  r: number;
  g: number;
  b: number;
  role?: number;
};

// Minimal climb info for ESP32 navigation display
export type QueueNavigationItem = {
  name: string;
  grade: string;
  gradeColor: string;
};

// Navigation context sent with LED updates
export type QueueNavigationContext = {
  previousClimbs: QueueNavigationItem[];
  nextClimb: QueueNavigationItem | null;
  currentIndex: number;
  totalCount: number;
};

// LED update event sent to controller
export type LedUpdate = {
  __typename: 'LedUpdate';
  commands: LedCommand[];
  queueItemUuid?: string;
  climbUuid?: string;
  climbName?: string;
  climbGrade?: string;
  gradeColor?: string;
  boardPath?: string;
  frames?: string;
  angle?: number;
  navigation?: QueueNavigationContext | null;
  // ID of client that triggered this update (null if system-initiated)
  // ESP32 uses this to decide whether to disconnect BLE client
  clientId?: string | null;
};

// Ping event to keep controller connection alive
export type ControllerPing = {
  __typename: 'ControllerPing';
  timestamp: string;
};

// Minimal queue item for controller display
export type ControllerQueueItem = {
  uuid: string; // Queue item UUID (for navigation)
  climbUuid: string; // Climb UUID (for display/matching)
  name: string;
  grade: string;
  gradeColor: string;
};

// Queue sync event sent to controller
export type ControllerQueueSync = {
  __typename: 'ControllerQueueSync';
  queue: ControllerQueueItem[];
  currentIndex: number;
};

// Union of events sent to controller
export type ControllerEvent = LedUpdate | ControllerPing | ControllerQueueSync;

// Controller info for management UI
export type ControllerInfo = {
  id: string;
  name?: string;
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  isOnline: boolean;
  lastSeen?: string;
  createdAt: string;
};

// Result of controller registration
export type ControllerRegistration = {
  apiKey: string;
  controllerId: string;
};

// Input for registering a controller
export type RegisterControllerInput = {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  name?: string;
};

// Result of climb matching from LED positions
export type ClimbMatchResult = {
  matched: boolean;
  climbUuid: string | null;
  climbName: string | null;
};
