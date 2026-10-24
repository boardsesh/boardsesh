import type Redis from 'ioredis';
import type { SessionConnectionState, SessionUser } from '@boardsesh/shared-schema';
import {
  KEYS,
  TTL,
  UNSET_SENTINEL,
  RECENT_CLIMBS_BUFFER_SIZE,
  validateBoardSerial,
  validateConnectionId,
  validateParticipantId,
  validateSessionId,
  hashToConnection,
} from './constants';
import {
  JOIN_SESSION_SCRIPT,
  LEAVE_SESSION_SCRIPT,
  REFRESH_TTL_SCRIPT,
  PRUNE_STALE_SESSION_MEMBERS_SCRIPT,
  REMOVE_PARTICIPANT_CONNECTION_SCRIPT,
  REMOVE_PARTICIPANT_SCRIPT,
  MARK_RECONNECTING_IF_IDLE_SCRIPT,
  EVICT_PARTICIPANT_IF_GHOST_SCRIPT,
  CAS_SESSION_REST_CADENCE_SCRIPT,
} from './lua-scripts';
import { electNewLeaderAfterRemoval } from './leader-election';
import { logger } from '../../utils/logger';
import { parseRestCadence, type RestCadenceCasResult, type StoredRestCadence } from '../rest-cadence';

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
    6,
    KEYS.connection(connectionId),
    KEYS.sessionMembers(sessionId),
    KEYS.sessionLeader(sessionId),
    KEYS.sessionParticipants(sessionId),
    KEYS.participant(sessionId, resolvedParticipantId),
    KEYS.participantConnections(sessionId, resolvedParticipantId),
    connectionId,
    sessionId,
    TTL.connection.toString(),
    TTL.sessionMembership.toString(),
    username || UNSET_SENTINEL,
    // Use sentinel when avatarUrl is undefined (not provided), otherwise use actual value
    // This allows empty string to explicitly clear the avatar
    avatarUrl !== undefined ? avatarUrl || '' : UNSET_SENTINEL,
    resolvedParticipantId,
    Date.now().toString(),
  )) as number;

  // -1 means the connection hash was reaped between registerClient and join
  // (TTL expiry, manual cleanup, etc.). The caller has to re-register first;
  // surfacing a typed error lets graphql-yoga return a transient-join error
  // that the client's lifecycle hook already knows how to recover from.
  if (becameLeader === -1) {
    throw new Error(
      `[DistributedState] joinSession refused for ${connectionId.slice(0, 8)}: connection hash missing (reaped). Re-register and retry.`,
    );
  }

  if (becameLeader === 1) {
    logger.info(
      `[DistributedState] Connection ${connectionId.slice(0, 8)} became leader of session ${sessionId.slice(0, 8)}`,
    );
  }

  return { isLeader: becameLeader === 1 };
}

/**
 * Leave a session. Handles leader election if leaving member was leader.
 * Uses atomic Lua script to prevent race conditions.
 * Returns the new leader's connectionId if leadership changed.
 * `newLeaderParticipantId` is only populated on the fallback path, where the
 * election helper already resolved it; the atomic happy path returns just
 * the connectionId and callers resolve the participantId themselves.
 */
export async function leaveSession(
  redis: Redis,
  connectionId: string,
  sessionId: string,
  participantId?: string | null,
): Promise<{ newLeaderId: string | null; newLeaderParticipantId?: string | null }> {
  validateConnectionId(connectionId);
  validateSessionId(sessionId);

  try {
    // Pass the leaving participant's connection set so the election can keep
    // leadership with that participant when it still has a sibling connection
    // (#2135 crit C). '' when no participant identity was supplied — the script
    // then falls back to the plain earliest-connectedAt election.
    const participantConnectionsKey = participantId ? KEYS.participantConnections(sessionId, participantId) : '';
    const result = (await redis.eval(
      LEAVE_SESSION_SCRIPT,
      4,
      KEYS.connection(connectionId),
      KEYS.sessionMembers(sessionId),
      KEYS.sessionLeader(sessionId),
      participantConnectionsKey,
      connectionId,
      TTL.sessionMembership.toString(),
      TTL.sessionMembership.toString(),
    )) as string | null;

    // Participant cleanup intentionally not done here. The explicit-leave
    // caller in `client-lifecycle.ts` follows this call with
    // `removeParticipant`, which evicts the whole participant entry
    // (correct semantics for "user clicked leave" even when they have other
    // tabs open). Doing connection-level cleanup here too would be redundant
    // double-work on every explicit leave.

    // Result: null = wasn't leader, '' = was leader but no new leader, otherwise = new leader ID
    if (result === null) {
      return { newLeaderId: null };
    }

    if (result === '') {
      logger.info(`[DistributedState] Session ${sessionId.slice(0, 8)} has no remaining members after leader left`);
      return { newLeaderId: null };
    }

    logger.info(`[DistributedState] Elected new leader: ${result.slice(0, 8)} for session ${sessionId.slice(0, 8)}`);
    return { newLeaderId: result };
  } catch (err) {
    logger.error(`[DistributedState] Failed to leave session ${sessionId.slice(0, 8)}:`, err);
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
): Promise<{ newLeaderId: string | null; newLeaderParticipantId?: string | null }> {
  try {
    await redis.watch(KEYS.sessionLeader(sessionId));

    try {
      const currentLeader = await redis.get(KEYS.sessionLeader(sessionId));
      const wasLeader = currentLeader === connectionId;

      // Mirror the Lua-side guard: only touch the connection hash if it still
      // exists, otherwise the HMSET would resurrect a zombie key without TTL.
      const connectionExists = (await redis.exists(KEYS.connection(connectionId))) === 1;
      const multi = redis.multi();
      if (connectionExists) {
        multi.hmset(KEYS.connection(connectionId), { sessionId: '', participantId: '', isLeader: 'false' });
      }
      multi.srem(KEYS.sessionMembers(sessionId), connectionId);
      const execResult = await multi.exec();

      if (execResult === null) {
        logger.info(
          `[DistributedState] Fallback aborted: leader changed during cleanup for session ${sessionId.slice(0, 8)}`,
        );
        return { newLeaderId: null };
      }

      if (wasLeader) {
        // Lua first, then a real TS-side election (earliest connectedAt) on
        // failure — previously this fallback only cleared the leader key on
        // failure instead of actually electing someone, unlike the
        // connection-removal path. Unified via electNewLeaderAfterRemoval so
        // both paths behave the same way.
        const { newLeaderId, newLeaderParticipantId } = await electNewLeaderAfterRemoval(
          redis,
          sessionId,
          connectionId,
          'leave-fallback',
        );
        if (newLeaderId) {
          return { newLeaderId, newLeaderParticipantId };
        }
      }
    } finally {
      await redis.unwatch().catch(() => {});
    }
  } catch {
    // Ignore fallback error - self-healing via next join
  }
  // Participant cleanup intentionally not done here; see leaveSession above.
  return { newLeaderId: null };
}

/**
 * Get all members of a session as SessionUser objects.
 */
export async function getSessionMembers(redis: Redis, sessionId: string): Promise<SessionUser[]> {
  validateSessionId(sessionId);
  const memberCleanup = cleanupStaleSessionMembers(redis, sessionId).catch((err) => {
    logger.error(`[DistributedState] Failed to prune stale session members for ${sessionId.slice(0, 8)}:`, err);
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
      logger.error(
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
    cleanup.exec().catch(() => {});
  }

  if (staleConnectionsByParticipant.size > 0) {
    const cleanup = redis.multi();
    for (const [participantId, connectionIds] of staleConnectionsByParticipant) {
      cleanup.srem(KEYS.participantConnections(sessionId, participantId), ...connectionIds);
    }
    cleanup.exec().catch(() => {});
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

/**
 * Outcome of a conditional RECONNECTING mark.
 * - `reconnecting`: the participant was parked in the grace window; `user`
 *   carries the `UserPresenceChanged` payload peers should see.
 * - `has-live`: a reconnect already promoted the participant back to CONNECTED
 *   on another connection — nothing was written and no presence event is owed.
 * - `missing`: the participant hash is gone (already left/expired).
 */
export type ReconnectingMarkResult =
  | { status: 'reconnecting'; user: SessionUser }
  | { status: 'has-live' }
  | { status: 'missing' };

/**
 * Conditionally mark a participant RECONNECTING (passive-disconnect grace),
 * only when it has no live connection. See MARK_RECONNECTING_IF_IDLE_SCRIPT for
 * why the read + write must be atomic (#2135 crit D). On a genuine mark this
 * reads back the participant fields to build the `UserPresenceChanged` payload,
 * matching `markParticipantPresence`'s shape.
 */
export async function markParticipantReconnectingIfIdle(
  redis: Redis,
  sessionId: string,
  participantId: string,
): Promise<ReconnectingMarkResult> {
  validateSessionId(sessionId);
  validateParticipantId(participantId);

  const status = (await redis.eval(
    MARK_RECONNECTING_IF_IDLE_SCRIPT,
    3,
    KEYS.participant(sessionId, participantId),
    KEYS.participantConnections(sessionId, participantId),
    KEYS.sessionParticipants(sessionId),
    Date.now().toString(),
    TTL.sessionMembership.toString(),
  )) as string;

  if (status === 'HAS_LIVE') {
    return { status: 'has-live' };
  }
  if (status !== 'RECONNECTING') {
    return { status: 'missing' };
  }

  const data = await redis.hgetall(KEYS.participant(sessionId, participantId));
  if (!data || !data.participantId) {
    // Raced away between the mark and this read — treat as missing.
    return { status: 'missing' };
  }
  const leaderParticipantId = await getLeaderParticipantId(redis, sessionId);
  return {
    status: 'reconnecting',
    user: {
      id: data.participantId,
      username: data.username || `User-${data.participantId.slice(0, 6)}`,
      isLeader: leaderParticipantId === data.participantId,
      avatarUrl: data.avatarUrl || undefined,
      userId: data.userId || null,
      connectionState: 'RECONNECTING',
    },
  };
}

/**
 * Result of a conditional grace-timer eviction.
 * - `status`: whether the participant was evicted, spared (still has a live
 *   connection / already CONNECTED), or already gone.
 * - `newLeaderId`: connectionId of a leader elected by the SAME transition that
 *   evicted a leader ghost, or null when leadership didn't move.
 */
export type EvictGhostResult = {
  status: 'evicted' | 'has-live' | 'not-reconnecting' | 'missing';
  newLeaderId: string | null;
};

/**
 * Atomically evict a participant ONLY if it's still a ghost (RECONNECTING, zero
 * live connections), re-electing a leader in the same round-trip when the ghost
 * held leadership. See EVICT_PARTICIPANT_IF_GHOST_SCRIPT (#2135 crit B + expiry
 * leader election).
 */
export async function evictGhostParticipant(
  redis: Redis,
  sessionId: string,
  participantId: string,
): Promise<EvictGhostResult> {
  validateSessionId(sessionId);
  validateParticipantId(participantId);

  const result = (await redis.eval(
    EVICT_PARTICIPANT_IF_GHOST_SCRIPT,
    5,
    KEYS.sessionParticipants(sessionId),
    KEYS.participant(sessionId, participantId),
    KEYS.participantConnections(sessionId, participantId),
    KEYS.sessionMembers(sessionId),
    KEYS.sessionLeader(sessionId),
    participantId,
    TTL.sessionMembership.toString(),
  )) as [string, string];

  const [status, newLeaderId] = result;
  const mapped: EvictGhostResult['status'] =
    status === 'EVICTED'
      ? 'evicted'
      : status === 'HAS_LIVE'
        ? 'has-live'
        : status === 'NOT_RECONNECTING'
          ? 'not-reconnecting'
          : 'missing';
  return { status: mapped, newLeaderId: newLeaderId ? newLeaderId : null };
}

export async function removeParticipantConnection(
  redis: Redis,
  sessionId: string,
  participantId: string,
  connectionId: string,
): Promise<void> {
  // Atomic SREM-then-conditional-cleanup. The previous srem -> smembers ->
  // multi().exec() sequence had a window where a concurrent re-join could add
  // a new connection to the set after our smembers read 0, then the multi
  // would wipe out that fresh participant. The Lua script collapses the read
  // and delete into a single atomic operation.
  await redis.eval(
    REMOVE_PARTICIPANT_CONNECTION_SCRIPT,
    3,
    KEYS.participantConnections(sessionId, participantId),
    KEYS.sessionParticipants(sessionId),
    KEYS.participant(sessionId, participantId),
    connectionId,
    participantId,
  );
}

export async function removeParticipant(redis: Redis, sessionId: string, participantId: string): Promise<void> {
  validateSessionId(sessionId);
  validateParticipantId(participantId);
  // Atomic via Lua. The prior `smembers` -> `multi().exec()` sequence had a
  // race window where a concurrent join (cross-instance, e.g. another tab
  // reconnecting in the grace window) could insert a fresh connection into
  // participantConnections between the snapshot and the multi's `del`, and
  // its participant hash would be wiped after this multi ran.
  await redis.eval(
    REMOVE_PARTICIPANT_SCRIPT,
    4,
    KEYS.sessionParticipants(sessionId),
    KEYS.participant(sessionId, participantId),
    KEYS.participantConnections(sessionId, participantId),
    KEYS.sessionMembers(sessionId),
    participantId,
  );
}

/**
 * Get the current leader of a session.
 */
export async function getSessionLeader(redis: Redis, sessionId: string): Promise<string | null> {
  validateSessionId(sessionId);
  return redis.get(KEYS.sessionLeader(sessionId));
}

/**
 * Get the last-connected BLE board serial for a session, or null when unset.
 */
export async function getSessionBoardSerial(redis: Redis, sessionId: string): Promise<string | null> {
  validateSessionId(sessionId);
  return redis.get(KEYS.sessionBoardSerial(sessionId));
}

/**
 * Set the session's last-connected BLE board serial.
 *
 * Returns the previous value atomically (via SET ... GET, pipelined with EXPIRE
 * to keep the TTL aligned with session membership). The atomic previous-value
 * read lets the caller decide whether to broadcast `SessionBoardSerialChanged`
 * — concurrent writes from two participants pairing at the same time both see
 * a consistent prior value, so only the actual transition fires the event.
 */
export async function setSessionBoardSerialAndReturnPrevious(
  redis: Redis,
  sessionId: string,
  serial: string,
): Promise<string | null> {
  validateSessionId(sessionId);
  validateBoardSerial(serial);
  const key = KEYS.sessionBoardSerial(sessionId);
  // Atomic SET + TTL + previous-value read in one round-trip (SET ... EX ... GET).
  const prev = await redis.set(key, serial, 'EX', TTL.sessionMembership, 'GET');
  return prev ?? null;
}

/**
 * Read the session's shared rest clock. A missing hash is revision 0, clock off.
 */
export async function getSessionRestCadence(redis: Redis, sessionId: string): Promise<StoredRestCadence> {
  validateSessionId(sessionId);
  const [storedRevision, storedDoc] = await redis.hmget(KEYS.sessionRestCadence(sessionId), 'rev', 'doc');
  const revision = Number.parseInt(storedRevision ?? '0', 10);
  return { revision: Number.isFinite(revision) ? revision : 0, cadence: parseRestCadence(storedDoc) };
}

/**
 * Compare-and-set the session's shared rest clock: writes `nextDoc` at
 * max(`expectedRevision` + 1, `minimumRevision`) only when the stored revision
 * still equals `expectedRevision`, and refreshes the hash's TTL whether it
 * commits or loses. See CAS_SESSION_REST_CADENCE_SCRIPT.
 */
export async function casSessionRestCadence(
  redis: Redis,
  sessionId: string,
  expectedRevision: number,
  nextDoc: string,
  minimumRevision: number,
): Promise<RestCadenceCasResult> {
  validateSessionId(sessionId);
  const reply: unknown = await redis.eval(
    CAS_SESSION_REST_CADENCE_SCRIPT,
    1,
    KEYS.sessionRestCadence(sessionId),
    expectedRevision.toString(),
    nextDoc,
    TTL.sessionMembership.toString(),
    minimumRevision.toString(),
  );
  // ioredis maps a nil bulk string to null; the script never returns one today,
  // so a malformed reply is a script regression and must not reach parsing.
  if (
    !Array.isArray(reply) ||
    reply.length !== 3 ||
    typeof reply[0] !== 'number' ||
    typeof reply[1] !== 'number' ||
    typeof reply[2] !== 'string'
  ) {
    throw new Error('Unexpected reply from the rest cadence CAS script');
  }
  const [committed, revision, doc] = reply as [number, number, string];
  return { ok: committed === 1, revision, doc };
}

/**
 * Push a climbUuid to the per-session recent-climbs ring buffer. Called on
 * every authoritative "current climb" write so confirmClimbOnWall can accept
 * a confirm that arrives after a member has quickly navigated on. LPUSH +
 * LTRIM keeps the buffer bounded; EXPIRE aligns lifetime with session
 * membership so the key doesn't outlive its session.
 *
 * Non-empty climbUuid only — clearing the wall (item: null) does not record
 * an entry. We don't validate climbUuid format here beyond emptiness because
 * the resolver layer (ClimbUuidSchema) already gates input shape.
 */
export async function pushRecentClimb(redis: Redis, sessionId: string, climbUuid: string): Promise<void> {
  validateSessionId(sessionId);
  if (!climbUuid) return;
  const key = KEYS.sessionRecentClimbs(sessionId);
  await redis
    .multi()
    .lpush(key, climbUuid)
    .ltrim(key, 0, RECENT_CLIMBS_BUFFER_SIZE - 1)
    .expire(key, TTL.sessionMembership)
    .exec();
}

/**
 * Check whether a climbUuid is in the per-session recent-climbs ring buffer.
 * Used by confirmClimbOnWall to accept confirms within a small navigation
 * race window without admitting arbitrary stale or forged UUIDs.
 */
export async function isRecentClimb(redis: Redis, sessionId: string, climbUuid: string): Promise<boolean> {
  validateSessionId(sessionId);
  if (!climbUuid) return false;
  const recent = await redis.lrange(KEYS.sessionRecentClimbs(sessionId), 0, -1);
  return recent.includes(climbUuid);
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
 * Count the distinct live participants in a session (deduped by participant
 * identity, so one authenticated user with several tabs/reconnects counts once).
 *
 * Use this for anything user-facing (discovery lists, "N climbers here"). It is
 * NOT interchangeable with `getSessionMemberCount`, which counts live
 * *connections* — that connection count backs liveness checks whose `0 ⟺ no
 * live connections` contract must hold during the RECONNECTING grace window.
 *
 * Deliberately a full `getSessionMembers` fetch rather than an O(1)
 * `SCARD(sessionParticipants)`: `getSessionMembers` prunes participants whose
 * hash has expired but whose id lingers in the `sessionParticipants` set (a
 * TTL race the sweep hasn't caught yet). `SCARD` would count those stale ids,
 * re-introducing a smaller version of the ghost inflation this path exists to
 * avoid. The extra hash reads run only on discovery/display queries, not a hot
 * loop, so the accuracy is worth the cost.
 */
export async function getSessionParticipantCount(redis: Redis, sessionId: string): Promise<number> {
  validateSessionId(sessionId);
  return (await getSessionMembers(redis, sessionId)).length;
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
    logger.info(`[DistributedState] Pruned ${removed} stale members from session ${sessionId.slice(0, 8)}`);
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
  multi.del(KEYS.sessionBoardSerial(sessionId));
  multi.del(KEYS.sessionRestCadence(sessionId));
  await multi.exec();

  logger.info(`[DistributedState] Cleaned up empty session: ${sessionId.slice(0, 8)}`);
}
