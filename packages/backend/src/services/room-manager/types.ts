import type { ClimbQueueItem, SessionUser } from '@boardsesh/shared-schema';
import type { Session } from '../../db/schema';
import type { RedisSessionStore } from '../redis-session-store';
import type { DistributedStateManager } from '../distributed-state';
import type { WriteScheduler } from './write-scheduler';

// Custom error for version conflicts
export class VersionConflictError extends Error {
  constructor(sessionId: string, expectedVersion: number) {
    super(
      `Version conflict for session ${sessionId}. Expected version ${expectedVersion} but it was updated by another operation.`,
    );
    this.name = 'VersionConflictError';
  }
}

export type ConnectedClient = {
  connectionId: string;
  sessionId: string | null;
  participantId: string | null;
  userId: string | null;
  username: string;
  avatarUrl?: string;
  isLeader: boolean;
  connectedAt: Date;
  /**
   * The board this connection last became the presence "holder" of (set in
   * reportBoardClimb/reportBoardLayers via roomManager.noteBoardWriter),
   * recorded so the WS-close backstop can free the wall if the holder crashes
   * without sending an explicit reportBoardDisconnect. Quantum layer claims
   * also carry a per-connection token, so an older socket for the same account
   * cannot clear a reconnect's roster.
   *
   * Single record (last write wins): one phone connects to one board at a time
   * (Aurora BLE is last-connection-wins, and switching walls disconnects the
   * old board first, which clears its hold), so we only track the latest.
   */
  boardWriterEmitter?: { boardId: number; emitterId: string; layerClaimToken?: string };
  /**
   * Set synchronously when WS-close cleanup starts. A layer commit that finishes
   * after this point must compensate its distributed claim instead of recording
   * a hold that the already-running close path can no longer observe.
   */
  boardWriterCleanupStarted?: boolean;
};

export type LocalSessionParticipant = {
  id: string;
  username: string;
  userId: string | null;
  avatarUrl?: string;
  isLeader: boolean;
  connectionState: 'CONNECTED' | 'RECONNECTING';
  connectionIds: Set<string>;
  reconnectTimer?: NodeJS.Timeout;
};

/**
 * Plumbing RoomManager injects into the room-manager/* free functions
 * (client-lifecycle.ts, session-discovery.ts, queue-state.ts) instead of
 * passing every private map/store as a positional argument. Built fresh per
 * call by RoomManager's private `deps()` method — never cached, since
 * `redisStore` / `distributedState` are (re)assigned in `initialize()` and
 * nulled in `reset()`, so a cached object would go stale.
 */
export type RoomManagerDeps = {
  clients: Map<string, ConnectedClient>;
  sessions: Map<string, Set<string>>;
  sessionParticipants: Map<string, Map<string, LocalSessionParticipant>>;
  redisStore: RedisSessionStore | null;
  distributedState: DistributedStateManager | null;
  writeScheduler: WriteScheduler;
  sessionGraceTimers: Map<string, NodeJS.Timeout>;
  pendingJoinPersists: Map<string, Promise<void>>;
  sessionGracePeriodMs: number;
};

export type SessionLeaveResult = {
  sessionId: string;
  participantId?: string;
  newLeaderId?: string;
  newLeaderParticipantId?: string;
  /**
   * True when this leave drained the last connection for the participant —
   * peers should see a `UserLeft` event. False when the participant still has
   * sibling connections (e.g. another tab open as the same authenticated
   * user); in that case the leave is per-tab and peers should not be told
   * the user departed.
   */
  participantFullyLeft: boolean;
};

export type SessionDisconnectResult = {
  sessionId: string;
  participantId: string;
  presenceUser?: SessionUser;
  newLeaderId?: string;
  newLeaderParticipantId?: string;
  /**
   * True when the disconnect fully removed the participant (WS-anonymous
   * connections, which can't be resumed on reconnect) — peers should see a
   * `UserLeft`. When absent/false the participant was parked as `RECONNECTING`
   * and `presenceUser` carries the `UserPresenceChanged` payload instead.
   */
  participantFullyLeft?: boolean;
};

/**
 * Injected functions `joinSession` needs but doesn't own — mostly
 * RoomManager methods that themselves delegate elsewhere (e.g.
 * `getQueueState`/`updateQueueStateImmediate` route through Redis vs.
 * Postgres, `leaveSession` is the sibling free function in client-lifecycle.ts).
 * Passed separately from `RoomManagerDeps` since these are behaviour, not
 * plumbing state.
 */
export type JoinSessionCallbacks = {
  getQueueState: (sessionId: string) => Promise<{
    queue: ClimbQueueItem[];
    currentClimbQueueItem: ClimbQueueItem | null;
    version: number;
    sequence: number;
    stateHash: string;
    stateHashOrdered: string;
  }>;
  getSessionUsers: (sessionId: string) => Promise<SessionUser[]>;
  getSessionUsersLocal: (sessionId: string) => SessionUser[];
  getSessionById: (sessionId: string) => Promise<Session | null>;
  updateQueueStateImmediate: (
    sessionId: string,
    queue: ClimbQueueItem[],
    currentClimbQueueItem: ClimbQueueItem | null,
    expectedVersion?: number,
  ) => Promise<number>;
  leaveSession: (connectionId: string) => Promise<SessionLeaveResult | null>;
};

export type JoinSessionOptions = {
  username?: string;
  avatarUrl?: string;
  initialQueue?: ClimbQueueItem[];
  initialCurrentClimb?: ClimbQueueItem | null;
  sessionName?: string;
  participantId?: string | null;
};

export type DiscoverableSession = {
  id: string;
  name: string | null;
  boardPath: string;
  latitude: number;
  longitude: number;
  createdAt: Date;
  createdByUserId: string | null;
  participantCount: number;
  distance: number;
  isActive: boolean;
  goal?: string | null;
  isPublic?: boolean;
  isPermanent?: boolean;
  color?: string | null;
};

export type QueueState = {
  queue: ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
  version: number;
  sequence: number;
  stateHash: string;
  stateHashOrdered: string;
};

export type PendingWrite = {
  queue: ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
  version: number;
  sequence: number;
};

/**
 * Check if an error is a PostgreSQL foreign key violation (error code 23503).
 */
export function isForeignKeyViolation(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const pgError = error as { code?: string; message?: string };
    if (pgError.code === '23503') return true;
    if (pgError.message?.includes('foreign key constraint')) return true;
  }
  return false;
}
