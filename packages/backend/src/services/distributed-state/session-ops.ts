import type Redis from 'ioredis';
import type { SessionConnectionState, SessionUser } from '@boardsesh/shared-schema';
import {
  KEYS,
  TTL,
  UNSET_SENTINEL,
  validateConnectionId,
  validateParticipantId,
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
  avatarUrl?: string | null,
  participantId?: string | null,
): Promise<{ isLeader: boolean }> {
  validateConnectionId(connectionId);
  validateSessionId(sessionId);
  const resolvedParticipantId = participantId || connectionId;
  validateParticipantId(resolvedParticipantId);

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
    avatarUrl !== undefined ? avatarUrl || '' : UNSET_SENTINEL,
  )) as number;

  if (becameLeader === 1) {
    console.info(
      `[DistributedState] Connection ${connectionId.slice(0, 8)} became leader of session ${sessionId.slice(0, 8)}`,
    );
  }

  const connection = hashToConnection(await redis.hgetall(KEYS.connection(connectionId)));
  const resolvedUsername = username || connection.username;
  const resolvedAvatarUrl = avatarUrl !== undefined ? avatarUrl || null : connection.avatarUrl;
  const now = Date.now().toString();

  const participantKey = KEYS.participant(sessionId, resolvedParticipantId);
  const participantConnectionsKey = KEYS.participantConnections(sessionId, resolvedParticipantId);
  const multi = redis.multi();
  multi.hset(KEYS.connection(connectionId), 'participantId', resolvedParticipantId);
  multi.sadd(KEYS.sessionParticipants(sessionId), resolvedParticipantId);
  multi.expire(KEYS.sessionParticipants(sessionId), TTL.sessionMembership);
  multi.hmset(participantKey, {
    participantId: resolvedParticipantId,
    sessionId,
    userId: connection.userId || '',
    username: resolvedUsername,
    avatarUrl: resolvedAvatarUrl || '',
    connectionState: 'CONNECTED',
    lastSeenAt: now,
  });
  multi.expire(participantKey, TTL.sessionMembership);
  multi.sadd(participantConnectionsKey, connectionId);
  multi.expire(participantConnectionsKey, TTL.sessionMembership);
  await multi.exec();

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
  sessionId: string,
): Promise<{ newLeaderId: string | null }> {
  validateConnectionId(connectionId);
  validateSessionId(sessionId);
  const connection = await getConnectionForParticipantCleanup(redis, connectionId);

  try {
    const result = (await redis.eval(
      LEAVE_SESSION_SCRIPT,
      3,
      KEYS.connection(connectionId),
      KEYS.sessionMembers(sessionId),
      KEYS.sessionLeader(sessionId),
      connectionId,
      TTL.sessionMembership.toString(),
      TTL.sessionMembership.toString(),
    )) as string | null;

    if (connection?.participantId) {
      await removeParticipantConnection(redis, sessionId, connection.participantId, connectionId);
    }

    // Result: null = wasn't leader, '' = was leader but no new leader, otherwise = new leader ID
    if (result === null) {
      return { newLeaderId: null };
    }

    if (result === '') {
      console.info(`[DistributedState] Session ${sessionId.slice(0, 8)} has no remaining members after leader left`);
      return { newLeaderId: null };
    }

    console.info(`[DistributedState] Elected new leader: ${result.slice(0, 8)} for session ${sessionId.slice(0, 8)}`);
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
  sessionId: string,
): Promise<{ newLeaderId: string | null }> {
  const connection = await getConnectionForParticipantCleanup(redis, connectionId);
  try {
    await redis.watch(KEYS.sessionLeader(sessionId));

    try {
      const currentLeader = await redis.get(KEYS.sessionLeader(sessionId));
      const wasLeader = currentLeader === connectionId;

      const multi = redis.multi();
      multi.hmset(KEYS.connection(connectionId), { sessionId: '', participantId: '', isLeader: 'false' });
      multi.srem(KEYS.sessionMembers(sessionId), connectionId);
      const execResult = await multi.exec();

      if (execResult === null) {
        console.info(
          `[DistributedState] Fallback aborted: leader changed during cleanup for session ${sessionId.slice(0, 8)}`,
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
            TTL.sessionMembership.toString(),
          )) as string | null;

          if (newLeaderId) {
            console.info(
              `[DistributedState] Fallback: elected new leader ${newLeaderId.slice(0, 8)} for session ${sessionId.slice(0, 8)}`,
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
  } finally {
    if (connection?.participantId) {
      await removeParticipantConnection(redis, sessionId, connection.participantId, connectionId).catch(() => {});
    }
  }
  return { newLeaderId: null };
}

/**
 * Get all members of a session as SessionUser objects.
 */
export async function getSessionMembers(redis: Redis, sessionId: string): Promise<SessionUser[]> {
  validateSessionId(sessionId);
  const memberCleanup = cleanupStaleSessionMembers(redis, sessionId).catch((err) => {
    console.error(`[DistributedState] Failed to prune stale session members for ${sessionId.slice(0, 8)}:`, err);
  });

  const participantIds = await redis.smembers(KEYS.sessionParticipants(sessionId));
  if (participantIds.length > 0) {
    const users = await getSessionParticipants(redis, sessionId, participantIds);
    await memberCleanup;
    return users;
  }

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
          userId: connection.userId,
          connectionState: 'CONNECTED',
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
        err,
      );
    });
  }

  return users;
}

async function getSessionParticipants(
  redis: Redis,
  sessionId: string,
  participantIds: string[],
): Promise<SessionUser[]> {
  const pipeline = redis.pipeline();
  for (const participantId of participantIds) {
    pipeline.hgetall(KEYS.participant(sessionId, participantId));
  }
  const results = await pipeline.exec();

  const leaderParticipantId = await getLeaderParticipantId(redis, sessionId);
  const participantConnectionIds = await getParticipantConnectionIds(redis, sessionId, participantIds);
  const connectionData = await getParticipantConnectionData(redis, participantConnectionIds);

  const users: SessionUser[] = [];
  const staleParticipantIds: string[] = [];
  const staleConnectionsByParticipant = new Map<string, string[]>();

  if (results) {
    for (let i = 0; i < results.length; i++) {
      const [err, data] = results[i] as [Error | null, Record<string, string>];
      const participantId = participantIds[i];
      if (err || !data || !data.participantId) {
        if (!err) staleParticipantIds.push(participantId);
        continue;
      }

      const liveConnections = getLiveConnectionsForParticipant(
        sessionId,
        participantId,
        participantConnectionIds.get(participantId) ?? [],
        connectionData,
        staleConnectionsByParticipant,
      );

      if (data.connectionState !== 'RECONNECTING' && liveConnections.length === 0) {
        staleParticipantIds.push(participantId);
        continue;
      }

      const connectionState =
        data.connectionState === 'RECONNECTING' && liveConnections.length === 0
          ? ('RECONNECTING' as const)
          : ('CONNECTED' as const);

      users.push({
        id: data.participantId,
        username: data.username || `User-${data.participantId.slice(0, 6)}`,
        isLeader: leaderParticipantId === data.participantId,
        avatarUrl: data.avatarUrl || undefined,
        userId: data.userId || null,
        connectionState,
      });
    }
  }

  if (staleParticipantIds.length > 0) {
    const cleanup = redis.multi();
    cleanup.srem(KEYS.sessionParticipants(sessionId), ...staleParticipantIds);
    for (const participantId of staleParticipantIds) {
      cleanup.del(KEYS.participant(sessionId, participantId));
      cleanup.del(KEYS.participantConnections(sessionId, participantId));
    }
    cleanup.exec().catch((err) => {
      console.error(
        `[DistributedState] Failed to clean up ${staleParticipantIds.length} stale participant(s) for session ${sessionId}:`,
        err,
      );
    });
  }

  if (staleConnectionsByParticipant.size > 0) {
    const cleanup = redis.multi();
    let staleConnectionCount = 0;
    for (const [participantId, connectionIds] of staleConnectionsByParticipant) {
      cleanup.srem(KEYS.participantConnections(sessionId, participantId), ...connectionIds);
      staleConnectionCount += connectionIds.length;
    }
    cleanup.exec().catch((err) => {
      console.error(
        `[DistributedState] Failed to clean up ${staleConnectionCount} stale connection(s) across ${staleConnectionsByParticipant.size} participant(s) for session ${sessionId}:`,
        err,
      );
    });
  }

  return users;
}

async function getParticipantConnectionIds(
  redis: Redis,
  sessionId: string,
  participantIds: string[],
): Promise<Map<string, string[]>> {
  const pipeline = redis.pipeline();
  for (const participantId of participantIds) {
    pipeline.smembers(KEYS.participantConnections(sessionId, participantId));
  }
  const results = await pipeline.exec();
  const connectionIdsByParticipant = new Map<string, string[]>();

  if (results) {
    for (let i = 0; i < results.length; i++) {
      const [err, connectionIds] = results[i] as [Error | null, string[]];
      connectionIdsByParticipant.set(participantIds[i], err || !connectionIds ? [] : connectionIds);
    }
  }
  return connectionIdsByParticipant;
}

async function getParticipantConnectionData(
  redis: Redis,
  connectionIdsByParticipant: Map<string, string[]>,
): Promise<Map<string, ReturnType<typeof hashToConnection> | null>> {
  const uniqueConnectionIds = Array.from(new Set(Array.from(connectionIdsByParticipant.values()).flat()));
  const connectionData = new Map<string, ReturnType<typeof hashToConnection> | null>();
  if (uniqueConnectionIds.length === 0) {
    return connectionData;
  }

  const pipeline = redis.pipeline();
  for (const id of uniqueConnectionIds) {
    pipeline.hgetall(KEYS.connection(id));
  }
  const results = await pipeline.exec();
  if (results) {
    for (let i = 0; i < results.length; i++) {
      const [err, data] = results[i] as [Error | null, Record<string, string>];
      connectionData.set(uniqueConnectionIds[i], !err && data?.connectionId ? hashToConnection(data) : null);
    }
  }
  return connectionData;
}

function getLiveConnectionsForParticipant(
  sessionId: string,
  participantId: string,
  connectionIds: string[],
  connectionData: Map<string, ReturnType<typeof hashToConnection> | null>,
  staleConnectionsByParticipant: Map<string, string[]>,
): string[] {
  const liveConnectionIds: string[] = [];

  for (const connectionId of connectionIds) {
    const connection = connectionData.get(connectionId) ?? null;
    if (connection?.sessionId === sessionId && connection.participantId === participantId) {
      liveConnectionIds.push(connectionId);
    } else {
      const stale = staleConnectionsByParticipant.get(participantId) ?? [];
      stale.push(connectionId);
      staleConnectionsByParticipant.set(participantId, stale);
    }
  }
  return liveConnectionIds;
}

async function getLeaderParticipantId(redis: Redis, sessionId: string): Promise<string | null> {
  const leaderConnectionId = await getSessionLeader(redis, sessionId);
  if (!leaderConnectionId) return null;
  const leaderData = await redis.hgetall(KEYS.connection(leaderConnectionId));
  if (!leaderData?.connectionId) return null;
  return hashToConnection(leaderData).participantId;
}

export async function markParticipantPresence(
  redis: Redis,
  sessionId: string,
  participantId: string,
  connectionState: SessionConnectionState,
): Promise<SessionUser | null> {
  validateSessionId(sessionId);
  validateParticipantId(participantId);
  const key = KEYS.participant(sessionId, participantId);
  const data = await redis.hgetall(key);
  if (!data || !data.participantId) {
    return null;
  }

  await redis
    .multi()
    .hset(key, 'connectionState', connectionState, 'lastSeenAt', Date.now().toString())
    .expire(key, TTL.sessionMembership)
    .expire(KEYS.sessionParticipants(sessionId), TTL.sessionMembership)
    .exec();

  const leaderParticipantId = await getLeaderParticipantId(redis, sessionId);

  return {
    id: data.participantId,
    username: data.username || `User-${data.participantId.slice(0, 6)}`,
    isLeader: leaderParticipantId === data.participantId,
    avatarUrl: data.avatarUrl || undefined,
    userId: data.userId || null,
    connectionState,
  };
}

async function getConnectionForParticipantCleanup(
  redis: Redis,
  connectionId: string,
): Promise<ReturnType<typeof hashToConnection> | null> {
  const data = await redis.hgetall(KEYS.connection(connectionId));
  if (!data?.connectionId) return null;
  return hashToConnection(data);
}

async function removeParticipantConnection(
  redis: Redis,
  sessionId: string,
  participantId: string,
  connectionId: string,
): Promise<void> {
  await redis.srem(KEYS.participantConnections(sessionId, participantId), connectionId);
  const remainingIds = await redis.smembers(KEYS.participantConnections(sessionId, participantId));
  if (remainingIds.length > 0) {
    return;
  }

  await redis
    .multi()
    .srem(KEYS.sessionParticipants(sessionId), participantId)
    .del(KEYS.participant(sessionId, participantId))
    .del(KEYS.participantConnections(sessionId, participantId))
    .exec();
}

export async function removeParticipant(redis: Redis, sessionId: string, participantId: string): Promise<void> {
  validateSessionId(sessionId);
  validateParticipantId(participantId);
  const connectionIds = await redis.smembers(KEYS.participantConnections(sessionId, participantId));
  const multi = redis.multi();
  multi.srem(KEYS.sessionParticipants(sessionId), participantId);
  multi.del(KEYS.participant(sessionId, participantId));
  multi.del(KEYS.participantConnections(sessionId, participantId));
  for (const connectionId of connectionIds) {
    multi.srem(KEYS.sessionMembers(sessionId), connectionId);
    multi.hset(KEYS.connection(connectionId), 'sessionId', '', 'participantId', '', 'isLeader', 'false');
  }
  await multi.exec();
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
export async function isConnectionInSession(redis: Redis, connectionId: string, sessionId: string): Promise<boolean> {
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
    TTL.sessionMembership.toString(),
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
export async function cleanupStaleSessionMembers(redis: Redis, sessionId: string): Promise<number> {
  validateSessionId(sessionId);
  const removed = (await redis.eval(
    PRUNE_STALE_SESSION_MEMBERS_SCRIPT,
    2,
    KEYS.sessionMembers(sessionId),
    KEYS.sessionLeader(sessionId),
    TTL.sessionMembership.toString(),
  )) as number;

  if (removed > 0) {
    console.info(`[DistributedState] Pruned ${removed} stale members from session ${sessionId.slice(0, 8)}`);
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

  console.info(`[DistributedState] Cleaned up empty session: ${sessionId.slice(0, 8)}`);
}
