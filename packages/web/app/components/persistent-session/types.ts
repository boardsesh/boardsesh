import type { MutableRefObject } from 'react';
import { getBackendWsUrl } from '@/app/lib/backend-url';
import type { SessionUser, SubscriptionQueueEvent, SessionEvent, SessionLiveStats, SessionSummary, QueueState } from '@boardsesh/shared-schema';
import type { ClimbQueueItem as LocalClimbQueueItem } from '../queue-control/types';
import type { BoardDetails, ParsedBoardRouteParameters } from '@/app/lib/types';
import type { StoredQueueState } from '@/app/lib/queue-storage-db';

// Re-export QueueState from shared-schema for convenience
export type { QueueState } from '@boardsesh/shared-schema';

// Session type matching the GraphQL response
export interface Session {
  id: string;
  name: string | null;
  boardPath: string;
  users: SessionUser[];
  queueState: QueueState;
  isLeader: boolean;
  clientId: string;
  goal?: string | null;
  isPublic?: boolean;
  startedAt?: string | null;
  endedAt?: string | null;
  isPermanent?: boolean;
  color?: string | null;
}

// Active session info stored at root level
export interface ActiveSessionInfo {
  sessionId: string;
  sessionName?: string;
  boardPath: string;
  boardDetails: BoardDetails;
  parsedParams: ParsedBoardRouteParameters;
}

export interface PersistentSessionContextType {
  // Active session info
  activeSession: ActiveSessionInfo | null;

  // Session state
  session: Session | null;
  isConnecting: boolean;
  hasConnected: boolean;
  error: Error | null;

  // Session data
  clientId: string | null;
  isLeader: boolean;
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
  setLocalQueueState: (
    queue: LocalClimbQueueItem[],
    currentItem: LocalClimbQueueItem | null,
    boardPath: string,
    boardDetails: BoardDetails,
  ) => void;
  clearLocalQueue: () => void;
  loadStoredQueue: (boardPath: string) => Promise<StoredQueueState | null>;

  // Session lifecycle
  activateSession: (info: ActiveSessionInfo) => void;
  deactivateSession: () => void;
  setInitialQueueForSession: (
    sessionId: string,
    queue: LocalClimbQueueItem[],
    currentClimb: LocalClimbQueueItem | null,
    sessionName?: string,
  ) => void;

  // Mutation functions
  addQueueItem: (item: LocalClimbQueueItem, position?: number) => Promise<void>;
  removeQueueItem: (uuid: string) => Promise<void>;
  setCurrentClimb: (item: LocalClimbQueueItem | null, shouldAddToQueue?: boolean, correlationId?: string) => Promise<void>;
  mirrorCurrentClimb: (mirrored: boolean) => Promise<void>;
  setQueue: (queue: LocalClimbQueueItem[], currentClimbQueueItem?: LocalClimbQueueItem | null) => Promise<void>;

  // Event subscription for board-level components
  subscribeToQueueEvents: (callback: (event: SubscriptionQueueEvent) => void) => () => void;
  subscribeToSessionEvents: (callback: (event: SessionEvent) => void) => () => void;

  // Ref for offline queue buffer (used by QueueContext to populate, read by event processor during FullSync)
  offlineBufferRef: MutableRefObject<LocalClimbQueueItem[]>;

  // Ref for last received sequence number (used by reconciliation to detect server changes)
  lastReceivedSequenceRef: MutableRefObject<number | null>;

  // Trigger a resync with the server (useful when corrupted data is detected)
  triggerResync: () => void;

  // Session ending with summary (elevated from GraphQLQueueProvider)
  endSessionWithSummary: () => void;
  liveSessionStats: SessionLiveStats | null;
  sessionSummary: SessionSummary | null;
  dismissSessionSummary: () => void;
}

// Pending initial queue for new sessions
export interface PendingInitialQueue {
  sessionId: string;
  queue: LocalClimbQueueItem[];
  currentClimb: LocalClimbQueueItem | null;
  sessionName?: string;
}

// Convert local ClimbQueueItem to GraphQL input format
export function toClimbQueueItemInput(item: LocalClimbQueueItem) {
  return {
    uuid: item.uuid,
    climb: {
      uuid: item.climb.uuid,
      setter_username: item.climb.setter_username,
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
export interface SharedRefs {
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
  saveQueueTimeoutRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  queueEventSubscribersRef: MutableRefObject<Set<(event: SubscriptionQueueEvent) => void>>;
  sessionEventSubscribersRef: MutableRefObject<Set<(event: SessionEvent) => void>>;
}

// Default backend URL resolved at runtime (supports PR preview domains)
export const DEFAULT_BACKEND_URL = getBackendWsUrl();

// Key for persisting ActiveSessionInfo in user-preferences IndexedDB
export const ACTIVE_SESSION_KEY = 'activeSession';

// Cooldown for corruption-triggered resyncs to prevent infinite loops
export const CORRUPTION_RESYNC_COOLDOWN_MS = 30000; // 30 seconds

// Debounce delay for saving queue to IndexedDB
export const QUEUE_SAVE_DEBOUNCE_MS = 500;

export const DEBUG = process.env.NODE_ENV === 'development';
