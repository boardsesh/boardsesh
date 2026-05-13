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
import {
  getSessionById as getSessionByIdFn,
  createDiscoverableSession as createDiscoverableSessionFn,
  findNearbySessions as findNearbySessionsFn,
  getUserSessions as getUserSessionsFn,
  endSession as endSessionFn,
  endStaleInactiveSessions,
} from './session-discovery';

const INACTIVITY_THRESHOLD_MS = 60 * 60 * 1000;
const INACTIVITY_SWEEP_INTERVAL_MS = 60 * 1000;

class RoomManager {
  private clients = new Map<string, ConnectedClient>();
  private sessions = new Map<string, Set<string>>();
  private sessionParticipants = new Map<string, Map<string, LocalSessionParticipant>>();
  private redisStore: RedisSessionStore | null = null;
  private distributedState: DistributedStateManager | null = null;
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
      console.info('[RoomManager] Redis session storage enabled');

      this.distributedState = initializeDistributedState(redis);
      this.distributedState.start();
      console.info('[RoomManager] Distributed state enabled for multi-instance support');
    } else {
      console.info('[RoomManager] Redis not available - using Postgres only mode (single instance)');
    }

    if (!this.inactivitySweepInterval) {
      this.inactivitySweepInterval = setInterval(() => {
        endStaleInactiveSessions(INACTIVITY_THRESHOLD_MS).catch((err) => {
          console.error('[RoomManager] Inactivity sweep failed:', err);
        });
      }, INACTIVITY_SWEEP_INTERVAL_MS);
      this.inactivitySweepInterval.unref();
      console.info(
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
    console.info('[RoomManager] Shutdown complete');
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
    return leaveSessionFn(
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
    return endSessionFn(
      sessionId,
      this.sessions,
      this.sessionParticipants,
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

    console.info(`[RoomManager] Refreshing TTL for ${activeSessions.length} active sessions`);

    const batchSize = 50;
    for (let i = 0; i < activeSessions.length; i += batchSize) {
      const batch = activeSessions.slice(i, i + batchSize);
      await Promise.all(
        batch.map((sessionId) =>
          store
            .refreshTTL(sessionId)
            .catch((err) => console.error(`[RoomManager] TTL refresh failed for ${sessionId}:`, err)),
        ),
      );
    }
  }
}

export { RoomManager };
