import { QueueContextType } from '../queue-control/types';
import type { ConnectionState } from '../connection-manager/websocket-connection-manager';
import type { SessionSummary } from '@boardsesh/shared-schema';
import type { ReactNode } from 'react';
import type { ParsedBoardRouteParameters, BoardDetails } from '@/app/lib/types';

// Extended context type with session management
export interface GraphQLQueueContextType extends QueueContextType {
  // Session management
  isSessionActive: boolean;
  sessionId: string | null;
  startSession: (options?: { discoverable?: boolean; name?: string; sessionId?: string }) => Promise<string>;
  joinSession: (sessionId: string) => Promise<void>;
  endSession: () => void;
  // Session summary shown after ending a session
  sessionSummary: SessionSummary | null;
  dismissSessionSummary: () => void;
  // Session goal
  sessionGoal: string | null;
  connectionState: ConnectionState;
  canMutate: boolean;
  isDisconnected: boolean;
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
