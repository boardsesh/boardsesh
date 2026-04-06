import { QueueActionsType, QueueDataType } from '../queue-control/types';
import type { ConnectionState } from '../connection-manager/websocket-connection-manager';
import type { SessionSummary } from '@boardsesh/shared-schema';
import type { ReactNode } from 'react';
import type { ParsedBoardRouteParameters, BoardDetails } from '@/app/lib/types';

// Stable action functions extended with session management
export interface GraphQLQueueActionsType extends QueueActionsType {
  startSession: (options?: { discoverable?: boolean; name?: string; sessionId?: string }) => Promise<string>;
  joinSession: (sessionId: string) => Promise<void>;
  endSession: () => void;
  dismissSessionSummary: () => void;
}

// Frequently-changing state data extended with session state
export interface GraphQLQueueDataType extends QueueDataType {
  isSessionActive: boolean;
  sessionId: string | null;
  sessionSummary: SessionSummary | null;
  sessionGoal: string | null;
  connectionState: ConnectionState;
  canMutate: boolean;
  isDisconnected: boolean;
}

// Combined type for backward compatibility
export type GraphQLQueueContextType = GraphQLQueueActionsType & GraphQLQueueDataType;

// --- Fine-grained context types for targeted subscriptions ---

import type { Climb, SearchRequestPagination } from '@/app/lib/types';
import type { ClimbQueueItem, ClimbQueue } from '../queue-control/types';
import type { SessionUser } from '@boardsesh/shared-schema';

export interface CurrentClimbDataType {
  currentClimbQueueItem: ClimbQueueItem | null;
  currentClimb: Climb | null;
}

export interface QueueListDataType {
  queue: ClimbQueue;
  // suggestedClimbs lives here (not SearchContext) because it depends on queue
  // state — filtering search results against the queue. If it were in SearchContext,
  // every queue change would trigger re-renders in search-only consumers.
  suggestedClimbs: Climb[];
}

export interface SearchDataType {
  climbSearchParams: SearchRequestPagination;
  climbSearchResults: Climb[] | null;
  totalSearchResultCount: number | null;
  hasMoreResults: boolean;
  isFetchingClimbs: boolean;
  isFetchingNextPage: boolean;
  hasDoneFirstFetch: boolean;
  parsedParams: ParsedBoardRouteParameters;
}

export interface SessionDataType {
  viewOnlyMode: boolean;
  isSessionActive: boolean;
  sessionId: string | null;
  sessionSummary: SessionSummary | null;
  sessionGoal: string | null;
  connectionState: ConnectionState;
  canMutate: boolean;
  isDisconnected: boolean;
  users: SessionUser[];
  clientId: string | null;
  isLeader: boolean;
  isBackendMode: boolean;
  hasConnected: boolean;
  connectionError: Error | null;
}

export type GraphQLQueueContextProps = {
  parsedParams: ParsedBoardRouteParameters;
  boardDetails: BoardDetails;
  children: ReactNode;
  // When provided, the provider operates in "off-board" mode:
  // uses this path instead of computing from pathname, reads session ID
  // from persistent session instead of URL, and skips URL manipulation.
  baseBoardPath?: string;
};
