/**
 * Connection data stored in Redis for cross-instance visibility.
 */
export interface DistributedConnection {
  connectionId: string;
  instanceId: string;
  sessionId: string | null;
  userId: string | null;
  username: string;
  avatarUrl: string | null;
  isLeader: boolean;
  connectedAt: number; // Unix timestamp ms
  isHidden: boolean;
}

/**
 * Redis key prefixes for distributed state.
 */
export const KEYS = {
  // Hash: connectionId -> connection data
  connection: (connectionId: string) => `boardsesh:conn:${connectionId}`,
  // Set: sessionId -> set of connectionIds
  sessionMembers: (sessionId: string) => `boardsesh:session:${sessionId}:members`,
  // String: sessionId -> connectionId of leader
  sessionLeader: (sessionId: string) => `boardsesh:session:${sessionId}:leader`,
  // Set: instanceId -> set of connectionIds owned by this instance
  instanceConnections: (instanceId: string) => `boardsesh:instance:${instanceId}:conns`,
  // String: instanceId -> heartbeat timestamp
  instanceHeartbeat: (instanceId: string) => `boardsesh:instance:${instanceId}:heartbeat`,
} as const;

/**
 * TTL values in seconds.
 */
export const TTL = {
  connection: 60 * 60, // 1 hour - refreshed on activity
  instanceHeartbeat: 60, // 1 minute - refreshed every 30s
  sessionMembership: 4 * 60 * 60, // 4 hours - matches session TTL
} as const;

// Sentinel value to indicate "don't update this field" in Lua scripts
export const UNSET_SENTINEL = '__UNSET__';

/**
 * Validate connectionId format to prevent Redis key injection.
 * ConnectionIds should be UUIDs or similar safe identifiers.
 */
export function validateConnectionId(connectionId: string): void {
  // Allow alphanumeric, hyphens, and underscores (UUID-compatible)
  // Max length prevents memory attacks
  if (!connectionId || connectionId.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(connectionId)) {
    throw new Error(`Invalid connectionId format: ${connectionId.slice(0, 20)}`);
  }
}

/**
 * Validate sessionId format to prevent Redis key injection.
 */
export function validateSessionId(sessionId: string): void {
  if (!sessionId || sessionId.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    throw new Error(`Invalid sessionId format: ${sessionId.slice(0, 20)}`);
  }
}

/**
 * Convert connection object to Redis hash fields.
 */
export function connectionToHash(conn: DistributedConnection): Record<string, string> {
  return {
    connectionId: conn.connectionId,
    instanceId: conn.instanceId,
    sessionId: conn.sessionId || '',
    userId: conn.userId || '',
    username: conn.username,
    avatarUrl: conn.avatarUrl || '',
    isLeader: conn.isLeader ? 'true' : 'false',
    connectedAt: conn.connectedAt.toString(),
    isHidden: conn.isHidden ? 'true' : 'false',
  };
}

/**
 * Convert Redis hash fields to connection object.
 * Note: Empty strings in Redis are treated as null/not set.
 * This is consistent with connectionToHash which converts null to empty string.
 */
export function hashToConnection(hash: Record<string, string>): DistributedConnection {
  // Empty string in Redis means "not set" - convert to null for consistency
  // This matches the pattern: null -> '' (storage) -> null (retrieval)
  const sessionId = hash.sessionId && hash.sessionId !== '' ? hash.sessionId : null;
  const userId = hash.userId && hash.userId !== '' ? hash.userId : null;
  const avatarUrl = hash.avatarUrl && hash.avatarUrl !== '' ? hash.avatarUrl : null;

  // Parse connectedAt with warning for invalid values
  let connectedAt = parseInt(hash.connectedAt, 10);
  if (isNaN(connectedAt)) {
    console.warn(
      `[DistributedState] Invalid connectedAt value "${hash.connectedAt}" for connection ${hash.connectionId?.slice(0, 8)}, using current time`
    );
    connectedAt = Date.now();
  }

  return {
    connectionId: hash.connectionId,
    instanceId: hash.instanceId,
    sessionId,
    userId,
    username: hash.username,
    avatarUrl,
    isLeader: hash.isLeader === 'true',
    connectedAt,
    isHidden: hash.isHidden === 'true',
  };
}
