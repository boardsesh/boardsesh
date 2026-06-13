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
  ELECT_NEW_LEADER_SCRIPT,
  REFRESH_TTL_SCRIPT,
  PRUNE_STALE_SESSION_MEMBERS_SCRIPT,
  REMOVE_PARTICIPANT_CONNECTION_SCRIPT,
  REMOVE_PARTICIPANT_SCRIPT,
} from './lua-scripts';
import { logger } from '../../utils/logger';

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
 */
export async function leaveSession(
  redis: Redis,
  connectionId: string,
  sessionId: string,
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
): Promise<{ newLeaderId: string | null }> {
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
            logger.info(
              `[DistributedState] Fallback: elected new leader ${newLeaderId.slice(0, 8)} for session ${sessionId.slice(0, 8)}`,
            );
            return { newLeaderId };
          }
        } catch (electionErr) {
          logger.error(`[DistributedState] Fallback leader election failed:`, electionErr);
          await redis.del(KEYS.sessionLeader(sessionId)).catch(() => {});
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
 * Get the current driver (wall-control holder) of a session.
 * Returns the driver's participantId, or null when no member is currently driving.
 */
export async function getSessionDriver(redis: Redis, sessionId: string): Promise<string | null> {
  validateSessionId(sessionId);
  return redis.get(KEYS.sessionDriver(sessionId));
}

/**
 * Set the current driver of a session and return the previous driver atomically.
 * Yank-on-press: overwrites any prior driver. The key expires with the
 * session-membership TTL so it doesn't outlive the session.
 *
 * Returns the previous driver's participantId (or null when unclaimed). The
 * atomicity matters for the `takeControl` resolver: it decides whether to
 * publish `DriverChanged` based on a transition. Reading the previous driver
 * with a separate GET would let two concurrent yanks both observe the same
 * value and both broadcast DriverChanged in arbitrary order, leaving
 * subscribers' state divergent from Redis. Using GETSET + a follow-up EXPIRE
 * keeps the read+write fused (GETSET doesn't accept an inline TTL).
 */
export async function setSessionDriverAndReturnPrevious(
  redis: Redis,
  sessionId: string,
  participantId: string,
): Promise<string | null> {
  validateSessionId(sessionId);
  validateParticipantId(participantId);
  const key = KEYS.sessionDriver(sessionId);
  // SET key value EX <ttl> GET sets the new value, attaches a fresh TTL, and
  // returns the previous value — all in one atomic round-trip. Cheaper and
  // more correct than the prior multi().set().expire() pipeline (which split
  // the set+TTL into two commands and lost any EXPIRE error).
  const prev = await redis.set(key, participantId, 'EX', TTL.sessionMembership, 'GET');
  return prev ?? null;
}

/**
 * Clear the current driver, but only if the caller is the current driver.
 * Returns true when the key was actually deleted (caller was the driver), false otherwise.
 * Uses WATCH + transaction to avoid racing a concurrent take-control.
 */
export async function clearSessionDriverIf(
  redis: Redis,
  sessionId: string,
  expectedParticipantId: string,
): Promise<boolean> {
  validateSessionId(sessionId);
  validateParticipantId(expectedParticipantId);
  const key = KEYS.sessionDriver(sessionId);
  await redis.watch(key);
  // WATCH leaves the connection in a state where the next EXEC observes the
  // watched keys; any throw between WATCH and EXEC/UNWATCH leaks that state to
  // the next caller on the same connection, causing their unrelated MULTI to
  // unexpectedly abort. Wrap the WATCH window in try/catch so a throwing
  // `redis.get` (or anything else mid-flow) always cleans up via UNWATCH.
  // EXEC discards WATCH automatically, so the happy path doesn't double-unwatch.
  try {
    const current = await redis.get(key);
    if (current !== expectedParticipantId) {
      await redis.unwatch();
      return false;
    }
    // result === null indicates a WATCH abort (someone else mutated the key
    // between the GET and EXEC). Treat that as "didn't clear" rather than an
    // error — the take-control race is the expected reason. Any other error
    // propagates so the caller can surface or retry.
    //
    // WATCH only triggers EXEC abort on explicit key mutations, NOT on TTL
    // expiry. If the driver key's TTL expires between GET and EXEC, the
    // transaction still commits but DEL returns 0 (nothing to delete).
    // Check the actual DEL return value (1 if a key was deleted, 0 if not)
    // rather than the transaction-committed-something signal. Otherwise we'd
    // return true and the caller would fire a spurious DriverChanged broadcast.
    const result = await redis.multi().del(key).exec();
    if (result === null) return false;
    const [delErr, delCount] = result[0] as [Error | null, number];
    if (delErr) throw delErr;
    return delCount === 1;
  } catch (err) {
    // Best-effort cleanup; swallow the UNWATCH failure so the original error
    // surfaces (a UNWATCH error on top of e.g. a connection drop is noise).
    await redis.unwatch().catch(() => undefined);
    throw err;
  }
}

/**
 * Claim the wall-connection slot for a board in a session. Claim-if-free
 * (HSETNX): the first connector holds the slot; a later connector to the same
 * board does NOT steal it. Returns the resulting holder and whether THIS call
 * claimed it (so the resolver can gate the WallConnectionChanged broadcast).
 */
export async function claimWallConnection(
  redis: Redis,
  sessionId: string,
  boardId: number,
  participantId: string,
): Promise<{ holderParticipantId: string; didClaim: boolean }> {
  validateSessionId(sessionId);
  validateParticipantId(participantId);
  const key = KEYS.sessionWallConnections(sessionId);
  const field = String(boardId);
  const set = await redis.hsetnx(key, field, participantId);
  await redis.expire(key, TTL.sessionMembership);
  if (set === 1) {
    return { holderParticipantId: participantId, didClaim: true };
  }
  const holder = (await redis.hget(key, field)) ?? participantId;
  return { holderParticipantId: holder, didClaim: false };
}

/**
 * Release a board's wall-connection slot, but only when the caller currently
 * holds it. WATCH-guarded so a concurrent re-claim isn't clobbered. Returns
 * true when the slot was actually freed.
 */
export async function releaseWallConnection(
  redis: Redis,
  sessionId: string,
  boardId: number,
  expectedParticipantId: string,
): Promise<boolean> {
  validateSessionId(sessionId);
  validateParticipantId(expectedParticipantId);
  const key = KEYS.sessionWallConnections(sessionId);
  const field = String(boardId);
  await redis.watch(key);
  try {
    const current = await redis.hget(key, field);
    if (current !== expectedParticipantId) {
      await redis.unwatch();
      return false;
    }
    const result = await redis.multi().hdel(key, field).exec();
    if (result === null) return false;
    const [delErr, delCount] = result[0] as [Error | null, number];
    if (delErr) throw delErr;
    return delCount === 1;
  } catch (err) {
    await redis.unwatch().catch(() => undefined);
    throw err;
  }
}

/** All current wall-connection holders for a session, keyed by boardId. */
export async function getWallConnections(redis: Redis, sessionId: string): Promise<Map<number, string>> {
  validateSessionId(sessionId);
  const raw = await redis.hgetall(KEYS.sessionWallConnections(sessionId));
  const result = new Map<number, string>();
  for (const [field, participantId] of Object.entries(raw)) {
    const boardId = Number(field);
    if (Number.isInteger(boardId) && participantId) {
      result.set(boardId, participantId);
    }
  }
  return result;
}

/**
 * Release every board this participant held the wall connection for (used on
 * disconnect). Returns the boardIds actually freed so the caller can broadcast
 * a WallConnectionChanged(null) per board.
 */
export async function releaseAllWallConnectionsForParticipant(
  redis: Redis,
  sessionId: string,
  participantId: string,
): Promise<number[]> {
  validateSessionId(sessionId);
  validateParticipantId(participantId);
  const held = await getWallConnections(redis, sessionId);
  const released: number[] = [];
  for (const [boardId, holder] of held) {
    if (holder === participantId && (await releaseWallConnection(redis, sessionId, boardId, participantId))) {
      released.push(boardId);
    }
  }
  return released;
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
  // Atomic SET + TTL + previous-value read — see setSessionDriverAndReturnPrevious.
  const prev = await redis.set(key, serial, 'EX', TTL.sessionMembership, 'GET');
  return prev ?? null;
}

/**
 * Push a climbUuid to the per-session recent-climbs ring buffer. Called on
 * every authoritative "current climb" write so confirmClimbOnWall can accept
 * a confirm that arrives after the driver has quickly navigated on. LPUSH +
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
  multi.del(KEYS.sessionDriver(sessionId));
  multi.del(KEYS.sessionBoardSerial(sessionId));
  await multi.exec();

  logger.info(`[DistributedState] Cleaned up empty session: ${sessionId.slice(0, 8)}`);
}
