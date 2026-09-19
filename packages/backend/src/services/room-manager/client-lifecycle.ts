import { GraphQLError } from 'graphql';
import type { ClimbQueueItem, SessionUser } from '@boardsesh/shared-schema';
import { db } from '../../db/client';
import { sessions, boardSessionParticipants } from '../../db/schema';
import type { DistributedStateManager } from '../distributed-state';
import type {
  ConnectedClient,
  LocalSessionParticipant,
  RoomManagerDeps,
  JoinSessionCallbacks,
  JoinSessionOptions,
  SessionLeaveResult,
  SessionDisconnectResult,
} from './types';
import { restoreSessionWithLock } from './session-restoration';
import { logger } from '../../utils/logger';
import { markErrorReported } from '../../utils/sentry-dedupe';

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
  deps: RoomManagerDeps,
  connectionId: string,
  sessionId: string,
  boardPath: string,
  callbacks: JoinSessionCallbacks,
  options: JoinSessionOptions = {},
): Promise<{
  clientId: string;
  users: SessionUser[];
  queue: ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
  sequence: number;
  stateHash: string;
  stateHashOrdered: string;
  isLeader: boolean;
  sessionName: string | null;
  participantId: string;
  participantWasKnown: boolean;
  participantWasReconnecting: boolean;
}> {
  const {
    clients,
    sessions: sessionsMap,
    sessionParticipants,
    redisStore,
    distributedState,
    sessionGraceTimers,
    pendingJoinPersists,
  } = deps;
  const {
    getQueueState: getQueueStateFn,
    getSessionUsers,
    getSessionUsersLocal,
    getSessionById,
    updateQueueStateImmediate,
    leaveSession: leaveSessionFn,
  } = callbacks;
  const { username, avatarUrl, initialQueue, initialCurrentClimb, sessionName, participantId, isPublic } = options;

  const client = clients.get(connectionId);
  if (!client) {
    throw new Error('Client not registered');
  }

  // Refuse to resurrect a server-ended session (#2696). The Postgres row is the
  // durable source of truth (Redis only holds live presence), so a stale/ended
  // session id must not be treated as "new" and recreated as an empty zombie
  // room. Mirror the sessionStatus resolver's predicate. Runs before any client
  // state is mutated or the current session is left, so a failed join here
  // never disturbs a session the client is already in.
  const existingSession = await getSessionById(sessionId);
  if (existingSession && (existingSession.status === 'ended' || existingSession.endedAt !== null)) {
    const endedError = new GraphQLError('This session has ended', {
      extensions: { code: 'SESSION_ENDED' },
    });
    // Expected client condition (stale/offline rejoin), not a server fault —
    // keep it out of Sentry's generic capture loop.
    markErrorReported(endedError);
    logger.info(`[RoomManager] Rejecting JOIN_SESSION for ended session ${sessionId}`);
    throw endedError;
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
      // No Redis: a missing Postgres row means this is a brand-new session.
      // Ended rows were already rejected by the guard at the top of joinSession.
      if (!existingSession) {
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
    const chained = previous.then(() =>
      ensureSessionRecordExists(sessionId, boardPath, client.userId, sessionName, isPublic),
    );

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
    stateHashOrdered: queueState.stateHashOrdered,
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
export async function leaveSession(deps: RoomManagerDeps, connectionId: string): Promise<SessionLeaveResult | null> {
  const { clients, sessionParticipants, distributedState } = deps;

  const client = clients.get(connectionId);
  if (!client || !client.sessionId) {
    return null;
  }

  const sessionId = client.sessionId;
  const participantId = client.participantId || connectionId;
  const wasLeader = client.isLeader;

  // ORIGINAL SOURCE (post-B4 numbering): lines 300-320. `false` here means
  // this explicit-leave caller does NOT cancel pending writes from the grace
  // timer body — see `detachConnectionFromLocalSession`'s doc comment for why
  // that differs from `disconnectClient`.
  const { wentLocallyEmpty } = detachConnectionFromLocalSession(deps, sessionId, connectionId, false);

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
    // Pass participantId so leader re-election prefers a sibling connection of
    // the same participant when this leader connection leaves but the
    // participant stays (multi-tab) — #2135 crit C.
    const result = await distributedState.leaveSession(connectionId, sessionId, participantId);
    if (result.newLeaderId) {
      newLeaderId = result.newLeaderId;
      // Populated when the leave went through the fallback election (which
      // resolves it as part of electing); the atomic happy path doesn't
      // carry it, so resolve it ourselves in that case.
      newLeaderParticipantId =
        result.newLeaderParticipantId || (await resolveLeaderParticipantId(newLeaderId, clients, distributedState));
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
  } else {
    // ORIGINAL SOURCE (post-B4 numbering): lines 380-392. See
    // `electLocalLeaderFallback` for the shared no-Redis election logic
    // (including its own `wasLeader`/non-empty-session guard).
    const fallback = electLocalLeaderFallback(deps, sessionId, wasLeader);
    newLeaderId = fallback.newLeaderId;
    newLeaderParticipantId = fallback.newLeaderParticipantId;
  }

  if (newLeaderId) {
    const newLeader = clients.get(newLeaderId);
    newLeaderParticipantId = newLeaderParticipantId || newLeader?.participantId || newLeaderId;
    const newLeaderParticipant = participants?.get(newLeaderParticipantId);
    if (newLeaderParticipant) {
      newLeaderParticipant.isLeader = true;
    }
  }

  // ORIGINAL SOURCE (post-B4 numbering): lines 403-453. See
  // `markInactiveIfGloballyEmpty` for the full TOCTOU ordering-contract
  // comment (moved verbatim into that function's doc comment) — this call
  // MUST stay after the distributed leave/election above.
  if (wentLocallyEmpty) {
    await markInactiveIfGloballyEmpty(deps, sessionId, /* isExplicitLeave */ true);
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
 * New-leader payload handed to `onParticipantExpired` so the caller can
 * broadcast a `LeaderChanged` alongside `UserLeft` when a grace-timer eviction
 * removed a ghost that still held leadership (#2135 expiry leader election).
 */
export type ExpiredParticipantLeader = { leaderId: string; leaderConnectionId: string };

/**
 * Fired when the grace timer expires and the participant is confirmed gone.
 * `newLeader` is set only when the evicted participant held leadership and a
 * replacement was elected in the same atomic transition.
 */
type OnParticipantExpired = (sessionId: string, participantId: string, newLeader?: ExpiredParticipantLeader) => void;

/**
 * Handle an unintentional WebSocket disconnect without treating the participant
 * as having explicitly left the session.
 */
export async function disconnectClient(
  deps: RoomManagerDeps,
  connectionId: string,
  onParticipantExpired?: OnParticipantExpired,
): Promise<SessionDisconnectResult | null> {
  const { clients, sessionParticipants, distributedState } = deps;

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

  // ORIGINAL SOURCE (post-B4 numbering): lines 502-521. `true` here means
  // this implicit-disconnect caller DOES cancel pending writes from the
  // grace timer body — see `detachConnectionFromLocalSession`'s doc comment.
  const { wentLocallyEmpty } = detachConnectionFromLocalSession(deps, sessionId, connectionId, true);

  let remainingConnections = 0;
  let newLeaderId: string | undefined;
  let newLeaderParticipantId: string | undefined;
  if (distributedState) {
    const result = await distributedState.removeConnection(connectionId, true);
    remainingConnections = result.remainingParticipantConnections ?? 0;
    newLeaderId = result.newLeaderId || undefined;
    if (newLeaderId) {
      // The election already resolved the participantId from the leader's
      // connection hash; only fall back to our own resolution when it
      // couldn't (missing hash / no participantId recorded).
      newLeaderParticipantId =
        result.newLeaderParticipantId || (await resolveLeaderParticipantId(newLeaderId, clients, distributedState));
    }
  }

  // ORIGINAL SOURCE (post-B4 numbering): lines 535-559. See
  // `markInactiveIfGloballyEmpty` for the full TOCTOU ordering-contract
  // comment — this call MUST stay after `distributedState.removeConnection`
  // above.
  if (wentLocallyEmpty) {
    await markInactiveIfGloballyEmpty(deps, sessionId, /* isExplicitLeave */ false);
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
    // ORIGINAL SOURCE (post-B4 numbering): lines 579-591. See
    // `electLocalLeaderFallback` for the shared no-Redis election logic.
    const fallback = electLocalLeaderFallback(deps, sessionId, wasLeader);
    newLeaderId = fallback.newLeaderId;
    newLeaderParticipantId = fallback.newLeaderParticipantId;
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

  // WS-anonymous participants are keyed by connectionId (joinSession sets
  // `resolvedParticipantId = client.userId || connectionId`), so a reconnect
  // always arrives as a brand-new participantId that can never resume this one.
  // The RECONNECTING grace below only pays off when the *same* participant comes
  // back; for an anonymous connection it just parks a ghost that lingers for the
  // full grace window while every reconnect stacks another — inflating the
  // roster (and `peerCount`/`partyMode`). Remove them now and tell peers with a
  // UserLeft instead. Authenticated users (stable `participantId = userId`) keep
  // the grace path unchanged.
  if (!client.userId) {
    if (participant.reconnectTimer) {
      clearTimeout(participant.reconnectTimer);
    }
    participants.delete(participantId);
    if (participants.size === 0) {
      sessionParticipants.delete(sessionId);
    }
    if (distributedState) {
      await distributedState.removeParticipant(sessionId, participantId).catch((err) => {
        logger.error(
          `[RoomManager] Failed to remove anonymous participant ${participantId.slice(0, 8)} on disconnect:`,
          err,
        );
      });
    }
    return { sessionId, participantId, participantFullyLeft: true, newLeaderId, newLeaderParticipantId };
  }

  // ORIGINAL SOURCE (post-B4 numbering): lines 615-697. See
  // `beginParticipantGraceWindow` (presence marking + timer arm) and
  // `evictParticipantIfGhost` (the timer body) for the full ordering
  // contract and the Redis-failure conservatism comments, moved verbatim.
  const presenceUser = await beginParticipantGraceWindow(deps, sessionId, participant, onParticipantExpired);

  // `presenceUser` is null when a reconnect already promoted this participant
  // back to CONNECTED on another connection during cleanup (#2135 crit D): no
  // grace window was armed and no UserPresenceChanged is owed — the reconnect's
  // own join emitted the CONNECTED state. Coerce to undefined so the WS-close
  // handler's `result?.presenceUser` guard skips the broadcast.
  return { sessionId, participantId, presenceUser: presenceUser ?? undefined, newLeaderId, newLeaderParticipantId };
}

/**
 * Detach a connection from the in-memory session roster and, if that drains
 * the session locally, (re)arm the grace timer that deletes the session's
 * client-id `Set` from `deps.sessions` after `SESSION_GRACE_PERIOD_MS`.
 *
 * ORIGINAL SOURCE (post-B4 numbering): `leaveSession` lines 300-320 and
 * `disconnectClient` lines 502-521 — near-duplicate blocks unified here.
 *
 * The two call sites differ in exactly one place: `disconnectClient`'s grace
 * timer additionally calls `writeScheduler.cancelPendingWrites(sessionId)`
 * right before logging that the session was removed from memory;
 * `leaveSession`'s timer does not. `leaveSession` already unconditionally
 * cancels pending writes (see `markInactiveIfGloballyEmpty`) when the
 * session goes globally empty, so skipping it here for that caller avoids a
 * redundant (if harmless/idempotent) call — but preserving byte-equal
 * per-caller behaviour means not adding it unconditionally. Note the flag
 * does not add a cancellation the base lacked either: when the session is
 * NOT globally empty, the base `leaveSession` path never cancelled pending
 * writes anywhere (neither in its timer nor in the globally-empty block),
 * and `false` reproduces exactly that. Captured by the
 * `cancelWritesOnExpiry` flag, threaded straight through so each caller's
 * original control flow is reproduced exactly:
 *   - `leaveSession` passes `false`.
 *   - `disconnectClient` passes `true`.
 *
 * ORDERING CONTRACT: in both callers this is the first mutation of local
 * session/timer state after the connection + session are resolved, and it
 * runs before any leader-election or distributed-state call.
 */
function detachConnectionFromLocalSession(
  deps: RoomManagerDeps,
  sessionId: string,
  connectionId: string,
  cancelWritesOnExpiry: boolean,
): { wentLocallyEmpty: boolean } {
  const {
    sessions: sessionsMap,
    sessionGraceTimers,
    writeScheduler,
    sessionGracePeriodMs: SESSION_GRACE_PERIOD_MS,
  } = deps;

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
        if (cancelWritesOnExpiry) {
          writeScheduler.cancelPendingWrites(sessionId);
        }
        logger.info(`[RoomManager] Session ${sessionId} removed from memory after grace period`);
      }
      sessionGraceTimers.delete(sessionId);
    }, SESSION_GRACE_PERIOD_MS);
    sessionGraceTimers.set(sessionId, timer);
  }

  return { wentLocallyEmpty };
}

/**
 * Mark a session globally inactive (and, for the explicit-leave path,
 * cancel its pending Postgres writes) once no live presence remains
 * anywhere in the cluster. Only called when `wentLocallyEmpty` was true for
 * this connection's removal.
 *
 * ORIGINAL SOURCE (post-B4 numbering): `leaveSession` lines 403-453 and
 * `disconnectClient` lines 535-559 — unified via `isExplicitLeave`, which
 * captures every systematic difference between the two call sites:
 *   - Explicit leave (`leaveSession`) checks "are there still active
 *     *participants*" (`getSessionMembers().length === 0`); implicit
 *     disconnect (`disconnectClient`) checks "are there still *live
 *     connections*" (`getSessionMemberCount() === 0`). This is intentional,
 *     not incidental: a just-disconnected participant may still sit in the
 *     member list as RECONNECTING with zero live connections, so
 *     `disconnectClient` needs the connection-count view to declare the
 *     session empty; `leaveSession` already removed the leaving participant
 *     from the member list above, so the participant-count view is correct
 *     there.
 *   - Explicit leave unconditionally cancels pending writes the moment the
 *     session is globally empty; implicit disconnect defers that to the
 *     grace-timer callback (see `detachConnectionFromLocalSession`'s
 *     `cancelWritesOnExpiry` flag) so a reconnect within the grace window
 *     doesn't lose in-flight writes.
 *   - Explicit leave also wipes the legacy (no-distributed-state) user list
 *     via `saveUsers(sessionId, [])`; implicit disconnect does not, since a
 *     disconnect always continues into the RECONNECTING grace path rather
 *     than an immediate teardown.
 *
 * ORDERING CONTRACT: this check MUST run AFTER `distributedState.leaveSession`
 * / `distributedState.removeConnection` — querying membership beforehand
 * opens a TOCTOU race where two instances concurrently see each other in the
 * membership snapshot, both decide to skip the inactive path, then both
 * leave the session globally empty without anyone calling `markInactive` or
 * `cancelPendingWrites`. Running the check after our own leave/disconnect
 * (and against the post-leave Redis set membership) collapses both branches
 * of that race into "the last instance to leave wins and runs the cleanup".
 *
 * It's still possible for two instances to both observe "globally empty"
 * when they leave simultaneously and both run `markInactive` /
 * `cancelPendingWrites`. Both operations are idempotent: `markInactive` is
 * `SREM` on the active set, `cancelPendingWrites` is a no-op when there are
 * no pending writes for this session. Last writer wins; double-calls are
 * safe.
 *
 * INVARIANT: `getSessionMembers` returns active stable participants. The
 * explicit leave path removes the leaving participant before this check, so
 * a non-empty result means another participant is still active globally.
 */
async function markInactiveIfGloballyEmpty(
  deps: RoomManagerDeps,
  sessionId: string,
  isExplicitLeave: boolean,
): Promise<void> {
  const { redisStore, distributedState, writeScheduler, pendingJoinPersists } = deps;

  let globallyEmpty = true;
  if (distributedState) {
    try {
      if (isExplicitLeave) {
        const members = await distributedState.getSessionMembers(sessionId);
        globallyEmpty = members.length === 0;
      } else {
        globallyEmpty = (await distributedState.getSessionMemberCount(sessionId)) === 0;
      }
    } catch (error) {
      // If the distributed check fails, default to the legacy behaviour
      // (mark inactive) rather than risk a leaked session.
      if (isExplicitLeave) {
        logger.error(`[RoomManager] Failed to query distributed members for ${sessionId} during leaveSession:`, error);
      } else {
        // If Redis cannot answer, keep the legacy conservative behaviour:
        // mark inactive rather than leave hot session state indefinitely.
        logger.error(
          `[RoomManager] Failed to query distributed member count for ${sessionId} during disconnectClient:`,
          error,
        );
      }
    }
  }

  if (isExplicitLeave) {
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
  } else if (globallyEmpty && redisStore) {
    await redisStore.markInactive(sessionId);
    logger.info(`[RoomManager] Session ${sessionId} marked inactive - grace period started (60s)`);
  }

  // Await pending session insert for brand-new sessions.
  const pending = pendingJoinPersists.get(sessionId);
  if (pending) {
    await pending;
  }
}

/**
 * No-Redis (single-instance) local leader election fallback: when the
 * departing connection was the session leader and other local connections
 * remain, promote the earliest-connected one.
 *
 * ORIGINAL SOURCE (post-B4 numbering): `leaveSession` lines 380-392 and
 * `disconnectClient` lines 579-591 — duplicated verbatim modulo trivial
 * style (`if (clientsArray.length > 0)` vs `if (newLeader)`, which are
 * equivalent: `clientsArray[0]` is `undefined` exactly when the array is
 * empty). The `wasLeader`/non-empty-session guard that used to live at each
 * call site is folded into this function so both callers can invoke it
 * unconditionally.
 *
 * NOTE (B6 interplay): PR #3345 ("consolidate leader-election fallbacks
 * into one path", based on `main`, not yet in this branch's base as of this
 * writing) rewires the leader-election call sites in this file around where
 * `newLeaderParticipantId` is consumed. Whoever rebases this stack onto a
 * merged #3345 second needs to re-apply this extraction around B6's changed
 * call sites — this PR deliberately does not touch or absorb B6's changes.
 *
 * ORDERING CONTRACT: only reached when `distributedState` is null — the
 * distributed path (Redis-backed election) always takes precedence and
 * short-circuits before this runs.
 */
function electLocalLeaderFallback(
  deps: RoomManagerDeps,
  sessionId: string,
  wasLeader: boolean,
): { newLeaderId?: string; newLeaderParticipantId?: string } {
  const { clients, sessions: sessionsMap } = deps;
  const sessionClientIds = sessionsMap.get(sessionId);

  if (!wasLeader || !sessionClientIds || sessionClientIds.size === 0) {
    return {};
  }

  const clientsArray = Array.from(sessionClientIds)
    .map((id) => clients.get(id))
    .filter((c): c is ConnectedClient => c !== undefined)
    .sort((a, b) => a.connectedAt.getTime() - b.connectedAt.getTime());

  const newLeader = clientsArray[0];
  if (!newLeader) {
    return {};
  }

  newLeader.isLeader = true;
  return {
    newLeaderId: newLeader.connectionId,
    newLeaderParticipantId: newLeader.participantId || newLeader.connectionId,
  };
}

/**
 * Begin the reconnect grace window for a participant whose last live
 * connection just dropped: mark them RECONNECTING (broadcasting presence),
 * then arm a timer that evicts them as a ghost if nothing reconnects within
 * `SESSION_GRACE_PERIOD_MS`.
 *
 * ORIGINAL SOURCE (post-B4 numbering): `disconnectClient` lines 615-697.
 * Only reached when `remainingConnections === 0` for this participant after
 * the disconnecting connection was removed (checked by the caller). Takes
 * the resolved `participant` object directly rather than re-deriving it
 * from `sessionId`/`participantId` — the caller already has it in hand from
 * its own get-or-create lookup, and re-deriving here would just repeat that
 * map lookup for no benefit.
 *
 * ORDERING CONTRACT: the RECONNECTING mark is CONDITIONAL (#2135 crit D) —
 * `markParticipantReconnectingIfIdle` skips the write (and returns 'has-live')
 * when a reconnect already promoted this participant back to CONNECTED on
 * another connection during cleanup, so a passive disconnect can't clobber the
 * fresher state. In that case this returns `null`: no local state change, no
 * timer armed, and the caller emits no UserPresenceChanged. Otherwise it sets
 * `connectionState = 'RECONNECTING'` and arms the reconnect timer last, after
 * clearing any pre-existing one, so a rapid disconnect/reconnect/disconnect
 * sequence never leaves two timers racing for the same participant.
 */
async function beginParticipantGraceWindow(
  deps: RoomManagerDeps,
  sessionId: string,
  participant: LocalSessionParticipant,
  onParticipantExpired?: OnParticipantExpired,
): Promise<SessionUser | null> {
  const { distributedState, sessionGracePeriodMs: SESSION_GRACE_PERIOD_MS } = deps;
  const participantId = participant.id;

  let presenceUser: SessionUser;
  if (distributedState) {
    const result = await distributedState.markParticipantReconnectingIfIdle(sessionId, participantId);
    if (result.status === 'has-live') {
      // A reconnect landed on another connection during this disconnect's
      // cleanup — the participant is CONNECTED elsewhere. Don't park a ghost,
      // don't arm a timer, don't emit a spurious RECONNECTING presence.
      return null;
    }
    // Flip local state to RECONNECTING BEFORE building any fallback, so the
    // local snapshot reports RECONNECTING (matching the pre-change behaviour).
    participant.connectionState = 'RECONNECTING';
    // 'reconnecting' carries the fresh Redis presence payload; 'missing' means
    // the Redis participant hash was pruned (e.g. its TTL lapsed, or a
    // concurrent roster read swept it as a zero-connection CONNECTED entry
    // before we could mark it) — fall back to the local snapshot so peers still
    // see a RECONNECTING event during the grace window (without it the only
    // signal would be the eventual UserLeft).
    presenceUser = result.status === 'reconnecting' ? result.user : localParticipantToSessionUser(participant);
  } else {
    participant.connectionState = 'RECONNECTING';
    presenceUser = localParticipantToSessionUser(participant);
  }

  if (participant.reconnectTimer) {
    clearTimeout(participant.reconnectTimer);
  }
  participant.reconnectTimer = setTimeout(() => {
    void evictParticipantIfGhost(deps, sessionId, participantId, onParticipantExpired);
  }, SESSION_GRACE_PERIOD_MS);

  return presenceUser;
}

/**
 * Timer body for `beginParticipantGraceWindow`: runs `SESSION_GRACE_PERIOD_MS`
 * after the timer was armed, unless a reconnect within the window cancelled
 * it first. Decides "still reconnecting" vs. "ghost" and, if a ghost, evicts
 * them from distributed and local state.
 *
 * ORIGINAL SOURCE (post-B4 numbering): `disconnectClient` lines 631-696 —
 * body of the reconnect-grace-window `setTimeout` callback.
 *
 * The distributed decision + removal is now ONE atomic Lua call
 * (`evictGhostParticipant`, #2135 crit B): the prior code read the
 * live-connection count OUTSIDE the delete, so a reconnect that added a live
 * connection between the check and the unconditional `removeParticipant` was
 * silently wiped (zombie connection + vanished participant). The script only
 * evicts a participant STILL parked RECONNECTING with zero live connections,
 * and — because the old delete never touched the leader key — re-elects a
 * replacement in the same transition when the ghost held leadership, so peers
 * don't miss a `LeaderChanged` (expiry leader election).
 *
 * The Redis-error handling here is intentionally NOT the "default to
 * conservative" pattern used elsewhere in this file. On infra failure, keep the
 * participant alive and let the next reconnect run the grace logic again —
 * expelling a participant we can't verify is absent is the opposite of what the
 * grace period is for.
 */
async function evictParticipantIfGhost(
  deps: RoomManagerDeps,
  sessionId: string,
  participantId: string,
  onParticipantExpired?: OnParticipantExpired,
): Promise<void> {
  const { clients, distributedState, sessionParticipants } = deps;

  // `didEvict` gates the UserLeft/LeaderChanged broadcast. Single-instance
  // (no Redis) keeps the original behaviour: the local zero-connection gate
  // below is the authority. Distributed mode narrows it to a genuine eviction.
  let didEvict = true;
  let expiredLeader: ExpiredParticipantLeader | undefined;

  if (distributedState) {
    let result;
    try {
      result = await distributedState.evictGhostParticipant(sessionId, participantId);
    } catch (err) {
      logger.error(
        `[RoomManager] Grace timer failed to evaluate participant ${participantId.slice(0, 8)}; keeping them alive:`,
        err,
      );
      return;
    }

    // Spared: a reconnect promoted them back to CONNECTED (has-live) or they
    // were already CONNECTED (not-reconnecting). Leave local state as-is.
    if (result.status === 'has-live' || result.status === 'not-reconnecting') {
      return;
    }

    // 'evicted' — we removed them (and possibly elected a leader). 'missing' —
    // someone else already removed them, so no new broadcast is owed; just
    // reconcile local state below.
    didEvict = result.status === 'evicted';
    if (result.status === 'evicted' && result.newLeaderId) {
      const leaderConnectionId = result.newLeaderId;
      const leaderParticipantId = await resolveLeaderParticipantId(leaderConnectionId, clients, distributedState);
      expiredLeader = { leaderId: leaderParticipantId, leaderConnectionId };
    }
  }

  const currentParticipants = sessionParticipants.get(sessionId);
  const currentParticipant = currentParticipants?.get(participantId);
  if (currentParticipant && currentParticipant.connectionIds.size === 0) {
    currentParticipants?.delete(participantId);
    if (currentParticipants?.size === 0) {
      sessionParticipants.delete(sessionId);
    }
    if (didEvict) {
      onParticipantExpired?.(sessionId, participantId, expiredLeader);
    }
  }
}

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
  deps: RoomManagerDeps,
  connectionId: string,
): Promise<{ distributedStateCleanedUp: boolean }> {
  const { clients, sessions: sessionsMap, distributedState } = deps;
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
 * ON CONFLICT DO NOTHING is load-bearing for `isPublic`: whichever caller
 * inserts first decides the session's visibility, and no later join can flip
 * it. The HTTP `createSession` path relies on that to make a private session
 * private from its first insert — it writes the row up front, before the
 * creator's WebSocket join reaches this function.
 */
export async function ensureSessionRecordExists(
  sessionId: string,
  boardPath: string,
  userId: string | null,
  sessionName?: string,
  isPublic: boolean = true,
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
      isPublic,
    })
    .onConflictDoNothing();
}
