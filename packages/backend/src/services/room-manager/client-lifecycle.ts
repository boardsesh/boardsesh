import type { ClimbQueueItem, SessionUser } from '@boardsesh/shared-schema';
import { db } from '../../db/client';
import { sessions, boardSessionParticipants, type Session } from '../../db/schema';
import type { RedisSessionStore } from '../redis-session-store';
import type { DistributedStateManager } from '../distributed-state';
import type { ConnectedClient, LocalSessionParticipant } from './types';
import { restoreSessionWithLock } from './session-restoration';
import type { WriteScheduler } from './write-scheduler';
import { logger } from '../../utils/logger';

/**
 * Register a new client connection.
 */
export async function registerClient(
  connectionId: string,
  clients: Map<string, ConnectedClient>,
  distributedState: DistributedStateManager | null,
  username?: string,
  userId?: string,
  avatarUrl?: string,
): Promise<string> {
  const defaultUsername = username || `User-${connectionId.substring(0, 6)}`;
  clients.set(connectionId, {
    connectionId,
    sessionId: null,
    participantId: null,
    userId: userId || null,
    username: defaultUsername,
    isLeader: false,
    connectedAt: new Date(),
    avatarUrl,
  });

  if (distributedState) {
    try {
      await distributedState.registerConnection(connectionId, defaultUsername, userId, avatarUrl);
    } catch (err) {
      clients.delete(connectionId);
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      logger.error(`[RoomManager] Failed to register connection in distributed state: ${errorMessage}`);
      throw new Error(`Failed to register client: distributed state error`);
    }
  }

  return connectionId;
}

/**
 * Join a session - handles restoration, leader election, and initial state setup.
 */
export async function joinSession(
  connectionId: string,
  sessionId: string,
  boardPath: string,
  clients: Map<string, ConnectedClient>,
  sessionsMap: Map<string, Set<string>>,
  sessionParticipants: Map<string, Map<string, LocalSessionParticipant>>,
  redisStore: RedisSessionStore | null,
  distributedState: DistributedStateManager | null,
  writeScheduler: WriteScheduler,
  sessionGraceTimers: Map<string, NodeJS.Timeout>,
  pendingJoinPersists: Map<string, Promise<void>>,
  getQueueStateFn: (sessionId: string) => Promise<{
    queue: ClimbQueueItem[];
    currentClimbQueueItem: ClimbQueueItem | null;
    version: number;
    sequence: number;
    stateHash: string;
  }>,
  getSessionUsers: (sessionId: string) => Promise<SessionUser[]>,
  getSessionUsersLocal: (sessionId: string) => SessionUser[],
  getSessionById: (sessionId: string) => Promise<Session | null>,
  updateQueueStateImmediate: (
    sessionId: string,
    queue: ClimbQueueItem[],
    currentClimbQueueItem: ClimbQueueItem | null,
    expectedVersion?: number,
  ) => Promise<number>,
  leaveSessionFn: (connectionId: string) => Promise<SessionLeaveResult | null>,
  username?: string,
  avatarUrl?: string,
  initialQueue?: ClimbQueueItem[],
  initialCurrentClimb?: ClimbQueueItem | null,
  sessionName?: string,
  participantId?: string | null,
): Promise<{
  clientId: string;
  users: SessionUser[];
  queue: ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
  sequence: number;
  stateHash: string;
  isLeader: boolean;
  sessionName: string | null;
  participantId: string;
  participantWasKnown: boolean;
  participantWasReconnecting: boolean;
}> {
  const client = clients.get(connectionId);
  if (!client) {
    throw new Error('Client not registered');
  }
  // SECURITY: Never trust a client-supplied participantId. SessionUser.id is
  // broadcast to every peer in the session, so accepting an arbitrary
  // participantId here lets any member impersonate any other participant
  // (including the leader, since leadership checks key off participant
  // identity). For authenticated users we bind to their verified userId. For
  // anonymous users we use the connectionId; reconnection across WebSocket
  // drops then appears as a fresh participant (UserLeft + UserJoined) — that's
  // the correct trade-off because anonymous reconnects have no proof of
  // identity. The `participantId` parameter is accepted for API stability but
  // intentionally ignored.
  void participantId;
  const resolvedParticipantId = client.userId || connectionId;

  // Leave current session if in one
  if (client.sessionId) {
    await leaveSessionFn(connectionId);
  }

  // Update client info
  client.sessionId = sessionId;
  client.participantId = resolvedParticipantId;
  if (username) {
    client.username = username;
  }
  if (avatarUrl) {
    client.avatarUrl = avatarUrl;
  }

  // Track if this is a new session
  let isNewSession = false;

  // Cancel grace timer if session exists locally (client reconnecting during grace period)
  const graceTimer = sessionGraceTimers.get(sessionId);
  if (graceTimer) {
    clearTimeout(graceTimer);
    sessionGraceTimers.delete(sessionId);
    logger.info(`[RoomManager] Cancelled grace timer for session ${sessionId} (client reconnecting)`);
  }

  // Create or get session in memory - with lazy restore
  if (!sessionsMap.has(sessionId)) {
    if (redisStore) {
      isNewSession = await restoreSessionWithLock(sessionId, sessionsMap, redisStore, getSessionById);
      if (isNewSession) {
        logger.info(
          `[RoomManager] Creating new session ${sessionId} with ${initialQueue?.length || 0} initial queue items`,
        );
      }
    } else {
      // No Redis, check Postgres directly for session existence
      const pgSession = await getSessionById(sessionId);
      if (!pgSession || pgSession.status === 'ended') {
        isNewSession = true;
        logger.info(
          `[RoomManager] Creating new session ${sessionId} with ${initialQueue?.length || 0} initial queue items`,
        );
      }
      sessionsMap.set(sessionId, new Set());
    }
  }
  const sessionClientIds = sessionsMap.get(sessionId)!;

  // Determine leader status
  let isLeader: boolean;

  if (distributedState) {
    const result = await distributedState.joinSession(
      connectionId,
      sessionId,
      client.username,
      client.avatarUrl,
      resolvedParticipantId,
    );
    isLeader = result.isLeader;
  } else {
    isLeader = sessionClientIds.size === 0;
  }

  client.isLeader = isLeader;
  sessionClientIds.add(connectionId);
  const participantStatus = upsertLocalParticipant(
    sessionId,
    resolvedParticipantId,
    client,
    isLeader,
    sessionParticipants,
  );

  // Ensure new sessions exist in Postgres before any queue state persists.
  // Existing sessions stay Redis-only for join/leave activity.
  if (isNewSession) {
    const previous = pendingJoinPersists.get(sessionId) ?? Promise.resolve();
    const chained = previous.then(() => ensureSessionRecordExists(sessionId, boardPath, client.userId, sessionName));

    pendingJoinPersists.set(sessionId, chained);
    try {
      await chained;
    } finally {
      if (pendingJoinPersists.get(sessionId) === chained) {
        pendingJoinPersists.delete(sessionId);
      }
    }
  }

  // Record the authenticated user as a permanent participant in this session.
  // Used by the push-token resolver to authorize Live Activity registrations.
  // Idempotent on (session_id, user_id) primary key.
  if (client.userId) {
    try {
      await db.insert(boardSessionParticipants).values({ sessionId, userId: client.userId }).onConflictDoNothing();
    } catch (err) {
      logger.error(`[joinSession] Failed to record participant for ${sessionId}:`, err);
    }
  }

  // Initialize queue state for new sessions with provided initial queue
  if (isNewSession && initialQueue && initialQueue.length > 0) {
    logger.info(`[RoomManager] Initializing queue for new session ${sessionId} with ${initialQueue.length} items`);
    await updateQueueStateImmediate(sessionId, initialQueue, initialCurrentClimb || null, 0);
  }

  // Update Redis session state
  if (redisStore) {
    await Promise.all([redisStore.markActive(sessionId), redisStore.refreshTTL(sessionId)]);

    if (!distributedState) {
      const users = getSessionUsersLocal(sessionId);
      await redisStore.saveUsers(sessionId, users);
    }
  }

  // Get current session state
  const [users, queueState, sessionData] = await Promise.all([
    getSessionUsers(sessionId),
    getQueueStateFn(sessionId),
    getSessionById(sessionId),
  ]);
  const resolvedSessionName = sessionData?.name || null;

  return {
    clientId: connectionId,
    users,
    queue: queueState.queue,
    currentClimbQueueItem: queueState.currentClimbQueueItem,
    sequence: queueState.sequence,
    stateHash: queueState.stateHash,
    isLeader,
    sessionName: resolvedSessionName,
    participantId: resolvedParticipantId,
    participantWasKnown: participantStatus.wasKnown,
    participantWasReconnecting: participantStatus.wasReconnecting,
  };
}

/**
 * Leave a session - handles leader re-election and cleanup.
 */
export async function leaveSession(
  connectionId: string,
  clients: Map<string, ConnectedClient>,
  sessionsMap: Map<string, Set<string>>,
  sessionParticipants: Map<string, Map<string, LocalSessionParticipant>>,
  redisStore: RedisSessionStore | null,
  distributedState: DistributedStateManager | null,
  writeScheduler: WriteScheduler,
  sessionGraceTimers: Map<string, NodeJS.Timeout>,
  pendingJoinPersists: Map<string, Promise<void>>,
  SESSION_GRACE_PERIOD_MS: number,
): Promise<SessionLeaveResult | null> {
  const client = clients.get(connectionId);
  if (!client || !client.sessionId) {
    return null;
  }

  const sessionId = client.sessionId;
  const participantId = client.participantId || connectionId;
  const wasLeader = client.isLeader;

  const sessionClientIds = sessionsMap.get(sessionId);
  let wentLocallyEmpty = false;
  if (sessionClientIds) {
    sessionClientIds.delete(connectionId);
    wentLocallyEmpty = sessionClientIds.size === 0;
  }

  if (wentLocallyEmpty) {
    const existingGraceTimer = sessionGraceTimers.get(sessionId);
    if (existingGraceTimer) clearTimeout(existingGraceTimer);

    const timer = setTimeout(() => {
      const currentClients = sessionsMap.get(sessionId);
      if (currentClients && currentClients.size === 0) {
        sessionsMap.delete(sessionId);
        logger.info(`[RoomManager] Session ${sessionId} removed from memory after grace period`);
      }
      sessionGraceTimers.delete(sessionId);
    }, SESSION_GRACE_PERIOD_MS);
    sessionGraceTimers.set(sessionId, timer);
  }

  // Reset client state
  client.sessionId = null;
  client.participantId = null;
  client.isLeader = false;

  // Elect new leader. This also atomically removes our connection from
  // distributed state, so the post-leave membership re-check below sees
  // an accurate global view.
  //
  // Multi-tab handling: an authenticated user opening the same session in
  // two tabs shares one `participantId` (their userId). Clicking "Leave" on
  // one tab must NOT wipe the other tab's participant entry. We drop only
  // this connection from the participant and let the entry persist if any
  // sibling connection remains. The participant is fully torn down only
  // when its connection set hits zero.
  const participants = sessionParticipants.get(sessionId);
  const participant = participants?.get(participantId);
  let participantBecameEmpty = false;
  if (participant) {
    participant.connectionIds.delete(connectionId);
    if (participant.connectionIds.size === 0) {
      if (participant.reconnectTimer) {
        clearTimeout(participant.reconnectTimer);
      }
      participants?.delete(participantId);
      if (participants?.size === 0) {
        sessionParticipants.delete(sessionId);
      }
      participantBecameEmpty = true;
    }
  } else {
    // Local view doesn't know this participant; treat as drained.
    participantBecameEmpty = true;
  }
  let newLeaderId: string | undefined;
  let newLeaderParticipantId: string | undefined;

  if (distributedState) {
    const result = await distributedState.leaveSession(connectionId, sessionId);
    if (result.newLeaderId) {
      newLeaderId = result.newLeaderId;
      newLeaderParticipantId = await resolveLeaderParticipantId(newLeaderId, clients, distributedState);
      const localNewLeader = clients.get(newLeaderId);
      if (localNewLeader) {
        localNewLeader.isLeader = true;
      }
    }
    if (participantBecameEmpty) {
      // No more connections for this participant — tear down the participant
      // entry and broadcast UserLeft to peers.
      await distributedState.removeParticipant(sessionId, participantId);
    } else {
      // Sibling tab still in the session — only detach this connection.
      // `removeParticipantConnection` is atomic via Lua: SREM the connection
      // from the participant's set; if the set just hit zero, delete the
      // participant entry.
      await distributedState.removeParticipantConnection(sessionId, participantId, connectionId);
    }
  } else if (wasLeader && sessionClientIds && sessionClientIds.size > 0) {
    const clientsArray = Array.from(sessionClientIds)
      .map((id) => clients.get(id))
      .filter((c): c is ConnectedClient => c !== undefined)
      .sort((a, b) => a.connectedAt.getTime() - b.connectedAt.getTime());

    if (clientsArray.length > 0) {
      const newLeader = clientsArray[0];
      newLeader.isLeader = true;
      newLeaderId = newLeader.connectionId;
      newLeaderParticipantId = newLeader.participantId || newLeader.connectionId;
    }
  }

  if (newLeaderId) {
    const newLeader = clients.get(newLeaderId);
    newLeaderParticipantId = newLeaderParticipantId || newLeader?.participantId || newLeaderId;
    const newLeaderParticipant = participants?.get(newLeaderParticipantId);
    if (newLeaderParticipant) {
      newLeaderParticipant.isLeader = true;
    }
  }

  // Decide whether to mark the session globally inactive and cancel pending
  // Postgres writes. The check must run AFTER `distributedState.leaveSession`
  // — querying members beforehand opens a TOCTOU race where two instances
  // concurrently see each other in the membership snapshot, both decide to
  // skip the inactive path, then both leave the session globally empty
  // without anyone calling `markInactive` or `cancelPendingWrites`. Running
  // the check after our own leave (and against the post-leave Redis set
  // membership) collapses both branches of that race into "the last
  // instance to leave wins and runs the cleanup".
  //
  // It's still possible for two instances to both observe `globallyEmpty`
  // when they leave simultaneously and both run `markInactive` /
  // `cancelPendingWrites`. Both operations are idempotent:
  // `markInactive` is `SREM` on the active set, `cancelPendingWrites` is
  // a no-op when there are no pending writes for this session. Last writer
  // wins; double-calls are safe.
  //
  // INVARIANT: `getSessionMembers` returns active stable participants. The
  // explicit leave path removes the leaving participant before this check, so
  // a non-empty result means another participant is still active globally.
  if (wentLocallyEmpty) {
    let globallyEmpty = true;
    if (distributedState) {
      try {
        const members = await distributedState.getSessionMembers(sessionId);
        globallyEmpty = members.length === 0;
      } catch (error) {
        // If the distributed check fails, default to the legacy behaviour
        // (mark inactive) rather than risk a leaked session.
        logger.error(`[RoomManager] Failed to query distributed members for ${sessionId} during leaveSession:`, error);
      }
    }

    if (globallyEmpty) {
      writeScheduler.cancelPendingWrites(sessionId);

      if (redisStore) {
        await redisStore.markInactive(sessionId);
        if (!distributedState) {
          await redisStore.saveUsers(sessionId, []);
        }
        logger.info(`[RoomManager] Session ${sessionId} marked inactive - grace period started (60s)`);
      }
    }

    // Await pending session insert for brand-new sessions.
    const pending = pendingJoinPersists.get(sessionId);
    if (pending) {
      await pending;
    }
  }

  return {
    sessionId,
    participantId,
    newLeaderId,
    newLeaderParticipantId,
    participantFullyLeft: participantBecameEmpty,
  };
}

/**
 * Handle an unintentional WebSocket disconnect without treating the participant
 * as having explicitly left the session.
 */
export async function disconnectClient(
  connectionId: string,
  clients: Map<string, ConnectedClient>,
  sessionsMap: Map<string, Set<string>>,
  sessionParticipants: Map<string, Map<string, LocalSessionParticipant>>,
  redisStore: RedisSessionStore | null,
  distributedState: DistributedStateManager | null,
  writeScheduler: WriteScheduler,
  sessionGraceTimers: Map<string, NodeJS.Timeout>,
  pendingJoinPersists: Map<string, Promise<void>>,
  SESSION_GRACE_PERIOD_MS: number,
  onParticipantExpired?: (sessionId: string, participantId: string) => void,
): Promise<SessionDisconnectResult | null> {
  const client = clients.get(connectionId);
  if (!client) {
    return null;
  }

  const sessionId = client.sessionId;
  const participantId = client.participantId || connectionId;
  const wasLeader = client.isLeader;

  if (!sessionId) {
    clients.delete(connectionId);
    if (distributedState) {
      await distributedState.removeConnection(connectionId, false).catch(() => {});
    }
    return null;
  }

  const sessionClientIds = sessionsMap.get(sessionId);
  const wentLocallyEmpty = sessionClientIds
    ? (sessionClientIds.delete(connectionId), sessionClientIds.size === 0)
    : false;

  if (wentLocallyEmpty) {
    const existingGraceTimer = sessionGraceTimers.get(sessionId);
    if (existingGraceTimer) clearTimeout(existingGraceTimer);

    const timer = setTimeout(() => {
      const currentClients = sessionsMap.get(sessionId);
      if (currentClients && currentClients.size === 0) {
        sessionsMap.delete(sessionId);
        writeScheduler.cancelPendingWrites(sessionId);
        logger.info(`[RoomManager] Session ${sessionId} removed from memory after grace period`);
      }
      sessionGraceTimers.delete(sessionId);
    }, SESSION_GRACE_PERIOD_MS);
    sessionGraceTimers.set(sessionId, timer);
  }

  let remainingConnections = 0;
  let newLeaderId: string | undefined;
  let newLeaderParticipantId: string | undefined;
  if (distributedState) {
    const result = await distributedState.removeConnection(connectionId, true);
    remainingConnections = result.remainingParticipantConnections ?? 0;
    newLeaderId = result.newLeaderId || undefined;
    if (newLeaderId) {
      newLeaderParticipantId = await resolveLeaderParticipantId(newLeaderId, clients, distributedState);
    }
  }

  if (wentLocallyEmpty) {
    let globallyNoLiveConnections = true;
    if (distributedState) {
      try {
        globallyNoLiveConnections = (await distributedState.getSessionMemberCount(sessionId)) === 0;
      } catch (error) {
        // If Redis cannot answer, keep the legacy conservative behaviour:
        // mark inactive rather than leave hot session state indefinitely.
        logger.error(
          `[RoomManager] Failed to query distributed member count for ${sessionId} during disconnectClient:`,
          error,
        );
      }
    }

    if (globallyNoLiveConnections && redisStore) {
      await redisStore.markInactive(sessionId);
      logger.info(`[RoomManager] Session ${sessionId} marked inactive - grace period started (60s)`);
    }

    const pending = pendingJoinPersists.get(sessionId);
    if (pending) {
      await pending;
    }
  }

  const participants = getOrCreateParticipantMap(sessionId, sessionParticipants);
  let participant = participants.get(participantId);
  if (!participant) {
    participant = {
      id: participantId,
      username: client.username,
      userId: client.userId,
      avatarUrl: client.avatarUrl,
      isLeader: false,
      connectionState: 'CONNECTED',
      connectionIds: new Set(),
    };
    participants.set(participantId, participant);
  }

  participant.connectionIds.delete(connectionId);
  if (!distributedState) {
    remainingConnections = participant.connectionIds.size;
    if (wasLeader && sessionClientIds && sessionClientIds.size > 0) {
      const clientsArray = Array.from(sessionClientIds)
        .map((id) => clients.get(id))
        .filter((c): c is ConnectedClient => c !== undefined)
        .sort((a, b) => a.connectedAt.getTime() - b.connectedAt.getTime());

      const newLeader = clientsArray[0];
      if (newLeader) {
        newLeader.isLeader = true;
        newLeaderId = newLeader.connectionId;
        newLeaderParticipantId = newLeader.participantId || newLeader.connectionId;
      }
    }
  }

  client.sessionId = null;
  client.participantId = null;
  client.isLeader = false;
  clients.delete(connectionId);

  if (wasLeader) {
    participant.isLeader = false;
  }
  if (newLeaderId) {
    const newLeader = clients.get(newLeaderId);
    newLeaderParticipantId = newLeaderParticipantId || newLeader?.participantId || newLeaderId;
    const newLeaderParticipant = participants.get(newLeaderParticipantId);
    if (newLeaderParticipant) {
      newLeaderParticipant.isLeader = true;
    }
  }

  if (remainingConnections > 0) {
    return { sessionId, participantId, newLeaderId, newLeaderParticipantId };
  }

  participant.connectionState = 'RECONNECTING';
  // markParticipantPresence returns null when the Redis participant hash has
  // already expired (TTL elapsed before the disconnect cleanup ran). Fall
  // back to the local participant snapshot so peers always see a
  // UserPresenceChanged event during the grace window — without this
  // fallback the only signal they'd get is the eventual UserLeft, with no
  // RECONNECTING state in between.
  const presenceUser =
    (distributedState
      ? await distributedState.markParticipantPresence(sessionId, participantId, 'RECONNECTING')
      : localParticipantToSessionUser(participant)) || localParticipantToSessionUser(participant);

  if (participant.reconnectTimer) {
    clearTimeout(participant.reconnectTimer);
  }
  participant.reconnectTimer = setTimeout(() => {
    void (async () => {
      if (distributedState) {
        // Do NOT swallow Redis errors here. A failed getSessionMembers
        // previously returned [], the participant looked absent, and we
        // expelled them — the exact opposite of what the grace period is
        // for. On infra failure, keep the participant alive and let the
        // next reconnect run the grace logic again.
        let users;
        try {
          users = await distributedState.getSessionMembers(sessionId);
        } catch (err) {
          logger.error(
            `[RoomManager] Grace timer failed to query session ${sessionId.slice(0, 8)} members; keeping participant ${participantId.slice(0, 8)} alive:`,
            err,
          );
          return;
        }
        const currentUser = users.find((user) => user.id === participantId);
        // The participant might be present in the user list as RECONNECTING
        // with zero live connections — `getSessionParticipants` intentionally
        // retains those entries so peers continue to see the RECONNECTING
        // badge during the grace window. So "present in user list" alone
        // does NOT mean "still reconnecting"; it could equally mean "ghost".
        // Disambiguate by querying the actual live-connection count.
        //
        // - CONNECTED user → live conns > 0 → spare (active participant).
        // - RECONNECTING + live conns > 0 → in-flight reconnect, spare.
        // - RECONNECTING + 0 live conns → ghost, evict.
        // - Not in user list at all → already cleaned up, fall through.
        if (currentUser?.connectionState === 'CONNECTED') {
          return;
        }
        if (currentUser?.connectionState === 'RECONNECTING') {
          let liveConnectionCount: number;
          try {
            liveConnectionCount = await distributedState.getParticipantLiveConnectionCount(sessionId, participantId);
          } catch (err) {
            // Same conservative behaviour as the getSessionMembers failure
            // above: if Redis can't answer, don't expel; the next reconnect
            // will run the grace logic again.
            logger.error(
              `[RoomManager] Grace timer failed to count live connections for participant ${participantId.slice(0, 8)}; keeping them alive:`,
              err,
            );
            return;
          }
          if (liveConnectionCount > 0) {
            return; // In-flight reconnect; let the rejoin promote them back to CONNECTED.
          }
          // Fall through to eviction: RECONNECTING with no live connections is a ghost.
        }
        await distributedState.removeParticipant(sessionId, participantId).catch((err) => {
          logger.error(`[RoomManager] Failed to expire participant ${participantId.slice(0, 8)}:`, err);
        });
      }

      const currentParticipants = sessionParticipants.get(sessionId);
      const currentParticipant = currentParticipants?.get(participantId);
      if (currentParticipant && currentParticipant.connectionIds.size === 0) {
        currentParticipants?.delete(participantId);
        if (currentParticipants?.size === 0) {
          sessionParticipants.delete(sessionId);
        }
        onParticipantExpired?.(sessionId, participantId);
      }
    })();
  }, SESSION_GRACE_PERIOD_MS);

  return { sessionId, participantId, presenceUser, newLeaderId, newLeaderParticipantId };
}

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
};

async function resolveLeaderParticipantId(
  leaderConnectionId: string,
  clients: Map<string, ConnectedClient>,
  distributedState: DistributedStateManager | null,
): Promise<string> {
  const localLeader = clients.get(leaderConnectionId);
  if (localLeader?.participantId) {
    return localLeader.participantId;
  }

  if (distributedState) {
    try {
      const distributedLeader = await distributedState.getConnection(leaderConnectionId);
      if (distributedLeader?.participantId) {
        return distributedLeader.participantId;
      }
    } catch (error) {
      logger.error(`[RoomManager] Failed to resolve leader participant for ${leaderConnectionId.slice(0, 8)}:`, error);
    }
  }

  return leaderConnectionId;
}

/**
 * Remove a client from the system entirely.
 */
export async function removeClient(
  connectionId: string,
  clients: Map<string, ConnectedClient>,
  sessionsMap: Map<string, Set<string>>,
  distributedState: DistributedStateManager | null,
): Promise<{ distributedStateCleanedUp: boolean }> {
  let distributedStateCleanedUp = true;

  if (distributedState) {
    try {
      const result = await distributedState.removeConnection(connectionId);
      if (result.newLeaderId) {
        logger.info(`[RoomManager] New leader ${result.newLeaderId.slice(0, 8)} elected after client removal`);
      }
    } catch (err) {
      distributedStateCleanedUp = false;
      logger.error(
        `[RoomManager] Failed to remove connection ${connectionId.slice(0, 8)} from distributed state. ` +
          `Redis data may remain until TTL expires. Error: ${String(err)}`,
      );
    }
  }

  const client = clients.get(connectionId);
  if (client?.sessionId) {
    const sessionSet = sessionsMap.get(client.sessionId);
    if (sessionSet) {
      sessionSet.delete(connectionId);
      if (sessionSet.size === 0) {
        sessionsMap.delete(client.sessionId);
      }
    }
  }
  clients.delete(connectionId);

  return { distributedStateCleanedUp };
}

function upsertLocalParticipant(
  sessionId: string,
  participantId: string,
  client: ConnectedClient,
  isLeader: boolean,
  sessionParticipants: Map<string, Map<string, LocalSessionParticipant>>,
): { wasKnown: boolean; wasReconnecting: boolean } {
  let participants = sessionParticipants.get(sessionId);
  if (!participants) {
    participants = new Map();
    sessionParticipants.set(sessionId, participants);
  }

  const existing = participants.get(participantId);
  const wasKnown = !!existing;
  const wasReconnecting = existing?.connectionState === 'RECONNECTING';

  if (existing?.reconnectTimer) {
    clearTimeout(existing.reconnectTimer);
    existing.reconnectTimer = undefined;
  }

  participants.set(participantId, {
    id: participantId,
    username: client.username,
    userId: client.userId,
    avatarUrl: client.avatarUrl,
    isLeader: existing?.isLeader || isLeader,
    connectionState: 'CONNECTED',
    connectionIds: new Set([...(existing?.connectionIds ?? []), client.connectionId]),
  });

  return { wasKnown, wasReconnecting };
}

function getOrCreateParticipantMap(
  sessionId: string,
  sessionParticipants: Map<string, Map<string, LocalSessionParticipant>>,
): Map<string, LocalSessionParticipant> {
  let participants = sessionParticipants.get(sessionId);
  if (!participants) {
    participants = new Map();
    sessionParticipants.set(sessionId, participants);
  }
  return participants;
}

function localParticipantToSessionUser(participant: LocalSessionParticipant): SessionUser {
  return {
    id: participant.id,
    username: participant.username,
    isLeader: participant.isLeader,
    avatarUrl: participant.avatarUrl,
    userId: participant.userId,
    connectionState: participant.connectionState,
  };
}

/**
 * Ensure a session record exists in Postgres for durable history/summary reads.
 *
 * Implicit sessions (created on-the-fly by `joinSession` for legacy clients
 * that don't go through the explicit `createSession` mutation) opt INTO
 * shared-playlist mode by default. The new `shared_playlist_enabled = false`
 * default in the schema gates the explicit `createSession` path; legacy
 * joinSession callers preserve the old shared-queue UX without requiring
 * a separate toggle call.
 */
async function ensureSessionRecordExists(
  sessionId: string,
  boardPath: string,
  userId: string | null,
  sessionName?: string,
): Promise<void> {
  const now = new Date();
  await db
    .insert(sessions)
    .values({
      id: sessionId,
      boardPath,
      createdAt: now,
      lastActivity: now,
      latitude: null,
      longitude: null,
      discoverable: false,
      createdByUserId: userId,
      name: sessionName || null,
      startedAt: now,
      sharedPlaylistEnabled: true,
    })
    .onConflictDoNothing();
}
