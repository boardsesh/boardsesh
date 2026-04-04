import type Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import type { SessionUser } from '@boardsesh/shared-schema';
import { KEYS, type DistributedConnection } from './constants';
import {
  registerConnection,
  getConnection,
  removeConnection,
  updateUsername,
} from './connection-ops';
import {
  joinSession,
  leaveSession,
  getSessionMembers,
  getSessionLeader,
  getSessionMemberCount,
  isConnectionInSession,
  refreshConnection,
  refreshSessionMembership,
  hasSessionMembers,
  cleanupStaleSessionMembers,
  cleanupEmptySession,
} from './session-ops';
import {
  updateHeartbeat,
  discoverDeadInstances,
  cleanupDeadInstanceConnections,
  cleanupInstanceConnections,
} from './heartbeat';

/**
 * DistributedStateManager provides cross-instance state management for:
 * - Connection tracking
 * - Session membership
 * - Leader election
 *
 * This enables true horizontal scaling without sticky sessions.
 */
export class DistributedStateManager {
  private readonly instanceId: string;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private consecutiveHeartbeatFailures = 0;
  private heartbeatCount = 0;
  private readonly maxHeartbeatFailures = 5;
  private readonly cleanupEveryNHeartbeats = 4; // Every 4th heartbeat = ~2 minutes
  private isHealthy = true;

  constructor(
    private readonly redis: Redis,
    instanceId?: string
  ) {
    this.instanceId = instanceId || uuidv4();
  }

  /** Get this instance's unique ID. */
  getInstanceId(): string {
    return this.instanceId;
  }

  /** Check if the distributed state manager is healthy (heartbeat succeeding). */
  isRedisHealthy(): boolean {
    return this.isHealthy;
  }

  /** Start the heartbeat and cleanup background tasks. */
  start(): void {
    if (this.heartbeatInterval) {
      return;
    }

    this.heartbeatInterval = setInterval(() => {
      this.updateHeartbeatWithRecovery();
    }, 30_000);

    // Initial heartbeat
    this.updateHeartbeatWithRecovery();

    // Clean up connections from dead instances asynchronously on startup
    this.cleanupDeadInstanceConnections().catch((err) => {
      console.error('[DistributedState] Startup dead instance cleanup failed:', err);
    });

    console.log(`[DistributedState] Started with instance ID: ${this.instanceId.slice(0, 8)}`);
  }

  /** Stop background tasks and clean up instance state. */
  async stop(): Promise<void> {
    this.stopHeartbeat();
    await cleanupInstanceConnections(this.redis, this.instanceId);
    console.log(`[DistributedState] Stopped instance: ${this.instanceId.slice(0, 8)}`);
  }

  /** Stop only the heartbeat interval synchronously. */
  stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /** Check if the manager has been stopped (heartbeat cleared). */
  isStopped(): boolean {
    return this.heartbeatInterval === null;
  }

  /** Register a new connection in distributed state. */
  async registerConnection(
    connectionId: string,
    username: string,
    userId?: string | null,
    avatarUrl?: string | null
  ): Promise<void> {
    return registerConnection(this.redis, this.instanceId, connectionId, username, userId, avatarUrl);
  }

  /** Remove a connection from distributed state. */
  async removeConnection(
    connectionId: string,
    electNewLeader: boolean = true
  ): Promise<{ sessionId: string | null; wasLeader: boolean; newLeaderId: string | null }> {
    return removeConnection(this.redis, this.instanceId, connectionId, electNewLeader);
  }

  /** Get connection data from Redis. */
  async getConnection(connectionId: string): Promise<DistributedConnection | null> {
    return getConnection(this.redis, connectionId);
  }

  /** Check if a connection exists and belongs to a specific session. */
  async isConnectionInSession(connectionId: string, sessionId: string): Promise<boolean> {
    return isConnectionInSession(this.redis, connectionId, sessionId);
  }

  /** Join a session. Handles leader election for first member. */
  async joinSession(
    connectionId: string,
    sessionId: string,
    username?: string,
    avatarUrl?: string | null
  ): Promise<{ isLeader: boolean }> {
    return joinSession(this.redis, connectionId, sessionId, username, avatarUrl);
  }

  /** Leave a session. Handles leader election if leaving member was leader. */
  async leaveSession(
    connectionId: string,
    sessionId: string
  ): Promise<{ newLeaderId: string | null }> {
    return leaveSession(this.redis, connectionId, sessionId);
  }

  /** Get all members of a session as SessionUser objects. */
  async getSessionMembers(sessionId: string): Promise<SessionUser[]> {
    return getSessionMembers(this.redis, sessionId);
  }

  /** Get the current leader of a session. */
  async getSessionLeader(sessionId: string): Promise<string | null> {
    return getSessionLeader(this.redis, sessionId);
  }

  /** Get count of live members in a session. */
  async getSessionMemberCount(sessionId: string): Promise<number> {
    return getSessionMemberCount(this.redis, sessionId);
  }

  /** Update connection username. */
  async updateUsername(connectionId: string, username: string, avatarUrl?: string): Promise<void> {
    return updateUsername(this.redis, connectionId, username, avatarUrl);
  }

  /** Refresh connection TTL and session membership TTL atomically. */
  async refreshConnection(connectionId: string): Promise<boolean> {
    return refreshConnection(this.redis, connectionId);
  }

  /** Refresh session membership TTL directly (for long-running sessions). */
  async refreshSessionMembership(sessionId: string): Promise<void> {
    return refreshSessionMembership(this.redis, sessionId);
  }

  /** Check if session has any live members. */
  async hasSessionMembers(sessionId: string): Promise<boolean> {
    return hasSessionMembers(this.redis, sessionId);
  }

  /** Prune stale members from a single session. */
  async cleanupStaleSessionMembers(sessionId: string): Promise<number> {
    return cleanupStaleSessionMembers(this.redis, sessionId);
  }

  /** Discover instance IDs whose heartbeat has expired (dead instances). */
  async discoverDeadInstances(): Promise<string[]> {
    return discoverDeadInstances(this.redis, this.instanceId);
  }

  /** Clean up connections from dead backend instances. */
  async cleanupDeadInstanceConnections(): Promise<{
    deadInstances: string[];
    staleConnections: string[];
    sessionsAffected: string[];
  }> {
    return cleanupDeadInstanceConnections(this.redis, this.instanceId);
  }

  /** Clean up session state when it becomes empty. */
  async cleanupEmptySession(sessionId: string): Promise<void> {
    return cleanupEmptySession(this.redis, sessionId);
  }

  /**
   * Prune stale members from sessions that this instance's connections belong to.
   * Catches cases where a connection on THIS instance died but wasn't cleaned up
   * (e.g., half-open TCP between ping intervals).
   */
  private async cleanupActiveSessionMembers(): Promise<void> {
    const connectionIds = await this.redis.smembers(KEYS.instanceConnections(this.instanceId));
    if (connectionIds.length === 0) return;

    const pipeline = this.redis.pipeline();
    for (const connId of connectionIds) {
      pipeline.hget(KEYS.connection(connId), 'sessionId');
    }
    const results = await pipeline.exec();

    const sessionIds = new Set<string>();
    if (results) {
      for (const [err, sessionId] of results) {
        if (!err && sessionId && typeof sessionId === 'string' && sessionId !== '') {
          sessionIds.add(sessionId);
        }
      }
    }

    for (const sessionId of sessionIds) {
      await cleanupStaleSessionMembers(this.redis, sessionId);
    }
  }

  /** Update heartbeat with automatic recovery on failure. */
  private async updateHeartbeatWithRecovery(): Promise<void> {
    try {
      await updateHeartbeat(this.redis, this.instanceId);

      // Heartbeat succeeded - reset failure counter and restore health
      if (this.consecutiveHeartbeatFailures > 0) {
        console.log(
          `[DistributedState] Heartbeat recovered after ${this.consecutiveHeartbeatFailures} failures`
        );
        this.consecutiveHeartbeatFailures = 0;
      }
      if (!this.isHealthy) {
        console.log('[DistributedState] Redis connection restored, marking as healthy');
        this.isHealthy = true;
      }

      // Piggyback cleanup on every Nth heartbeat (~2 min)
      this.heartbeatCount++;
      if (this.heartbeatCount % this.cleanupEveryNHeartbeats === 0) {
        // Clean up connections from dead backend instances
        this.cleanupDeadInstanceConnections().catch((err) => {
          console.error('[DistributedState] Periodic dead instance cleanup failed:', err);
        });
        // Clean up stale members from sessions this instance participates in
        this.cleanupActiveSessionMembers().catch((err) => {
          console.error('[DistributedState] Periodic active session cleanup failed:', err);
        });
      }
    } catch (err) {
      this.consecutiveHeartbeatFailures++;
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';

      if (this.consecutiveHeartbeatFailures >= this.maxHeartbeatFailures) {
        if (this.isHealthy) {
          console.error(
            `[DistributedState] Heartbeat failed ${this.consecutiveHeartbeatFailures} times, ` +
              `marking as unhealthy: ${errorMessage}`
          );
          this.isHealthy = false;
        }
      } else {
        console.warn(
          `[DistributedState] Heartbeat failed (${this.consecutiveHeartbeatFailures}/${this.maxHeartbeatFailures}): ${errorMessage}`
        );
      }
    }
  }
}
