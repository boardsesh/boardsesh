import type { QueueActionsType, QueueDataType, ClimbQueueItem, ClimbQueue } from '../queue-control/types';
import type { ConnectionState } from '../connection-manager/websocket-connection-manager';
import type { SessionSummary, SessionUser } from '@boardsesh/shared-schema';
import type { ReactNode } from 'react';
import type { ParsedBoardRouteParameters, BoardDetails, Climb, SearchRequestPagination } from '@/app/lib/types';

// Stable action functions extended with session management
export type GraphQLQueueActionsType = {
  startSession: (options?: { discoverable?: boolean; name?: string; sessionId?: string }) => Promise<string>;
  joinSession: (sessionId: string) => Promise<void>;
  endSession: () => void;
  dismissSessionSummary: () => void;
} & QueueActionsType;

// Combined type for the test-only `useQueueContext` hook + the queue-bridge
// plumbing. Production consumers should subscribe via the fine-grained
// `SessionDataType` / `QueueListDataType` / `SearchDataType` /
// `CurrentClimbDataType` hooks instead of this wide one — those drive the
// targeted re-render path.
export type GraphQLQueueContextType = GraphQLQueueActionsType &
  QueueDataType & {
    isSessionActive: boolean;
    /** See SessionDataType.isPersistentSessionActive. Mirrored here so consumers
     *  reading the combined queue context don't need a second hook. */
    isPersistentSessionActive: boolean;
    sessionId: string | null;
    sessionSummary: SessionSummary | null;
    sessionGoal: string | null;
    connectionState: ConnectionState;
    canMutate: boolean;
    isDisconnected: boolean;
  };

// --- Fine-grained context types for targeted subscriptions ---

export type CurrentClimbDataType = {
  currentClimbQueueItem: ClimbQueueItem | null;
  currentClimb: Climb | null;
};

export type QueueListDataType = {
  queue: ClimbQueue;
  // suggestedClimbs lives here (not SearchContext) because it depends on queue
  // state — filtering search results against the queue. If it were in SearchContext,
  // every queue change would trigger re-renders in search-only consumers.
  suggestedClimbs: Climb[];
};

export type SearchDataType = {
  climbSearchParams: SearchRequestPagination;
  climbSearchResults: Climb[] | null;
  totalSearchResultCount: number | null;
  hasMoreResults: boolean;
  isFetchingClimbs: boolean;
  isFetchingNextPage: boolean;
  hasDoneFirstFetch: boolean;
  parsedParams: ParsedBoardRouteParameters;
};

export type SessionDataType = {
  viewOnlyMode: boolean;
  isSessionActive: boolean;
  /** True whenever a persistent party session exists (even before the WS has
   *  connected). The pivot's solo-vs-party fork keys on this: in a party
   *  session, browse interactions do not mutate the wall climb; in solo, they
   *  still drive the BLE send as today. */
  isPersistentSessionActive: boolean;
  sessionId: string | null;
  sessionSummary: SessionSummary | null;
  sessionGoal: string | null;
  connectionState: ConnectionState;
  canMutate: boolean;
  isDisconnected: boolean;
  users: SessionUser[];
  clientId: string | null;
  /** Local user's stable participant id for the current session, or null
   *  outside a session. Distinct from `clientId` (a connection id). Use this
   *  when comparing against any `SessionUser.id`. */
  participantId: string | null;
  isLeader: boolean;
  /** Session-scoped "the wall is currently lit" indicator (party only). Turns
   *  on when any member's BLE phone relays a climb (`WallConfirmedClimb`) and
   *  off when a member's BLE link drops (`WallDisconnected`). Always false in
   *  solo — the solo lightbulb reads `isBluetoothConnected` directly. */
  wallConfirmed: boolean;
  /** Most recently observed BLE board serial for this session, or null when
   *  unset (solo, or party with no member ever paired). The drawer's
   *  lightbulb fallback uses this to auto-connect to the same board another
   *  member is already paired to, skipping the picker. */
  lastConnectedBoardSerial: string | null;
  isBackendMode: boolean;
  hasConnected: boolean;
  connectionError: Error | null;
};

export type GraphQLQueueContextProps = {
  parsedParams: ParsedBoardRouteParameters;
  boardDetails: BoardDetails;
  children: ReactNode;
  // When provided, the provider operates in "off-board" mode:
  // uses this path instead of computing from pathname, reads session ID
  // from persistent session instead of URL, and skips URL manipulation.
  baseBoardPath?: string;
};
