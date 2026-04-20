import type Redis from 'ioredis';
import type { ClimbQueueItem, SessionUser, BoardConfig } from '@boardsesh/shared-schema';
import { RedisSessionStore } from '../redis-session-store';
import type { Session } from '../../db/schema';
import {
  DistributedStateManager,
  initializeDistributedState,
  shutdownDistributedState,
  forceResetDistributedState,
} from '../distributed-state';
import type { ConnectedClient, DiscoverableSession, QueueState } from './types';
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
  removeClient as removeClientFn,
} from './client-lifecycle';
import {
  getSessionById as getSessionByIdFn,
  createDiscoverableSession as createDiscoverableSessionFn,
  findNearbySessions as findNearbySessionsFn,
  getUserSessions as getUserSessionsFn,
  endSession as endSessionFn,
} from './session-discovery';

class RoomManager {
  private clients: Map<string, ConnectedClient> = new Map();
  private sessions: Map<string, Set<string>> = new Map();
  private redisStore: RedisSessionStore | null = null;
  private distributedState: DistributedStateManager | null = null;
  private sessionGraceTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly SESSION_GRACE_PERIOD_MS = 60_000;
  private pendingJoinPersists = new Map<string, Promise<void>>();
  private writeScheduler = new WriteScheduler();

  /**
   * Reset all state (for testing purposes)
   */
  reset(): void {
    this.clients.clear();
    this.sessions.clear();
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
      console.log('[RoomManager] Redis session storage enabled');

      this.distributedState = initializeDistributedState(redis);
      this.distributedState.start();
      console.log('[RoomManager] Distributed state enabled for multi-instance support');
    } else {
      console.log('[RoomManager] Redis not available - using Postgres only mode (single instance)');
    }
  }

  /**
   * Shutdown RoomManager and clean up distributed state.
   */
  async shutdown(): Promise<void> {
    await this.flushPendingWrites();
    await shutdownDistributedState();
    console.log('[RoomManager] Shutdown complete');
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
  ): Promise<{
    clientId: string;
    users: SessionUser[];
    queue: ClimbQueueItem[];
    currentClimbQueueItem: ClimbQueueItem | null;
    sequence: number;
    stateHash: string;
    isLeader: boolean;
    sessionName: string | null;
  }> {
    return joinSessionFn(
      connectionId,
      sessionId,
      boardPath,
      this.clients,
      this.sessions,
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
    );
  }

  async leaveSession(connectionId: string): Promise<{ sessionId: string; newLeaderId?: string } | null> {
    return leaveSessionFn(
      connectionId,
      this.clients,
      this.sessions,
      this.redisStore,
      this.distributedState,
      this.writeScheduler,
      this.sessionGraceTimers,
      this.pendingJoinPersists,
      this.SESSION_GRACE_PERIOD_MS,
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
    const sessionClientIds = this.sessions.get(sessionId);
    if (!sessionClientIds) return [];

    const users: SessionUser[] = [];
    for (const clientId of sessionClientIds) {
      const client = this.clients.get(clientId);
      if (client) {
        users.push({
          id: client.connectionId,
          username: client.username,
          isLeader: client.isLeader,
          avatarUrl: client.avatarUrl,
          userId: client.userId,
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
  ): Promise<{ version: number; sequence: number; stateHash: string }> {
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

  /**
   * Persist the explicit board roster for a session. Derived queue-board
   * entries are recomputed on read, so this only needs to be called when a
   * session is created with explicit `boards` input.
   */
  async saveSessionBoards(sessionId: string, boards: BoardConfig[]): Promise<void> {
    if (this.redisStore) {
      await this.redisStore.saveBoards(sessionId, boards);
    }
  }

  /**
   * Load the explicit board roster for a session. Returns `[]` when none
   * were persisted.
   */
  async getSessionBoards(sessionId: string): Promise<BoardConfig[]> {
    if (this.redisStore) {
      return this.redisStore.getBoards(sessionId);
    }
    return [];
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
      this.redisStore,
      this.writeScheduler,
      this.sessionGraceTimers,
      this.pendingJoinPersists,
    );
  }

  async flushPendingWrites(): Promise<void> {
    return this.writeScheduler.flushPendingWrites(this.sessionGraceTimers);
  }

  /**
   * Get all active session IDs (for TTL refresh).
   */
  getAllActiveSessions(): string[] {
    return Array.from(this.sessions.keys());
  }
}

export { RoomManager };
