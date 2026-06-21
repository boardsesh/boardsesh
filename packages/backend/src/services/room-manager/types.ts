import type { ClimbQueueItem } from '@boardsesh/shared-schema';

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
   * reportBoardClimb via roomManager.noteBoardWriter), recorded so the WS-close
   * backstop can free the wall if the holder crashes without sending an explicit
   * reportBoardDisconnect. Keyed by emitter so the clear is a no-op once someone
   * else has taken over (always-take). The clean path is the client's BLE-drop
   * reportBoardDisconnect; this is the crash backstop only.
   *
   * Single record (last write wins): one phone connects to one board at a time
   * (Aurora BLE is last-connection-wins, and switching walls disconnects the
   * old board first, which clears its hold), so we only track the latest. Caveat:
   * for a logged-in user holding from two live connections (same userId emitter),
   * either connection's drop frees the wall via compare-and-delete even though
   * the other still holds — re-acquired on that connection's next send. Benign
   * given always-take; the BLE-drop reportBoardDisconnect is the primary path.
   */
  boardWriterEmitter?: { boardId: number; emitterId: string };
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
