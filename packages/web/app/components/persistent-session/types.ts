import type { MutableRefObject } from 'react';
import { getBackendWsUrl } from '@/app/lib/backend-url';
import type {
  SessionUser,
  SubscriptionQueueEvent,
  SessionEvent,
  SessionSummary,
  QueueState,
} from '@boardsesh/shared-schema';
import type { ClimbQueueItem as LocalClimbQueueItem } from '../queue-control/types';
import type { BoardDetails, ParsedBoardRouteParameters } from '@/app/lib/types';
// Re-export QueueState from shared-schema for convenience
export type { QueueState } from '@boardsesh/shared-schema';

// Session type matching the GraphQL response
export type Session = {
  id: string;
  name: string | null;
  boardPath: string;
  users: SessionUser[];
  queueState: QueueState;
  isLeader: boolean;
  /**
   * Stable participant id of the user currently driving the wall, or null
   * when the wall is unclaimed. Set via the takeControl mutation; cleared via
   * releaseControl or driver disconnect. Distinct from `isLeader`, which is
   * presentation/legacy.
   */
  driverParticipantId: string | null;
  /**
   * Most recently observed BLE board serial for this session, or null when no
   * member has ever paired. Set via the setSessionBoardSerial mutation and
   * kept in sync via the SessionBoardSerialChanged broadcast. Mobile clients
   * use this to auto-connect to the same physical board another member is
   * already paired with.
   */
  lastConnectedBoardSerial: string | null;
  clientId: string;
  /**
   * Backend-resolved participant id for this connection. For authenticated
   * users this is their user UUID; for anonymous users it equals `clientId`.
   * Compare this against `driverParticipantId` or any `SessionUser.id` — the
   * server broadcasts `DriverChanged` with this resolved value.
   */
  participantId: string;
  goal?: string | null;
  isPublic?: boolean;
  startedAt?: string | null;
  endedAt?: string | null;
  isPermanent?: boolean;
  color?: string | null;
};

// Active session info stored at root level
export type ActiveSessionInfo = {
  sessionId: string;
  sessionName?: string;
  boardPath: string;
  boardDetails: BoardDetails;
  parsedParams: ParsedBoardRouteParameters;
  /** User-facing name of the named board (e.g., "My Home Wall") */
  namedBoardName?: string;
  /** UUID of the named board (UserBoard) */
  namedBoardUuid?: string;
};

// Stable action functions — identity rarely changes
export type PersistentSessionActionsType = {
  // Local queue management (in-memory only, no IndexedDB persistence)
  setLocalQueueState: (
    queue: LocalClimbQueueItem[],
    currentItem: LocalClimbQueueItem | null,
    boardPath: string,
    boardDetails: BoardDetails,
  ) => void;
  clearLocalQueue: () => void;

  // Session lifecycle
  activateSession: (info: ActiveSessionInfo) => void;
  deactivateSession: (options?: { notifyServer?: boolean }) => void;
  setInitialQueueForSession: (
    sessionId: string,
    queue: LocalClimbQueueItem[],
    currentClimb: LocalClimbQueueItem | null,
    sessionName?: string,
  ) => void;

  // Mutation functions
  addQueueItem: (item: LocalClimbQueueItem, position?: number) => Promise<void>;
  removeQueueItem: (uuid: string) => Promise<void>;
  setCurrentClimb: (
    item: LocalClimbQueueItem | null,
    shouldAddToQueue?: boolean,
    correlationId?: string,
  ) => Promise<void>;
  mirrorCurrentClimb: (mirrored: boolean) => Promise<void>;
  setQueue: (queue: LocalClimbQueueItem[], currentClimbQueueItem?: LocalClimbQueueItem | null) => Promise<void>;
  replaceQueueItem: (uuid: string, item: LocalClimbQueueItem) => Promise<void>;

  // Wall-control mutations — the queue-control-bar pivot's lightbulb plumbing.
  // Solo (no party) is a backend no-op; the helper resolves so callers can
  // treat takeControl(climb) as a drop-in for setCurrentClimb(climb).
  takeControl: (climb?: LocalClimbQueueItem | null) => Promise<void>;
  releaseControl: () => Promise<void>;

  // Wall-confirm + board-serial mutations. Both are no-ops in solo (no
  // active session) so callers can fire them unconditionally without an
  // `if (sessionId)` guard at the call site.
  confirmClimbOnWall: (climbUuid: string) => Promise<void>;
  setSessionBoardSerial: (serial: string) => Promise<void>;
  // Broadcast a boardPath change (today: angle changes) to every session
  // member. Caller is expected to have already pushed the URL locally
  // via `router.push` for instant feedback; this only propagates to the
  // rest of the session. No-op in solo.
  setSessionBoardPath: (boardPath: string) => Promise<void>;

  // Event subscription for board-level components
  subscribeToQueueEvents: (callback: (event: SubscriptionQueueEvent) => void) => () => void;
  subscribeToSessionEvents: (callback: (event: SessionEvent) => void) => () => void;

  // Trigger a resync with the server (useful when corrupted data is detected)
  triggerResync: () => void;

  // Session ending with summary
  endSessionWithSummary: () => void;
  dismissSessionSummary: () => void;

  // Surface a session that the backend already auto-ended due to inactivity.
  // Invoked from the queue-storage restore path before activation.
  setAutoFinishedSummary: (summary: SessionSummary, boardType: string | null) => void;
};

// Frequently-changing state data
export type PersistentSessionStateType = {
  // Active session info
  activeSession: ActiveSessionInfo | null;

  // Session state
  session: Session | null;
  isConnecting: boolean;
  hasConnected: boolean;
  error: Error | null;

  // Session data
  clientId: string | null;
  /**
   * The local user's stable participant id for the current session, or null
   * when not in a session. Distinct from `clientId`, which is a connection id
   * (anonymous users have `participantId === clientId`; authenticated users
   * have a different participantId per their database user UUID). Use this
   * to compare against `driverParticipantId` or any `SessionUser.id`.
   */
  participantId: string | null;
  isLeader: boolean;
  /**
   * Stable participant id of the wall driver, or null when unclaimed. Surfaced
   * here so QueueContext can derive `isDriver` without reaching into the raw
   * Session object.
   */
  driverParticipantId: string | null;
  users: SessionUser[];

  // Queue state synced from backend
  currentClimbQueueItem: LocalClimbQueueItem | null;
  queue: LocalClimbQueueItem[];

  // Local queue state (persists without WebSocket session)
  localQueue: LocalClimbQueueItem[];
  localCurrentClimbQueueItem: LocalClimbQueueItem | null;
  localBoardPath: string | null;
  localBoardDetails: BoardDetails | null;
  isLocalQueueLoaded: boolean;

  // Ref for offline queue buffer (used by QueueContext to populate, read by event processor during FullSync)
  offlineBufferRef: MutableRefObject<LocalClimbQueueItem[]>;

  // Ref for last received sequence number (used by reconciliation to detect server changes)
  lastReceivedSequenceRef: MutableRefObject<number | null>;

  sessionSummary: SessionSummary | null;
  sessionSummaryBoardType: string | null;
  sessionSummaryHealthKitWorkoutId: string | null;
  // True when the summary is shown because the session was auto-finished after
  // inactivity. The dialog title changes ("Session Finished" vs "Session Summary");
  // HealthKit behaves the same as a manually-ended session.
  sessionSummaryAutoFinished: boolean;
};

// Combined type for backward compatibility
export type PersistentSessionContextType = PersistentSessionStateType & PersistentSessionActionsType;

// Pending initial queue for new sessions
export type PendingInitialQueue = {
  sessionId: string;
  queue: LocalClimbQueueItem[];
  currentClimb: LocalClimbQueueItem | null;
  sessionName?: string;
};

// Convert local ClimbQueueItem to GraphQL input format
export function toClimbQueueItemInput(item: LocalClimbQueueItem) {
  return {
    uuid: item.uuid,
    climb: {
      uuid: item.climb.uuid,
      setter_username: item.climb.setter_username,
      // userId is the stable identity for ownership gates (Edit button,
      // 24h post-publish window). Null/undefined for Aurora-synced climbs.
      userId: item.climb.userId ?? null,
      name: item.climb.name,
      description: item.climb.description || '',
      frames: item.climb.frames,
      angle: item.climb.angle,
      ascensionist_count: item.climb.ascensionist_count,
      difficulty: item.climb.difficulty,
      quality_average: item.climb.quality_average,
      stars: item.climb.stars,
      difficulty_error: item.climb.difficulty_error,
      mirrored: item.climb.mirrored,
      benchmark_difficulty: item.climb.benchmark_difficulty,
      // Round-trip draft/publish state so peers can decide locally whether
      // to surface the Edit affordance without re-querying the DB.
      is_draft: item.climb.is_draft ?? null,
      published_at: item.climb.published_at ?? null,
      userAscents: item.climb.userAscents,
      userAttempts: item.climb.userAttempts,
    },
    addedBy: item.addedBy,
    addedByUser: item.addedByUser
      ? {
          id: item.addedByUser.id,
          username: item.addedByUser.username,
          avatarUrl: item.addedByUser.avatarUrl,
        }
      : undefined,
    tickedBy: item.tickedBy,
    suggested: item.suggested,
  };
}

// Shared refs type used across hooks
export type SharedRefs = {
  offlineBufferRef: MutableRefObject<LocalClimbQueueItem[]>;
  wsAuthTokenRef: MutableRefObject<string | null>;
  usernameRef: MutableRefObject<string | undefined>;
  avatarUrlRef: MutableRefObject<string | undefined>;
  sessionRef: MutableRefObject<Session | null>;
  activeSessionRef: MutableRefObject<ActiveSessionInfo | null>;
  queueRef: MutableRefObject<LocalClimbQueueItem[]>;
  currentClimbQueueItemRef: MutableRefObject<LocalClimbQueueItem | null>;
  mountedRef: MutableRefObject<boolean>;
  isConnectingRef: MutableRefObject<boolean>;
  isReconnectingRef: MutableRefObject<boolean>;
  connectionGenerationRef: MutableRefObject<number>;
  triggerResyncRef: MutableRefObject<(() => void) | null>;
  lastReceivedSequenceRef: MutableRefObject<number | null>;
  lastCorruptionResyncRef: MutableRefObject<number>;
  isFilteringCorruptedItemsRef: MutableRefObject<boolean>;
  queueUnsubscribeRef: MutableRefObject<(() => void) | null>;
  sessionUnsubscribeRef: MutableRefObject<(() => void) | null>;
  queueEventSubscribersRef: MutableRefObject<Set<(event: SubscriptionQueueEvent) => void>>;
  sessionEventSubscribersRef: MutableRefObject<Set<(event: SessionEvent) => void>>;
};

// Default backend URL resolved at runtime (supports PR preview domains)
export const DEFAULT_BACKEND_URL = getBackendWsUrl();

// Key for persisting ActiveSessionInfo in user-preferences IndexedDB
export const ACTIVE_SESSION_KEY = 'activeSession';

// Cooldown for corruption-triggered resyncs to prevent infinite loops
export const CORRUPTION_RESYNC_COOLDOWN_MS = 30000; // 30 seconds

export const DEBUG = process.env.NODE_ENV === 'development';
