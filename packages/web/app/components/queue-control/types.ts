import type { Climb, SearchRequestPagination, ParsedBoardRouteParameters } from '@/app/lib/types';
import type { SessionUser } from '@boardsesh/shared-schema';
import type { ConnectionState } from '../connection-manager/websocket-connection-manager';

export type PeerId = string | null;
export type UserName = PeerId;

export type QueueItemUser = {
  id: string;
  username: string;
  avatarUrl?: string | null;
};

export type ClimbQueueItem = {
  addedBy?: UserName;
  addedByUser?: QueueItemUser;
  tickedBy?: UserName[];
  climb: Climb;
  uuid: string;
  suggested?: boolean;
};

export type ClimbQueue = ClimbQueueItem[];

export type UserPick = {
  userId: string;
  item: ClimbQueueItem;
  updatedAt: string;
};

export type BoardSend = {
  id: string;
  sessionId: string;
  item: ClimbQueueItem;
  climbUuid: string;
  sentByUserId: string;
  activeClimberUserId: string;
  correlationId?: string | null;
  sequence: number;
  createdAt: string;
};

export type QueueState = {
  queue: ClimbQueue;
  currentClimbQueueItem: ClimbQueueItem | null;
  picks: Record<string, UserPick>;
  activeClimberUserId: string | null;
  boardSends: BoardSend[];
  climbSearchParams: SearchRequestPagination;
  hasDoneFirstFetch: boolean;
  initialQueueDataReceivedFromPeers: boolean;
  // Track locally-initiated current climb updates by correlation ID to skip server echoes
  // Correlation IDs enable precise echo detection without time-based logic in the reducer
  pendingCurrentClimbUpdates: string[];
  // Sequence tracking for gap detection and state verification
  lastReceivedSequence: number | null;
  lastReceivedStateHash: string | null;
  // Flag to indicate corrupted data was filtered and a resync is needed
  needsResync: boolean;
};

export type QueueAction =
  | { type: 'ADD_TO_QUEUE'; payload: ClimbQueueItem }
  | { type: 'REMOVE_FROM_QUEUE'; payload: ClimbQueueItem[] }
  | { type: 'SET_CURRENT_CLIMB'; payload: ClimbQueueItem }
  | { type: 'SET_CURRENT_CLIMB_QUEUE_ITEM'; payload: ClimbQueueItem }
  | { type: 'SET_CLIMB_SEARCH_PARAMS'; payload: SearchRequestPagination }
  | {
      type: 'UPDATE_QUEUE';
      payload: {
        queue: ClimbQueue;
        currentClimbQueueItem?: ClimbQueueItem | null;
        picks?: UserPick[];
        activeClimberUserId?: string | null;
      };
    }
  | {
      type: 'INITIAL_QUEUE_DATA';
      payload: {
        queue: ClimbQueue;
        currentClimbQueueItem?: ClimbQueueItem | null;
        picks?: UserPick[];
        activeClimberUserId?: string | null;
      };
    }
  | { type: 'SET_FIRST_FETCH'; payload: boolean }
  | { type: 'MIRROR_CLIMB' }
  // Delta-specific actions
  | { type: 'DELTA_ADD_QUEUE_ITEM'; payload: { item: ClimbQueueItem; position?: number } }
  | { type: 'DELTA_REMOVE_QUEUE_ITEM'; payload: { uuid: string } }
  | {
      type: 'DELTA_REORDER_QUEUE_ITEM';
      payload: { uuid: string; oldIndex: number; newIndex: number };
    }
  | {
      type: 'DELTA_UPDATE_CURRENT_CLIMB';
      payload: {
        item: ClimbQueueItem | null;
        shouldAddToQueue?: boolean;
        insertAfterCurrent?: boolean;
        isServerEvent?: boolean;
        eventClientId?: string;
        myClientId?: string;
        correlationId?: string;
        serverCorrelationId?: string;
      };
    }
  | { type: 'DELTA_MIRROR_CURRENT_CLIMB'; payload: { mirrored: boolean } }
  | { type: 'SET_MY_PICK'; payload: { userId: string; item: ClimbQueueItem; correlationId?: string } }
  | {
      type: 'DELTA_PICK_CHANGED';
      payload: { userId: string; pick: ClimbQueueItem | null; updatedAt?: string };
    }
  | { type: 'DELTA_ACTIVE_CLIMBER_CHANGED'; payload: { userId: string | null } }
  | { type: 'DELTA_BOARD_SEND_ADDED'; payload: { boardSend: BoardSend } }
  | { type: 'SET_BOARD_SENDS'; payload: { boardSends: BoardSend[] } }
  | { type: 'DELTA_REPLACE_QUEUE_ITEM'; payload: { uuid: string; item: ClimbQueueItem } }
  | { type: 'CLEANUP_PENDING_UPDATE'; payload: { correlationId: string } }
  | { type: 'CLEANUP_PENDING_UPDATES_BATCH'; payload: { correlationIds: string[] } }
  | { type: 'CLEAR_RESYNC_FLAG' };

// Stable action functions — identity rarely changes
export type QueueActionsType = {
  addToQueue: (climb: Climb) => void;
  removeFromQueue: (item: ClimbQueueItem) => void;
  /** Sets the climb as current. Resolves to the freshly-created ClimbQueueItem
   *  so callers can capture its uuid (e.g. the create form tracks this uuid
   *  to later replace the item in place on subsequent saves). Resolves to
   *  null when validation fails or the mutation is guarded. */
  setCurrentClimb: (climb: Climb) => Promise<ClimbQueueItem | null>;
  setMyPick: (climb: Climb) => Promise<ClimbQueueItem | null>;
  setMyPickQueueItem: (item: ClimbQueueItem) => Promise<void>;
  claimTurn: () => Promise<void>;
  yieldTurn: (toUserId: string) => Promise<void>;
  clearMyPick: () => Promise<void>;
  setCurrentClimbQueueItem: (item: ClimbQueueItem) => void;
  /** Replace an existing queue item (by its queue-item uuid) with a new climb,
   *  preserving addedBy attribution. Used by the create form to keep the
   *  tracked queue item in sync as the user keeps editing a climb. */
  replaceQueueItem: (queueItemUuid: string, climb: Climb) => void;
  setClimbSearchParams: (params: SearchRequestPagination) => void;
  setCountSearchParams: (params: SearchRequestPagination) => void;
  mirrorClimb: () => void;
  fetchMoreClimbs: () => void;
  getNextClimbQueueItem: () => ClimbQueueItem | null;
  getPreviousClimbQueueItem: () => ClimbQueueItem | null;
  setQueue: (queue: ClimbQueueItem[]) => void;
  reorderQueueItem?: (uuid: string, oldIndex: number, newIndex: number) => void;
  disconnect?: () => void;
  /** Dispatch an optimistic current-climb update from a native widget navigation.
   *  The native WebSocket already sent the server mutation, so this only updates
   *  the local reducer state and registers the correlationId for echo suppression. */
  dispatchWidgetNavigation?: (item: ClimbQueueItem, correlationId: string) => void;
};

// Frequently-changing state data
export type QueueDataType = {
  queue: ClimbQueue;
  currentClimbQueueItem: ClimbQueueItem | null;
  currentClimb: Climb | null;
  picks: Record<string, UserPick>;
  activeClimberUserId: string | null;
  boardSends: BoardSend[];
  climbSearchParams: SearchRequestPagination;
  climbSearchResults: Climb[] | null;
  suggestedClimbs: Climb[];
  totalSearchResultCount: number | null;
  hasMoreResults: boolean;
  isFetchingClimbs: boolean;
  isFetchingNextPage: boolean;
  hasDoneFirstFetch: boolean;
  viewOnlyMode: boolean;
  parsedParams: ParsedBoardRouteParameters;
  connectionState?: ConnectionState;
  canMutate?: boolean;
  users?: SessionUser[];
  clientId?: string | null;
  isLeader?: boolean;
  isBackendMode?: boolean;
  hasConnected?: boolean;
  connectionError?: Error | null;
  isDisconnected: boolean;
};

// Combined type for backward compatibility
export type QueueContextType = QueueDataType & QueueActionsType;
