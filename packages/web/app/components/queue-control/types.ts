import { Climb, SearchRequestPagination, ParsedBoardRouteParameters } from '@/app/lib/types';
import { SessionUser } from '@boardsesh/shared-schema';
import type { BoardConfig } from '@boardsesh/shared-schema';
import type { ConnectionState } from '../connection-manager/websocket-connection-manager';

export type { BoardConfig };

export type PeerId = string | null;
export type UserName = PeerId;

export interface QueueItemUser {
  id: string;
  username: string;
  avatarUrl?: string;
}

export interface ClimbQueueItem {
  addedBy?: UserName;
  addedByUser?: QueueItemUser;
  tickedBy?: UserName[];
  climb: Climb;
  uuid: string;
  suggested?: boolean;
  /**
   * Full board configuration this item is meant to render/send against.
   * Denormalized so multi-board queues don't need a per-render DB lookup.
   * Optional for back-compat with legacy items; ingress normalizes from the
   * session primary when absent.
   */
  boardConfig?: BoardConfig | null;
  /**
   * UUID of a named UserBoard this item was queued against. Always co-present
   * with `boardConfig` when set — `boardConfig` is the authoritative render
   * target so we never have to resolve the UserBoard to render a row.
   */
  boardId?: string | null;
}

export type ClimbQueue = ClimbQueueItem[];

export interface QueueState {
  queue: ClimbQueue;
  currentClimbQueueItem: ClimbQueueItem | null;
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
}

export type QueueAction =
  | { type: 'ADD_TO_QUEUE'; payload: ClimbQueueItem }
  | { type: 'REMOVE_FROM_QUEUE'; payload: ClimbQueueItem[] }
  | { type: 'SET_CURRENT_CLIMB'; payload: ClimbQueueItem }
  | { type: 'SET_CURRENT_CLIMB_QUEUE_ITEM'; payload: ClimbQueueItem }
  | { type: 'SET_CLIMB_SEARCH_PARAMS'; payload: SearchRequestPagination }
  | {
      type: 'UPDATE_QUEUE';
      payload: { queue: ClimbQueue; currentClimbQueueItem?: ClimbQueueItem | null };
    }
  | {
      type: 'INITIAL_QUEUE_DATA';
      payload: { queue: ClimbQueue; currentClimbQueueItem?: ClimbQueueItem | null };
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
  | { type: 'DELTA_REPLACE_QUEUE_ITEM'; payload: { uuid: string; item: ClimbQueueItem } }
  | { type: 'CLEANUP_PENDING_UPDATE'; payload: { correlationId: string } }
  | { type: 'CLEANUP_PENDING_UPDATES_BATCH'; payload: { correlationIds: string[] } }
  | { type: 'CLEAR_RESYNC_FLAG' };

// Stable action functions — identity rarely changes
export interface QueueActionsType {
  addToQueue: (climb: Climb) => void;
  removeFromQueue: (item: ClimbQueueItem) => void;
  /** Sets the climb as current. Resolves to the freshly-created ClimbQueueItem
   *  so callers can capture its uuid (e.g. the create form tracks this uuid
   *  to later replace the item in place on subsequent saves). Resolves to
   *  null when validation fails or the mutation is guarded. */
  setCurrentClimb: (climb: Climb) => Promise<ClimbQueueItem | null>;
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
  disconnect?: () => void;
  /** Dispatch an optimistic current-climb update from a native widget navigation.
   *  The native WebSocket already sent the server mutation, so this only updates
   *  the local reducer state and registers the correlationId for echo suppression. */
  dispatchWidgetNavigation?: (item: ClimbQueueItem, correlationId: string) => void;
}

// Frequently-changing state data
export interface QueueDataType {
  queue: ClimbQueue;
  currentClimbQueueItem: ClimbQueueItem | null;
  currentClimb: Climb | null;
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
}

// Combined type for backward compatibility
export type QueueContextType = QueueDataType & QueueActionsType;
