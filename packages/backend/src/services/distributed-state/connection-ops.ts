import type Redis from 'ioredis';
import {
  KEYS,
  TTL,
  validateConnectionId,
  connectionToHash,
  hashToConnection,
  type DistributedConnection,
} from './constants';
import { ELECT_NEW_LEADER_SCRIPT } from './lua-scripts';

/**
 * Register a new connection in distributed state.
 */
export async function registerConnection(
  redis: Redis,
  instanceId: string,
  connectionId: string,
  username: string,
  userId?: string | null,
  avatarUrl?: string | null,
  isHidden?: boolean
): Promise<void> {
  validateConnectionId(connectionId);

  const connection: DistributedConnection = {
    connectionId,
    instanceId,
    sessionId: null,
    userId: userId || null,
    username,
    avatarUrl: avatarUrl || null,
    isLeader: false,
    connectedAt: Date.now(),
    isHidden: isHidden ?? false,
  };

  const multi = redis.multi();

  // Store connection data
  multi.hmset(KEYS.connection(connectionId), connectionToHash(connection));
  multi.expire(KEYS.connection(connectionId), TTL.connection);

  // Track connection under this instance (with TTL so orphaned sets self-heal)
  multi.sadd(KEYS.instanceConnections(instanceId), connectionId);
  multi.expire(KEYS.instanceConnections(instanceId), 2 * 60 * 60); // 2 hours

  await multi.exec();

  console.log(
    `[DistributedState] Registered connection: ${connectionId.slice(0, 8)} on instance: ${instanceId.slice(0, 8)}`
  );
}

/**
 * Get connection data from Redis.
 */
export async function getConnection(
  redis: Redis,
  connectionId: string
): Promise<DistributedConnection | null> {
  validateConnectionId(connectionId);
  const data = await redis.hgetall(KEYS.connection(connectionId));
  if (!data || !data.connectionId) {
    return null;
  }
  return hashToConnection(data);
}

/**
 * Remove a connection from distributed state.
 * Automatically handles leader election if the removed connection was a leader.
 */
export async function removeConnection(
  redis: Redis,
  instanceId: string,
  connectionId: string,
  electNewLeader: boolean = true
): Promise<{ sessionId: string | null; wasLeader: boolean; newLeaderId: string | null }> {
  validateConnectionId(connectionId);

  // Get current connection state
  const connection = await getConnection(redis, connectionId);
  if (!connection) {
    return { sessionId: null, wasLeader: false, newLeaderId: null };
  }

  const sessionId = connection.sessionId;
  const wasLeader = connection.isLeader;

  const multi = redis.multi();

  // Remove connection data
  multi.del(KEYS.connection(connectionId));

  // Remove from instance tracking
  multi.srem(KEYS.instanceConnections(instanceId), connectionId);

  // Remove from session if member
  if (sessionId) {
    multi.srem(KEYS.sessionMembers(sessionId), connectionId);
  }

  await multi.exec();

  console.log(`[DistributedState] Removed connection: ${connectionId.slice(0, 8)}`);

  // Automatically elect new leader if was leader and requested
  let newLeaderId: string | null = null;
  if (sessionId && wasLeader && electNewLeader) {
    newLeaderId = await electLeaderAfterRemoval(redis, sessionId, connectionId);
  }

  return { sessionId, wasLeader, newLeaderId };
}

/**
 * Elect a new leader after a connection is removed, with fallback logic.
 */
async function electLeaderAfterRemoval(
  redis: Redis,
  sessionId: string,
  connectionId: string
): Promise<string | null> {
  try {
    const newLeaderId = (await redis.eval(
      ELECT_NEW_LEADER_SCRIPT,
      2,
      KEYS.sessionMembers(sessionId),
      KEYS.sessionLeader(sessionId),
      connectionId,
      TTL.sessionMembership.toString(),
      TTL.sessionMembership.toString() // Leader TTL matches session TTL
    )) as string | null;

    if (newLeaderId) {
      console.log(
        `[DistributedState] Elected new leader: ${newLeaderId.slice(0, 8)} after removing ${connectionId.slice(0, 8)}`
      );
    }
    return newLeaderId;
  } catch (err) {
    console.error(
      `[DistributedState] Failed to elect new leader after removing ${connectionId.slice(0, 8)}:`,
      err
    );
    // Fallback: try to manually elect a leader from remaining members
    return electLeaderFallback(redis, sessionId, connectionId);
  }
}

/**
 * Fallback leader election when Lua script fails.
 */
async function electLeaderFallback(
  redis: Redis,
  sessionId: string,
  connectionId: string
): Promise<string | null> {
  try {
    const remainingMembers = await redis.smembers(KEYS.sessionMembers(sessionId));
    const candidates = remainingMembers.filter((id) => id !== connectionId);

    if (candidates.length > 0) {
      // Get connection data to find earliest connected
      const pipeline = redis.pipeline();
      for (const candidateId of candidates) {
        pipeline.hget(KEYS.connection(candidateId), 'connectedAt');
      }
      const results = await pipeline.exec();

      // Find earliest connected candidate
      let earliestCandidate: string | null = null;
      let earliestTime = Infinity;

      if (results) {
        for (let i = 0; i < candidates.length; i++) {
          const result = results[i];
          if (result && result[1]) {
            const connectedAt = parseInt(result[1] as string, 10);
            if (!isNaN(connectedAt) && connectedAt < earliestTime) {
              earliestTime = connectedAt;
              earliestCandidate = candidates[i];
            }
          }
        }
      }

      // Fall back to first candidate if no valid timestamps
      const chosenLeader = earliestCandidate || candidates[0];
      await redis.set(KEYS.sessionLeader(sessionId), chosenLeader, 'EX', TTL.sessionMembership);
      await redis.hset(KEYS.connection(chosenLeader), 'isLeader', 'true');
      console.log(
        `[DistributedState] Fallback elected leader: ${chosenLeader.slice(0, 8)} after removing ${connectionId.slice(0, 8)}`
      );
      return chosenLeader;
    } else {
      // No candidates, clear the leader key
      await redis.del(KEYS.sessionLeader(sessionId));
      return null;
    }
  } catch {
    // Last resort: clear leader to allow next join to become leader
    try {
      await redis.del(KEYS.sessionLeader(sessionId));
    } catch {
      // Ignore cleanup error
    }
    return null;
  }
}

/**
 * Update connection username (and optionally avatar).
 */
export async function updateUsername(
  redis: Redis,
  connectionId: string,
  username: string,
  avatarUrl?: string
): Promise<void> {
  validateConnectionId(connectionId);
  const updates: Record<string, string> = { username };
  if (avatarUrl !== undefined) {
    updates.avatarUrl = avatarUrl || '';
  }
  await redis.hmset(KEYS.connection(connectionId), updates);
}
