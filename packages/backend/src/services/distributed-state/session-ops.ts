import type Redis from 'ioredis';
import type { SessionUser } from '@boardsesh/shared-schema';
import {
  KEYS,
  TTL,
  UNSET_SENTINEL,
  validateConnectionId,
  validateSessionId,
  hashToConnection,
} from './constants';
import {
  JOIN_SESSION_SCRIPT,
  LEAVE_SESSION_SCRIPT,
  ELECT_NEW_LEADER_SCRIPT,
  REFRESH_TTL_SCRIPT,
  PRUNE_STALE_SESSION_MEMBERS_SCRIPT,
} from './lua-scripts';

/**
 * Join a session. Handles leader election for first member.
 * Uses atomic Lua script to prevent race conditions.
 * Returns whether this connection became leader.
 */
export async function joinSession(
  redis: Redis,
  connectionId: string,
  sessionId: string,
  username?: string,
  avatarUrl?: string | null
): Promise<{ isLeader: boolean }> {
  validateConnectionId(connectionId);
  validateSessionId(sessionId);

  const becameLeader = (await redis.eval(
    JOIN_SESSION_SCRIPT,
    3,
    KEYS.connection(connectionId),
    KEYS.sessionMembers(sessionId),
    KEYS.sessionLeader(sessionId),
    connectionId,
    sessionId,
    TTL.connection.toString(),
    TTL.sessionMembership.toString(),
    username || UNSET_SENTINEL,
    // Use sentinel when avatarUrl is undefined (not provided), otherwise use actual value
    // This allows empty string to explicitly clear the avatar
    avatarUrl !== undefined ? (avatarUrl || '') : UNSET_SENTINEL
  )) as number;

  if (becameLeader === 1) {
    console.log(
      `[DistributedState] Connection ${connectionId.slice(0, 8)} became leader of session ${sessionId.slice(0, 8)}`
    );
  }

  return { isLeader: becameLeader === 1 };
}

/**
 * Leave a session. Handles leader election if leaving member was leader.
 * Uses atomic Lua script to prevent race conditions.
 * Returns the new leader's connectionId if leadership changed.
 */
export async function leaveSession(
  redis: Redis,
  connectionId: string,
  sessionId: string
): Promise<{ newLeaderId: string | null }> {
  validateConnectionId(connectionId);
  validateSessionId(sessionId);

  try {
    const result = (await redis.eval(
      LEAVE_SESSION_SCRIPT,
      3,
      KEYS.connection(connectionId),
      KEYS.sessionMembers(sessionId),
      KEYS.sessionLeader(sessionId),
      connectionId,
      TTL.sessionMembership.toString(),
      TTL.sessionMembership.toString()
    )) as string | null;

    // Result: null = wasn't leader, '' = was leader but no new leader, otherwise = new leader ID
    if (result === null) {
      return { newLeaderId: null };
    }

    if (result === '') {
      console.log(
        `[DistributedState] Session ${sessionId.slice(0, 8)} has no remaining members after leader left`
      );
      return { newLeaderId: null };
    }

    console.log(
      `[DistributedState] Elected new leader: ${result.slice(0, 8)} for session ${sessionId.slice(0, 8)}`
    );
    return { newLeaderId: result };
  } catch (err) {
    console.error(`[DistributedState] Failed to leave session ${sessionId.slice(0, 8)}:`, err);
    return leaveSessionFallback(redis, connectionId, sessionId);
  }
}

/**
 * Fallback leave session logic when the Lua script fails.
 * Uses WATCH for optimistic locking to detect concurrent leader changes.
 */
async function leaveSessionFallback(
  redis: Redis,
  connectionId: string,
  sessionId: string
): Promise<{ newLeaderId: string | null }> {
  try {
    await redis.watch(KEYS.sessionLeader(sessionId));

    try {
      const currentLeader = await redis.get(KEYS.sessionLeader(sessionId));
      const wasLeader = currentLeader === connectionId;

      const multi = redis.multi();
      multi.hmset(KEYS.connection(connectionId), { sessionId: '', isLeader: 'false' });
      multi.srem(KEYS.sessionMembers(sessionId), connectionId);
      const execResult = await multi.exec();

      if (execResult === null) {
        console.log(
          `[DistributedState] Fallback aborted: leader changed during cleanup for session ${sessionId.slice(0, 8)}`
        );
        return { newLeaderId: null };
      }

      if (wasLeader) {
        try {
          const newLeaderId = (await redis.eval(
            ELECT_NEW_LEADER_SCRIPT,
            2,
            KEYS.sessionMembers(sessionId),
            KEYS.sessionLeader(sessionId),
            connectionId,
            TTL.sessionMembership.toString(),
            TTL.sessionMembership.toString()
          )) as string | null;

          if (newLeaderId) {
            console.log(
              `[DistributedState] Fallback: elected new leader ${newLeaderId.slice(0, 8)} for session ${sessionId.slice(0, 8)}`
            );
            return { newLeaderId };
          }
        } catch (electionErr) {
          console.error(`[DistributedState] Fallback leader election failed:`, electionErr);
          await redis.del(KEYS.sessionLeader(sessionId)).catch(() => {});
        }
      }
    } finally {
      await redis.unwatch().catch(() => {});
    }
  } catch {
    // Ignore fallback error - self-healing via next join
  }
  return { newLeaderId: null };
}

/**
 * Get all members of a session as SessionUser objects.
 */
export async function getSessionMembers(redis: Redis, sessionId: string): Promise<SessionUser[]> {
  validateSessionId(sessionId);
  const memberIds = await redis.smembers(KEYS.sessionMembers(sessionId));

  if (memberIds.length === 0) {
    return [];
  }

  const pipeline = redis.pipeline();
  for (const memberId of memberIds) {
    pipeline.hgetall(KEYS.connection(memberId));
  }

  const results = await pipeline.exec();
  const users: SessionUser[] = [];
  const staleMemberIds: string[] = [];

  if (results) {
    for (let i = 0; i < results.length; i++) {
      const [err, data] = results[i] as [Error | null, Record<string, string>];
      if (!err && data && data.connectionId) {
        const connection = hashToConnection(data);
        users.push({
          id: connection.connectionId,
          username: connection.username,
          isLeader: connection.isLeader,
          avatarUrl: connection.avatarUrl || undefined,
        });
      } else if (!err) {
        // Connection hash expired — mark for removal from the session set
        staleMemberIds.push(memberIds[i]);
      }
    }
  }

  // Fire-and-forget cleanup of stale members so the set self-heals on every read
  if (staleMemberIds.length > 0) {
    const cleanupPipeline = redis.pipeline();
    for (const id of staleMemberIds) {
      cleanupPipeline.srem(KEYS.sessionMembers(sessionId), id);
    }
    cleanupPipeline.exec().catch((err) => {
      console.error(
        `[DistributedState] Failed to prune ${staleMemberIds.length} stale members from session ${sessionId.slice(0, 8)}:`,
        err
      );
    });
  }

  return users;
}

/**
 * Get the current leader of a session.
 */
export async function getSessionLeader(redis: Redis, sessionId: string): Promise<string | null> {
  validateSessionId(sessionId);
  return redis.get(KEYS.sessionLeader(sessionId));
}

/**
 * Get count of live members in a session.
 * Filters out stale entries whose connection hashes have expired.
 */
export async function getSessionMemberCount(redis: Redis, sessionId: string): Promise<number> {
  validateSessionId(sessionId);
  const memberIds = await redis.smembers(KEYS.sessionMembers(sessionId));

  if (memberIds.length === 0) {
    return 0;
  }

  const pipeline = redis.pipeline();
  for (const memberId of memberIds) {
    pipeline.exists(KEYS.connection(memberId));
  }

  const results = await pipeline.exec();
  let count = 0;
  if (results) {
    for (const [err, exists] of results) {
      if (!err && exists === 1) {
        count++;
      }
    }
  }
  return count;
}

/**
 * Check if a connection exists and belongs to a specific session.
 */
export async function isConnectionInSession(
  redis: Redis,
  connectionId: string,
  sessionId: string
): Promise<boolean> {
  validateConnectionId(connectionId);
  validateSessionId(sessionId);
  const data = await redis.hgetall(KEYS.connection(connectionId));
  if (!data || !data.connectionId) {
    return false;
  }
  const connection = hashToConnection(data);
  return connection.sessionId === sessionId;
}

/**
 * Refresh connection TTL and session membership TTL atomically.
 */
export async function refreshConnection(redis: Redis, connectionId: string): Promise<boolean> {
  validateConnectionId(connectionId);
  const result = (await redis.eval(
    REFRESH_TTL_SCRIPT,
    1,
    KEYS.connection(connectionId),
    TTL.connection.toString(),
    TTL.sessionMembership.toString()
  )) as number;

  return result === 1;
}

/**
 * Refresh session membership TTL directly (for long-running sessions).
 */
export async function refreshSessionMembership(redis: Redis, sessionId: string): Promise<void> {
  validateSessionId(sessionId);
  await redis.expire(KEYS.sessionMembers(sessionId), TTL.sessionMembership);
}

/**
 * Check if session has any live members.
 */
export async function hasSessionMembers(redis: Redis, sessionId: string): Promise<boolean> {
  const count = await getSessionMemberCount(redis, sessionId);
  return count > 0;
}

/**
 * Prune stale members from a single session.
 * Removes members whose connection hashes have expired from the session set.
 */
export async function cleanupStaleSessionMembers(
  redis: Redis,
  sessionId: string
): Promise<number> {
  validateSessionId(sessionId);
  const removed = (await redis.eval(
    PRUNE_STALE_SESSION_MEMBERS_SCRIPT,
    2,
    KEYS.sessionMembers(sessionId),
    KEYS.sessionLeader(sessionId),
    TTL.sessionMembership.toString()
  )) as number;

  if (removed > 0) {
    console.log(
      `[DistributedState] Pruned ${removed} stale members from session ${sessionId.slice(0, 8)}`
    );
  }
  return removed;
}

/**
 * Clean up session state when it becomes empty.
 */
export async function cleanupEmptySession(redis: Redis, sessionId: string): Promise<void> {
  validateSessionId(sessionId);
  const multi = redis.multi();
  multi.del(KEYS.sessionMembers(sessionId));
  multi.del(KEYS.sessionLeader(sessionId));
  await multi.exec();

  console.log(`[DistributedState] Cleaned up empty session: ${sessionId.slice(0, 8)}`);
}
