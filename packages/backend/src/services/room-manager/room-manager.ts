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
  // In-memory board-serial fallback for single-instance / no-Redis deploys.
  // Untouched when `distributedState` is set — Redis is then the only source
  // of truth, and parallel-writing here just creates read-after-write
  // skew windows.
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

  /**
   * Record that this connection is the board-presence holder of `boardId` (set
   * from reportBoardClimb after setBoardWriter). The WS-close backstop
   * (clearBoardWriterForConnection) reads this to free the wall if the holder
   * crashes without an explicit reportBoardDisconnect. No-op if the connection
   * isn't registered (e.g. an internal/controller transport without a client).
   */
  noteBoardWriter(connectionId: string, boardId: number, emitterId: string): void {
    const client = this.clients.get(connectionId);
    if (client) {
      client.boardWriterEmitter = { boardId, emitterId };
    }
  }

  /**
   * Crash backstop: when a connection closes, free the board it held — but only
   * if it still holds it. `clearBoardWriterIf` is an atomic compare-and-delete
   * keyed by emitter, so this is a no-op when another emitter has since taken
   * over (always-take) or when this connection never held a board. On a real
   * clear, broadcast `BoardConnectionChanged { holder: null }` so watchers see
   * the wall go free. Non-fatal: a Redis hiccup must never block disconnect
   * cleanup. Must be called while the client record still exists (before
   * disconnectClient/removeClient delete it).
   *
   * When the dropped connection was also bound to a session, publish a
   * session-scoped `WallDisconnected { disconnectedByParticipantId: null }` so
   * remote session members clear their "climb is lit" lightbulb state even when
   * the device crashed/disconnected before it could call the
   * `reportWallDisconnect` mutation. `null` flags this as a system/crash
   * backstop rather than an explicit member report.
   */
  async clearBoardWriterForConnection(connectionId: string): Promise<void> {
    const client = this.clients.get(connectionId);
    const note = client?.boardWriterEmitter;
    if (!note) return;
    const sessionId = client?.sessionId ?? null;
    try {
      const cleared = await pubsub.clearBoardWriterIf(String(note.boardId), note.emitterId);
      if (cleared) {
        const seq = await pubsub.nextBoardSeq(String(note.boardId));
        // `publishBoardPresenceEvent` / `publishSessionEvent` are synchronous
        // (`: void`): they dispatch to local subscribers inline and internally
        // `.catch()` the async Redis publish (see PubSub in pubsub/index.ts), so
        // they neither return a promise nor reject here. The surrounding
        // try/catch is only for the awaited `clearBoardWriterIf` / `nextBoardSeq`.
        pubsub.publishBoardPresenceEvent(String(note.boardId), {
          __typename: 'BoardConnectionChanged',
          holder: null,
          seq,
        });
        // The board-writer held the wall on behalf of a session. Tell that
        // session's members the wall connection dropped so their lightbulb
        // clears — the explicit reportWallDisconnect mutation is the clean
        // path; this fires only when the device couldn't.
        if (sessionId) {
          pubsub.publishSessionEvent(sessionId, {
            __typename: 'WallDisconnected',
            disconnectedByParticipantId: null,
          });
        }
      }
    } catch (error) {
      logger.warn(`[board-presence] backstop clear failed for ${connectionId.slice(0, 8)}: ${String(error)}`);
    }
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
    return result;
  }

  async disconnectClient(connectionId: string): Promise<SessionDisconnectResult | null> {
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
      },
    );
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
   * value atomically (or null when unset). The caller compares previous vs.
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
   * between the BLE write completing and a member quickly navigating on.
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
    // Drop the in-memory board-serial / recent-climbs shadows for this session
    // before delegating to the discovery layer. The shadows are local to
    // this RoomManager instance and were growing unbounded across session
    // lifecycles — endSession is the only deterministic hook to clear them.
    // Distributed-state's Redis keys for these are cleaned up by
    // `cleanupEmptySession` when the session set drains; this is the
    // single-instance / single-process equivalent.
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
