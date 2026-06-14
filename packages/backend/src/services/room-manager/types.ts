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
  // Boards this specific connection holds a wall-connection (BLE writer) claim
  // for. The wall link is bound to the physical connection, not the
  // participant, so it's freed when *this* connection drops — even if the same
  // participant still has a sibling connection alive.
  announcedWallBoards?: Set<number>;
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
