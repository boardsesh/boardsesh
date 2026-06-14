import type Redis from 'ioredis';
import type { ClimbQueueItem, SessionUser } from '@boardsesh/shared-schema';
import { RedisSessionStore } from '../redis-session-store';
import type { Session } from '../../db/schema';
import {
  type DistributedStateManager,
  initializeDistributedState,
  shutdownDistributedState,
  forceResetDistributedState,
} from '../distributed-state';
import { RECENT_CLIMBS_BUFFER_SIZE } from '../distributed-state/constants';
import { logger } from '../../utils/logger';
import type { ConnectedClient, DiscoverableSession, LocalSessionParticipant, QueueState } from './types';
import { WriteScheduler } from './write-scheduler';
import {
  updateQueueState as updateQueueStateFn,
  updateQueueStateImmediate as updateQueueStateImmediateFn,
  updateQueueOnly as updateQueueOnlyFn,
  getQueueState as getQueueStateFn,
} from './queue-state';
import {
  registerClient as registerClientFn,
  joinSession as joinSessionFn,
  leaveSession as leaveSessionFn,
  disconnectClient as disconnectClientFn,
  removeClient as removeClientFn,
  type SessionDisconnectResult,
  type SessionLeaveResult,
} from './client-lifecycle';
import { pubsub } from '../../pubsub/index';
import { endLiveActivity } from '../apns/index';
import type { SessionEvent } from '@boardsesh/shared-schema';
import {
  getSessionById as getSessionByIdFn,
  createDiscoverableSession as createDiscoverableSessionFn,
  findNearbySessions as findNearbySessionsFn,
  getUserSessions as getUserSessionsFn,
  endSession as endSessionFn,
  endStaleInactiveSessions,
  updateSessionBoardPathIfChanged as updateSessionBoardPathIfChangedFn,
} from './session-discovery';

const INACTIVITY_THRESHOLD_MS = 60 * 60 * 1000;
const INACTIVITY_SWEEP_INTERVAL_MS = 60 * 1000;

class RoomManager {
  private clients = new Map<string, ConnectedClient>();
  private sessions = new Map<string, Set<string>>();
  private sessionParticipants = new Map<string, Map<string, LocalSessionParticipant>>();
  private redisStore: RedisSessionStore | null = null;
  private distributedState: DistributedStateManager | null = null;
  // In-memory driver fallback for single-instance / no-Redis deploys.
  // Untouched when `distributedState` is set — Redis is then the only source
  // of truth, and parallel-writing here just creates read-after-write
  // skew windows. Same rationale for the board-serial map below.
  private localDriverBySession = new Map<string, string>();
  // Single-instance fallback for the wall-connection holders: sessionId ->
  // { boardId -> holder participantId }. Mirrors localDriverBySession; only the
  // no-Redis path touches it (Redis is the source of truth otherwise).
  private localWallConnectionsBySession = new Map<string, Map<number, string>>();
  private localBoardSerialBySession = new Map<string, string>();
  // In-memory recent-climbs ring buffer (per session). Same rationale as the
  // other local shadows: tests and single-instance dev don't have Redis. The
  // distributed path writes to a bounded Redis LIST; this mirror enforces the
  // same bound via Array.unshift + slice on every write, using the canonical
  // RECENT_CLIMBS_BUFFER_SIZE constant so the two paths can't drift.
  private localRecentClimbsBySession = new Map<string, string[]>();
  private sessionGraceTimers = new Map<string, NodeJS.Timeout>();
  private readonly SESSION_GRACE_PERIOD_MS = 60_000;
  private pendingJoinPersists = new Map<string, Promise<void>>();
  private writeScheduler = new WriteScheduler();
  private inactivitySweepInterval: NodeJS.Timeout | null = null;

  /**
   * Reset all state (for testing purposes)
   */
  reset(): void {
    for (const participants of this.sessionParticipants.values()) {
      for (const participant of participants.values()) {
        if (participant.reconnectTimer) {
          clearTimeout(participant.reconnectTimer);
        }
      }
    }

    this.clients.clear();
    this.sessions.clear();
    this.sessionParticipants.clear();
    this.localDriverBySession.clear();
    this.localWallConnectionsBySession.clear();
    this.localBoardSerialBySession.clear();
    this.localRecentClimbsBySession.clear();
    this.redisStore = null;
    this.distributedState = null;

    this.writeScheduler.reset();

    // Clear grace timers
    for (const timer of this.sessionGraceTimers.values()) {
      clearTimeout(timer);
    }
    this.sessionGraceTimers.clear();

    // Clear pending join persist promises
    this.pendingJoinPersists.clear();

    if (this.inactivitySweepInterval) {
      clearInterval(this.inactivitySweepInterval);
      this.inactivitySweepInterval = null;
    }

    // Reset the distributed state singleton so initialize() creates a fresh one
    forceResetDistributedState();
  }

  /**
   * Initialize RoomManager with Redis for session persistence and distributed state.
   * If Redis is not provided, falls back to Postgres-only mode (single instance).
   */
  async initialize(redis?: Redis): Promise<void> {
    if (redis) {
      this.redisStore = new RedisSessionStore(redis);
      logger.info('[RoomManager] Redis session storage enabled');

      this.distributedState = initializeDistributedState(redis);
      this.distributedState.start();
      logger.info('[RoomManager] Distributed state enabled for multi-instance support');
    } else {
      logger.info('[RoomManager] Redis not available - using Postgres only mode (single instance)');
    }

    if (!this.inactivitySweepInterval) {
      this.inactivitySweepInterval = setInterval(() => {
        endStaleInactiveSessions(INACTIVITY_THRESHOLD_MS)
          .then((endedIds) => {
            // For every auto-ended session, mirror the side effects of the
            // explicit endSession mutation: publish SessionEnded so connected
            // clients tear down, and end the iOS Live Activity so lock-screen
            // tiles don't linger with stale data until ActivityKit's stale
            // date elapses.
            for (const sessionId of endedIds) {
              const event: SessionEvent = {
                __typename: 'SessionEnded',
                reason: 'Session ended due to inactivity',
              };
              pubsub.publishSessionEvent(sessionId, event);
              endLiveActivity(sessionId).catch((err) => {
                logger.error(`[APNs] endLiveActivity failed for auto-ended session ${sessionId}:`, err);
              });
            }
          })
          .catch((err) => {
            logger.error('[RoomManager] Inactivity sweep failed:', err);
          });
      }, INACTIVITY_SWEEP_INTERVAL_MS);
      this.inactivitySweepInterval.unref();
      logger.info(
        `[RoomManager] Inactivity sweep enabled (threshold ${INACTIVITY_THRESHOLD_MS / 60000}m, interval ${INACTIVITY_SWEEP_INTERVAL_MS / 60000}m)`,
      );
    }
  }

  /**
   * Shutdown RoomManager and clean up distributed state.
   */
  async shutdown(): Promise<void> {
    await this.flushPendingWrites();
    if (this.inactivitySweepInterval) {
      clearInterval(this.inactivitySweepInterval);
      this.inactivitySweepInterval = null;
    }
    await shutdownDistributedState();
    logger.info('[RoomManager] Shutdown complete');
  }

  /**
   * Check if distributed state is enabled (multi-instance mode).
   */
  isDistributedStateEnabled(): boolean {
    return this.distributedState !== null;
  }

  async registerClient(connectionId: string, username?: string, userId?: string, avatarUrl?: string): Promise<string> {
    return registerClientFn(connectionId, this.clients, this.distributedState, username, userId, avatarUrl);
  }

  getClient(connectionId: string): ConnectedClient | undefined {
    return this.clients.get(connectionId);
  }

  getClientById(clientId: string): ConnectedClient | undefined {
    return this.clients.get(clientId);
  }

  async joinSession(
    connectionId: string,
    sessionId: string,
    boardPath: string,
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
    return joinSessionFn(
      connectionId,
      sessionId,
      boardPath,
      this.clients,
      this.sessions,
      this.sessionParticipants,
      this.redisStore,
      this.distributedState,
      this.writeScheduler,
      this.sessionGraceTimers,
      this.pendingJoinPersists,
      (sid) => this.getQueueState(sid),
      (sid) => this.getSessionUsers(sid),
      (sid) => this.getSessionUsersLocal(sid),
      (sid) => this.getSessionById(sid),
      (sid, q, c, v) => this.updateQueueStateImmediate(sid, q, c, v),
      (cid) => this.leaveSession(cid),
      username,
      avatarUrl,
      initialQueue,
      initialCurrentClimb,
      sessionName,
      participantId,
    );
  }

  async leaveSession(connectionId: string): Promise<SessionLeaveResult | null> {
    // Free this connection's wall links before the leave drops it from the
    // client map (per-connection, so a sibling connection doesn't keep the slot
    // stuck).
    await this.releaseWallLinksForConnection(connectionId);
    const result = await leaveSessionFn(
      connectionId,
      this.clients,
      this.sessions,
      this.sessionParticipants,
      this.redisStore,
      this.distributedState,
      this.writeScheduler,
      this.sessionGraceTimers,
      this.pendingJoinPersists,
      this.SESSION_GRACE_PERIOD_MS,
    );
    if (result?.participantFullyLeft && result.participantId) {
      // Explicit leave (vs. transient disconnect) drains the participant
      // immediately, so the driver role must follow. The disconnect path
      // handles its own cleanup via the grace-timer eviction callback.
      //
      // `participantFullyLeft` is computed from local-instance state in
      // client-lifecycle.ts. In multi-instance deploys an authenticated user
      // with tabs on instances A and B who closes their only A tab will hit
      // this branch with `participantFullyLeft=true` even though the same
      // participantId is still connected on B. Without a global guard,
      // releaseDriverIfMatches would yank the driver out from under the
      // still-active sibling tab. `releaseDriverIfMatches` re-checks global
      // participant-liveness before mutating Redis.
      const departingSessionId = result.sessionId;
      const departingParticipantId = result.participantId;
      this.releaseDriverIfMatches(departingSessionId, departingParticipantId).catch((err) => {
        logger.error(
          `[RoomManager] Unhandled error releasing driver for ${departingParticipantId.slice(0, 8)} after leave in session ${departingSessionId.slice(0, 8)}:`,
          err,
        );
      });
    }
    return result;
  }

  async disconnectClient(connectionId: string): Promise<SessionDisconnectResult | null> {
    // The wall link is bound to the physical connection: free any board THIS
    // connection held the moment its socket drops, before the (participant-
    // level, grace-gated) driver cleanup runs. This is what frees a crashed BLE
    // holder whose participant still has a sibling connection. On a transient
    // reconnect the client re-announces (participantId resets on re-join), so
    // the brief release is reclaimed.
    await this.releaseWallLinksForConnection(connectionId);
    return disconnectClientFn(
      connectionId,
      this.clients,
      this.sessions,
      this.sessionParticipants,
      this.redisStore,
      this.distributedState,
      this.writeScheduler,
      this.sessionGraceTimers,
      this.pendingJoinPersists,
      this.SESSION_GRACE_PERIOD_MS,
      (sessionId, participantId) => {
        pubsub.publishSessionEvent(sessionId, {
          __typename: 'UserLeft',
          userId: participantId,
        });
        // If the evicted participant was the wall driver, clear and broadcast
        // so peers' Queue Control Bar UI flips out of the "{name} is driving"
        // state. Done after UserLeft so single-instance subscribers process
        // them in order. Across instances the two events flow through Redis
        // pub/sub independently and their relative arrival order at a remote
        // subscriber is not guaranteed — the spec tolerates this because
        // driver and presence are independent state machines.
        //
        // The grace-timer callback runs even when the participant has live
        // sibling connections on another instance (their absence is detected
        // locally first). `releaseDriverIfMatches` re-checks global liveness
        // before mutating Redis to avoid yanking the driver out from under
        // a still-active sibling tab.
        this.releaseDriverIfMatches(sessionId, participantId).catch((err) => {
          logger.error(
            `[RoomManager] Unhandled error releasing driver for ${participantId.slice(0, 8)} on grace-timer eviction in session ${sessionId.slice(0, 8)}:`,
            err,
          );
        });
      },
    );
  }

  /**
   * If the named participant currently holds the wall driver role, clear it
   * and publish `DriverChanged { driverParticipantId: null }`. No-op when the
   * participant is not the driver. Used on disconnect and explicit-leave
   * cleanup paths so the wall doesn't stay assigned to a vanished member.
   *
   * Multi-instance safety: callers can only see local-instance state when
   * they decide to fire this cleanup (`participantFullyLeft` and the
   * grace-timer's local participant map are both per-instance). Before
   * touching Redis we re-check global liveness via
   * `getParticipantLiveConnectionCount` — if the same participant still has
   * a live connection on another backend instance (multi-tab user across
   * instances), we skip the release. Without this gate, closing a sibling
   * tab on instance A would yank the wall out from under the same user
   * still happily driving on instance B with their lightbulb lit.
   */
  private async releaseDriverIfMatches(sessionId: string, participantId: string): Promise<void> {
    try {
      if (this.distributedState) {
        let liveConnections: number;
        try {
          liveConnections = await this.distributedState.getParticipantLiveConnectionCount(sessionId, participantId);
        } catch (err) {
          // Conservative: if Redis can't answer the liveness query, do not
          // yank the driver. A spurious release is worse than leaving the
          // driver assigned briefly — the next legitimate take-control will
          // overwrite it.
          logger.error(
            `[RoomManager] Failed to count live connections for ${participantId.slice(0, 8)} during driver release in session ${sessionId.slice(0, 8)}; keeping driver as-is:`,
            err,
          );
          return;
        }
        if (liveConnections > 0) {
          // Still active somewhere — sibling tab on another instance, or a
          // grace-window reconnect raced this cleanup. Leave the driver
          // alone; the participant will either reclaim cleanly or fire
          // their own release later.
          return;
        }
      }

      const cleared = await this.clearSessionDriverIf(sessionId, participantId);
      if (cleared) {
        // We just confirmed `participantId` was the driver before the clear,
        // so it is the previousDriverParticipantId for the resulting event.
        pubsub.publishSessionEvent(sessionId, {
          __typename: 'DriverChanged',
          driverParticipantId: null,
          previousDriverParticipantId: participantId,
        });
      }

      // Same disconnect, same liveness gate: free any board the departing
      // member held the BLE connection for, so the shared "wall connected"
      // indicator clears and the next connector can claim the writer slot.
      const releasedBoards = await this.releaseAllWallConnectionsForParticipant(sessionId, participantId);
      for (const boardId of releasedBoards) {
        pubsub.publishSessionEvent(sessionId, {
          __typename: 'WallConnectionChanged',
          boardId,
          holderParticipantId: null,
        });
      }
    } catch (error) {
      logger.error(
        `[RoomManager] Failed to release driver for departing participant ${participantId.slice(0, 8)} in session ${sessionId.slice(0, 8)}:`,
        error,
      );
    }
  }

  async removeClient(connectionId: string): Promise<{ distributedStateCleanedUp: boolean }> {
    return removeClientFn(connectionId, this.clients, this.sessions, this.distributedState);
  }

  /**
   * Get session users from all instances (async, uses distributed state if available).
   */
  async getSessionUsers(sessionId: string): Promise<SessionUser[]> {
    if (this.distributedState) {
      return this.distributedState.getSessionMembers(sessionId);
    }
    return this.getSessionUsersLocal(sessionId);
  }

  /**
   * Get session users from local instance only.
   */
  getSessionUsersLocal(sessionId: string): SessionUser[] {
    const participants = this.sessionParticipants.get(sessionId);
    if (participants && participants.size > 0) {
      return Array.from(participants.values()).map((participant) => ({
        id: participant.id,
        username: participant.username,
        isLeader: participant.isLeader,
        avatarUrl: participant.avatarUrl,
        userId: participant.userId,
        connectionState: participant.connectionState,
      }));
    }

    const sessionClientIds = this.sessions.get(sessionId);
    if (!sessionClientIds) return [];
    const users: SessionUser[] = [];
    for (const clientId of sessionClientIds) {
      const client = this.clients.get(clientId);
      if (client) {
        users.push({
          id: client.participantId || client.connectionId,
          username: client.username,
          isLeader: client.isLeader,
          avatarUrl: client.avatarUrl,
          userId: client.userId,
          connectionState: 'CONNECTED',
        });
      }
    }
    return users;
  }

  getSessionClients(sessionId: string): string[] {
    const session = this.sessions.get(sessionId);
    return session ? Array.from(session) : [];
  }

  /**
   * Get the authoritative leader connectionId for a session from distributed
   * state. Returns null when the session has no leader (or single-instance
   * mode falls back to local view). Use this instead of `SessionUser.isLeader`
   * for authorization checks — that field can be momentarily stale during
   * leader handoff, and a participant whose local `isLeader=true` reflects a
   * stale read could pass an authorization check after the leader has
   * already moved on.
   */
  async getSessionLeaderConnectionId(sessionId: string): Promise<string | null> {
    if (this.distributedState) {
      return this.distributedState.getSessionLeader(sessionId);
    }
    const clients = this.sessions.get(sessionId);
    if (!clients) return null;
    for (const clientId of clients) {
      const client = this.clients.get(clientId);
      if (client?.isLeader) return clientId;
    }
    return null;
  }

  /**
   * Get the current wall driver's participantId for a session, or null when
   * the wall is unclaimed. Driver is the wall-control authority introduced
   * by the queue-control-bar pivot's lightbulb gesture; distinct from leader
   * (which is presentation/legacy). Falls back to in-memory when running
   * without distributed state.
   */
  async getSessionDriverParticipantId(sessionId: string): Promise<string | null> {
    if (this.distributedState) {
      return this.distributedState.getSessionDriver(sessionId);
    }
    return this.localDriverBySession.get(sessionId) ?? null;
  }

  /**
   * Set the current wall driver atomically and return the previous driver
   * (or null when unclaimed). Yank-on-press: overwrites any prior driver.
   *
   * Atomicity matters: the `takeControl` resolver decides whether to publish
   * `DriverChanged` based on whether this was a transition. Without atomicity,
   * two concurrent yanks could each read the same previous driver and both
   * publish DriverChanged in arbitrary order — leaving subscribers' state
   * divergent from Redis. Both the distributed (Redis GETSET) and in-memory
   * paths return the previous value to keep callers consistent across modes.
   *
   * When `distributedState` is set, Redis is the only source of truth — the
   * in-memory shadow is a single-instance fallback for no-Redis deploys and is
   * not touched on the distributed path. Maintaining a parallel shadow under
   * Redis just creates a window where a read might see the local write before
   * Redis has acknowledged it; the simpler invariant is "Redis or shadow,
   * never both."
   */
  async setSessionDriverAndReturnPrevious(sessionId: string, participantId: string): Promise<string | null> {
    if (this.distributedState) {
      return this.distributedState.setSessionDriverAndReturnPrevious(sessionId, participantId);
    }
    // Single-instance (no Redis): the in-memory shadow is the source of truth.
    // Read-then-write is atomic in JS, so no extra ordering guard is needed.
    const previousLocal = this.localDriverBySession.get(sessionId) ?? null;
    this.localDriverBySession.set(sessionId, participantId);
    return previousLocal;
  }

  /**
   * Conditionally clear the driver — only when the current driver matches
   * `expectedParticipantId`. Returns true when the clear happened (caller was
   * the driver). Used by releaseControl mutation.
   */
  async clearSessionDriverIf(sessionId: string, expectedParticipantId: string): Promise<boolean> {
    if (this.distributedState) {
      return this.distributedState.clearSessionDriverIf(sessionId, expectedParticipantId);
    }
    if (this.localDriverBySession.get(sessionId) === expectedParticipantId) {
      this.localDriverBySession.delete(sessionId);
      return true;
    }
    return false;
  }

  /**
   * Claim-if-free the wall-connection slot for a board: the first member with a
   * live BLE link holds it and writes frames; later connectors to the same
   * board don't steal it. Returns the resulting holder and whether THIS call
   * claimed it (so `announceWallLink` only broadcasts on an actual transition).
   */
  async claimWallConnection(
    sessionId: string,
    boardId: number,
    participantId: string,
  ): Promise<{ holderParticipantId: string; didClaim: boolean }> {
    if (this.distributedState) {
      return this.distributedState.claimWallConnection(sessionId, boardId, participantId);
    }
    let board = this.localWallConnectionsBySession.get(sessionId);
    if (!board) {
      board = new Map();
      this.localWallConnectionsBySession.set(sessionId, board);
    }
    const existing = board.get(boardId);
    if (existing === undefined) {
      board.set(boardId, participantId);
      return { holderParticipantId: participantId, didClaim: true };
    }
    return { holderParticipantId: existing, didClaim: false };
  }

  /** Release a board's wall-connection slot when the caller holds it. */
  async releaseWallConnection(sessionId: string, boardId: number, expectedParticipantId: string): Promise<boolean> {
    if (this.distributedState) {
      return this.distributedState.releaseWallConnection(sessionId, boardId, expectedParticipantId);
    }
    const board = this.localWallConnectionsBySession.get(sessionId);
    if (board?.get(boardId) === expectedParticipantId) {
      board.delete(boardId);
      if (board.size === 0) this.localWallConnectionsBySession.delete(sessionId);
      return true;
    }
    return false;
  }

  /**
   * Record that a connection successfully claimed a board's wall link, so the
   * claim can be freed per-connection when that connection drops. Only the
   * connection that actually claimed records it (the resolver calls this on
   * `didClaim`), so it never frees a slot it doesn't hold.
   */
  recordWallLinkForConnection(connectionId: string, boardId: number): void {
    const client = this.clients.get(connectionId);
    if (!client) return;
    (client.announcedWallBoards ??= new Set()).add(boardId);
  }

  /** Forget a connection's wall-link claim (explicit revoke). */
  forgetWallLinkForConnection(connectionId: string, boardId: number): void {
    this.clients.get(connectionId)?.announcedWallBoards?.delete(boardId);
  }

  /**
   * Free every wall link this connection holds, broadcasting
   * WallConnectionChanged(null) per board. Bound to the connection, not the
   * participant: a crashed BLE-holder connection's slot frees immediately even
   * when the same participant still has a sibling connection alive (the old
   * participant-liveness gate left it stuck). `releaseWallConnection` is a no-op
   * if someone else now holds the slot, so a non-holder connection frees
   * nothing.
   */
  private async releaseWallLinksForConnection(connectionId: string): Promise<void> {
    const client = this.clients.get(connectionId);
    if (!client?.sessionId || !client.announcedWallBoards?.size) return;
    const sessionId = client.sessionId;
    const participantId = client.participantId ?? connectionId;
    const boards = [...client.announcedWallBoards];
    client.announcedWallBoards.clear();
    for (const boardId of boards) {
      try {
        const released = await this.releaseWallConnection(sessionId, boardId, participantId);
        if (released) {
          pubsub.publishSessionEvent(sessionId, {
            __typename: 'WallConnectionChanged',
            boardId,
            holderParticipantId: null,
          });
        }
      } catch (error) {
        logger.error(
          `[RoomManager] Failed to release wall link for connection ${connectionId.slice(0, 8)} board ${boardId}:`,
          error,
        );
      }
    }
  }

  /** All current wall-connection holders for a session, keyed by boardId. */
  async getWallConnections(sessionId: string): Promise<Map<number, string>> {
    if (this.distributedState) {
      return this.distributedState.getWallConnections(sessionId);
    }
    return new Map(this.localWallConnectionsBySession.get(sessionId) ?? []);
  }

  /** Release every board this participant held (disconnect cleanup); returns freed boardIds. */
  async releaseAllWallConnectionsForParticipant(sessionId: string, participantId: string): Promise<number[]> {
    if (this.distributedState) {
      return this.distributedState.releaseAllWallConnectionsForParticipant(sessionId, participantId);
    }
    const board = this.localWallConnectionsBySession.get(sessionId);
    if (!board) return [];
    const released: number[] = [];
    for (const [boardId, holder] of board) {
      if (holder === participantId) {
        board.delete(boardId);
        released.push(boardId);
      }
    }
    if (board.size === 0) this.localWallConnectionsBySession.delete(sessionId);
    return released;
  }

  /**
   * Get the most recently observed BLE board serial for a session, or null
   * when no participant has paired yet. Mobile clients use this on join to
   * skip the chooser screen when another participant has already paired.
   */
  async getSessionBoardSerial(sessionId: string): Promise<string | null> {
    if (this.distributedState) {
      return this.distributedState.getSessionBoardSerial(sessionId);
    }
    return this.localBoardSerialBySession.get(sessionId) ?? null;
  }

  /**
   * Set the session's last-connected BLE board serial and return the previous
   * value atomically (or null when unset). Same pattern as
   * `setSessionDriverAndReturnPrevious` — the caller compares previous vs.
   * new to decide whether to broadcast `SessionBoardSerialChanged`, so
   * concurrent writes can't both fire redundant events for the same value.
   *
   * When `distributedState` is set, Redis is the only source of truth — the
   * in-memory shadow is a single-instance fallback for no-Redis deploys and is
   * not touched on the distributed path.
   */
  async setSessionBoardSerialAndReturnPrevious(sessionId: string, serial: string): Promise<string | null> {
    if (this.distributedState) {
      return this.distributedState.setSessionBoardSerialAndReturnPrevious(sessionId, serial);
    }
    // Single-instance (no Redis): the in-memory shadow is the source of truth.
    const previousLocal = this.localBoardSerialBySession.get(sessionId) ?? null;
    this.localBoardSerialBySession.set(sessionId, serial);
    return previousLocal;
  }

  /**
   * Record a climbUuid as one of this session's recent authoritative current
   * climbs. Called from queue-navigation whenever the wall climb changes, so
   * `confirmClimbOnWall` can accept a confirm that arrives in the small window
   * between the BLE write completing and the driver quickly navigating on.
   *
   * No-op for empty climbUuids (e.g. wall cleared with item: null).
   */
  async pushRecentClimb(sessionId: string, climbUuid: string): Promise<void> {
    if (!climbUuid) return;
    if (this.distributedState) {
      await this.distributedState.pushRecentClimb(sessionId, climbUuid);
      return;
    }
    const buffer = this.localRecentClimbsBySession.get(sessionId) ?? [];
    buffer.unshift(climbUuid);
    this.localRecentClimbsBySession.set(sessionId, buffer.slice(0, RECENT_CLIMBS_BUFFER_SIZE));
  }

  /**
   * Check whether a climbUuid is in this session's recent-climbs ring buffer.
   * Used by `confirmClimbOnWall`'s correlation check.
   */
  async isRecentClimb(sessionId: string, climbUuid: string): Promise<boolean> {
    if (!climbUuid) return false;
    if (this.distributedState) {
      return this.distributedState.isRecentClimb(sessionId, climbUuid);
    }
    const buffer = this.localRecentClimbsBySession.get(sessionId);
    return buffer ? buffer.includes(climbUuid) : false;
  }

  /**
   * Check if a session is active (has connected users across all instances OR exists in Redis within TTL)
   */
  async isSessionActive(sessionId: string): Promise<boolean> {
    if (this.distributedState) {
      const hasMembers = await this.distributedState.hasSessionMembers(sessionId);
      if (hasMembers) {
        return true;
      }
    } else {
      const participantCount = this.sessions.get(sessionId)?.size || 0;
      if (participantCount > 0) {
        return true;
      }
    }

    if (this.redisStore) {
      return this.redisStore.exists(sessionId);
    }
    return false;
  }

  async updateUsername(connectionId: string, username: string, avatarUrl?: string): Promise<void> {
    const client = this.clients.get(connectionId);
    if (client) {
      client.username = username;
      if (avatarUrl !== undefined) {
        client.avatarUrl = avatarUrl;
      }

      if (this.distributedState) {
        await this.distributedState.updateUsername(connectionId, username, avatarUrl);
      }
    }
  }

  async updateQueueState(
    sessionId: string,
    queue: ClimbQueueItem[],
    currentClimbQueueItem: ClimbQueueItem | null,
    expectedVersion?: number,
  ): Promise<{ version: number; sequence: number; stateHash: string; previousStateHash: string | null }> {
    return updateQueueStateFn(
      sessionId,
      queue,
      currentClimbQueueItem,
      expectedVersion,
      this.redisStore,
      this.writeScheduler,
      this.distributedState,
    );
  }

  async updateQueueStateImmediate(
    sessionId: string,
    queue: ClimbQueueItem[],
    currentClimbQueueItem: ClimbQueueItem | null,
    expectedVersion?: number,
  ): Promise<number> {
    return updateQueueStateImmediateFn(sessionId, queue, currentClimbQueueItem, expectedVersion, this.redisStore);
  }

  async updateQueueOnly(
    sessionId: string,
    queue: ClimbQueueItem[],
    expectedVersion?: number,
  ): Promise<{ version: number; sequence: number; stateHash: string }> {
    return updateQueueOnlyFn(
      sessionId,
      queue,
      expectedVersion,
      this.redisStore,
      this.writeScheduler,
      this.distributedState,
    );
  }

  async getQueueState(sessionId: string): Promise<QueueState> {
    return getQueueStateFn(sessionId, this.redisStore);
  }

  async getSessionById(sessionId: string): Promise<Session | null> {
    return getSessionByIdFn(sessionId);
  }

  /**
   * Update the session's stored boardPath, returning the previous value when
   * a change actually occurred, or `null` for no-op writes (idempotent).
   * Used by the `setSessionBoardPath` mutation to gate the
   * `SessionBoardPathChanged` event.
   */
  async updateSessionBoardPathIfChanged(sessionId: string, boardPath: string): Promise<string | null> {
    return updateSessionBoardPathIfChangedFn(sessionId, boardPath);
  }

  async createDiscoverableSession(
    sessionId: string,
    boardPath: string,
    userId: string,
    latitude: number,
    longitude: number,
    name?: string,
    goal?: string,
    isPermanent?: boolean,
    color?: string,
  ): Promise<Session> {
    return createDiscoverableSessionFn(
      sessionId,
      boardPath,
      userId,
      latitude,
      longitude,
      name,
      goal,
      isPermanent,
      color,
    );
  }

  async findNearbySessions(latitude: number, longitude: number, radiusMeters?: number): Promise<DiscoverableSession[]> {
    return findNearbySessionsFn(
      latitude,
      longitude,
      radiusMeters,
      this.sessions,
      this.redisStore,
      this.distributedState,
    );
  }

  async getUserSessions(userId: string): Promise<Session[]> {
    return getUserSessionsFn(userId);
  }

  async endSession(sessionId: string): Promise<void> {
    // Drop the in-memory driver / board-serial shadows for this session
    // before delegating to the discovery layer. The shadows are local to
    // this RoomManager instance and were growing unbounded across session
    // lifecycles — endSession is the only deterministic hook to clear them.
    // Distributed-state's Redis keys for these are cleaned up by
    // `cleanupEmptySession` when the session set drains; this is the
    // single-instance / single-process equivalent.
    this.localDriverBySession.delete(sessionId);
    this.localWallConnectionsBySession.delete(sessionId);
    this.localBoardSerialBySession.delete(sessionId);
    this.localRecentClimbsBySession.delete(sessionId);
    return endSessionFn(
      sessionId,
      this.sessions,
      this.redisStore,
      this.writeScheduler,
      this.sessionGraceTimers,
      this.pendingJoinPersists,
    );
  }

  async flushPendingWrites(): Promise<void> {
    return this.writeScheduler.flushPendingWrites(this.sessionGraceTimers);
  }

  async refreshActiveSessionTTLs(): Promise<void> {
    const store = this.redisStore;
    if (!store) return;

    const activeSessions = Array.from(this.sessions.keys());
    if (activeSessions.length === 0) return;

    logger.info(`[RoomManager] Refreshing TTL for ${activeSessions.length} active sessions`);

    const batchSize = 50;
    for (let i = 0; i < activeSessions.length; i += batchSize) {
      const batch = activeSessions.slice(i, i + batchSize);
      await Promise.all(
        batch.map((sessionId) =>
          store
            .refreshTTL(sessionId)
            .catch((err) => logger.error(`[RoomManager] TTL refresh failed for ${sessionId}:`, err)),
        ),
      );
    }
  }
}

export { RoomManager };
