import type Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import type { SessionUser } from '@boardsesh/shared-schema';
import { KEYS, type DistributedConnection } from './constants';
import {
  registerConnection,
  getConnection,
  removeConnection,
  updateUsername,
  countLiveParticipantConnections,
} from './connection-ops';
import {
  joinSession,
  leaveSession,
  getSessionMembers,
  getSessionLeader,
  getSessionDriver,
  setSessionDriverAndReturnPrevious,
  clearSessionDriverIf,
  claimWallConnection,
  releaseWallConnection,
  getWallConnections,
  releaseAllWallConnectionsForParticipant,
  getSessionBoardSerial,
  setSessionBoardSerialAndReturnPrevious,
  pushRecentClimb,
  isRecentClimb,
  getSessionMemberCount,
  isConnectionInSession,
  refreshConnection,
  refreshSessionMembership,
  hasSessionMembers,
  cleanupStaleSessionMembers,
  cleanupEmptySession,
  markParticipantPresence,
  removeParticipant,
  removeParticipantConnection,
} from './session-ops';
import { logger } from '../../utils/logger';
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
    instanceId?: string,
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
      void this.updateHeartbeatWithRecovery();
    }, 30_000);

    // Initial heartbeat
    void this.updateHeartbeatWithRecovery();

    // Clean up connections from dead instances asynchronously on startup
    this.cleanupDeadInstanceConnections().catch((err) => {
      logger.error('[DistributedState] Startup dead instance cleanup failed:', err);
    });

    logger.info(`[DistributedState] Started with instance ID: ${this.instanceId.slice(0, 8)}`);
  }

  /** Stop background tasks and clean up instance state. */
  async stop(): Promise<void> {
    this.stopHeartbeat();
    await cleanupInstanceConnections(this.redis, this.instanceId);
    logger.info(`[DistributedState] Stopped instance: ${this.instanceId.slice(0, 8)}`);
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
    avatarUrl?: string | null,
  ): Promise<void> {
    return registerConnection(this.redis, this.instanceId, connectionId, username, userId, avatarUrl);
  }

  /** Remove a connection from distributed state. */
  async removeConnection(
    connectionId: string,
    electNewLeader: boolean = true,
  ): Promise<{
    sessionId: string | null;
    participantId: string | null;
    wasLeader: boolean;
    newLeaderId: string | null;
    remainingParticipantConnections: number | null;
  }> {
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
    avatarUrl?: string | null,
    participantId?: string | null,
  ): Promise<{ isLeader: boolean }> {
    return joinSession(this.redis, connectionId, sessionId, username, avatarUrl, participantId);
  }

  /** Leave a session. Handles leader election if leaving member was leader. */
  async leaveSession(connectionId: string, sessionId: string): Promise<{ newLeaderId: string | null }> {
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

  /** Get the current wall driver (participantId) of a session, or null when unclaimed. */
  async getSessionDriver(sessionId: string): Promise<string | null> {
    return getSessionDriver(this.redis, sessionId);
  }

  /**
   * Set the current wall driver atomically and return the previous driver.
   * Yank-on-press: overwrites any prior driver. Returns the participantId of
   * the previous driver (or null when unclaimed) so callers can decide
   * whether to broadcast DriverChanged without a second round trip.
   */
  async setSessionDriverAndReturnPrevious(sessionId: string, participantId: string): Promise<string | null> {
    return setSessionDriverAndReturnPrevious(this.redis, sessionId, participantId);
  }

  /**
   * Conditionally clear the driver — only deletes the key when the current
   * driver matches `expectedParticipantId`. Returns true on deletion.
   */
  async clearSessionDriverIf(sessionId: string, expectedParticipantId: string): Promise<boolean> {
    return clearSessionDriverIf(this.redis, sessionId, expectedParticipantId);
  }

  /** Claim-if-free the wall-connection slot for a board; returns holder + whether this call claimed it. */
  async claimWallConnection(
    sessionId: string,
    boardId: number,
    participantId: string,
  ): Promise<{ holderParticipantId: string; didClaim: boolean }> {
    return claimWallConnection(this.redis, sessionId, boardId, participantId);
  }

  /** Release a board's wall-connection slot when the caller holds it. */
  async releaseWallConnection(sessionId: string, boardId: number, expectedParticipantId: string): Promise<boolean> {
    return releaseWallConnection(this.redis, sessionId, boardId, expectedParticipantId);
  }

  /** All current wall-connection holders for a session, keyed by boardId. */
  async getWallConnections(sessionId: string): Promise<Map<number, string>> {
    return getWallConnections(this.redis, sessionId);
  }

  /** Release every board this participant held (disconnect cleanup); returns freed boardIds. */
  async releaseAllWallConnectionsForParticipant(sessionId: string, participantId: string): Promise<number[]> {
    return releaseAllWallConnectionsForParticipant(this.redis, sessionId, participantId);
  }

  /** Get the session's last-connected BLE board serial, or null when unset. */
  async getSessionBoardSerial(sessionId: string): Promise<string | null> {
    return getSessionBoardSerial(this.redis, sessionId);
  }

  /**
   * Set the session's last-connected BLE board serial and return the previous
   * value atomically. Callers compare previous vs. new to decide whether to
   * publish `SessionBoardSerialChanged`.
   */
  async setSessionBoardSerialAndReturnPrevious(sessionId: string, serial: string): Promise<string | null> {
    return setSessionBoardSerialAndReturnPrevious(this.redis, sessionId, serial);
  }

  /**
   * Record a climbUuid in the per-session recent-climbs ring buffer (called on
   * every authoritative current-climb write). Used by confirmClimbOnWall to
   * accept confirms that arrive within a small navigate-on race window.
   */
  async pushRecentClimb(sessionId: string, climbUuid: string): Promise<void> {
    return pushRecentClimb(this.redis, sessionId, climbUuid);
  }

  /** Whether climbUuid is one of the session's last few authoritative climbs. */
  async isRecentClimb(sessionId: string, climbUuid: string): Promise<boolean> {
    return isRecentClimb(this.redis, sessionId, climbUuid);
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

  /** Mark a stable participant as connected/reconnecting. */
  async markParticipantPresence(
    sessionId: string,
    participantId: string,
    connectionState: 'CONNECTED' | 'RECONNECTING',
  ): Promise<SessionUser | null> {
    return markParticipantPresence(this.redis, sessionId, participantId, connectionState);
  }

  /** Remove a stable participant from a session. */
  async removeParticipant(sessionId: string, participantId: string): Promise<void> {
    return removeParticipant(this.redis, sessionId, participantId);
  }

  /**
   * Remove a single connection from a participant's connection set. If that was
   * the participant's last connection, atomically tear down the participant
   * entry. Used by explicit-leave: clicking "Leave" on one tab must not wipe
   * the user's other tabs that are still in the session.
   */
  async removeParticipantConnection(sessionId: string, participantId: string, connectionId: string): Promise<void> {
    return removeParticipantConnection(this.redis, sessionId, participantId, connectionId);
  }

  /**
   * Count live (non-expired) connections currently bound to a participant.
   * Stale connectionIds (whose connection hash has expired) are pruned as a
   * side effect. Used by the grace-timer callback to distinguish a
   * still-reconnecting participant (>0 live conns, in-flight rejoin) from a
   * truly absent one (0 live conns, evict). The user list alone is
   * ambiguous: `getSessionParticipants` retains RECONNECTING entries even
   * with 0 live conns, so the timer needs this direct query.
   */
  async getParticipantLiveConnectionCount(sessionId: string, participantId: string): Promise<number> {
    return countLiveParticipantConnections(this.redis, sessionId, participantId);
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
        logger.info(`[DistributedState] Heartbeat recovered after ${this.consecutiveHeartbeatFailures} failures`);
        this.consecutiveHeartbeatFailures = 0;
      }
      if (!this.isHealthy) {
        logger.info('[DistributedState] Redis connection restored, marking as healthy');
        this.isHealthy = true;
      }

      // Piggyback cleanup on every Nth heartbeat (~2 min)
      this.heartbeatCount++;
      if (this.heartbeatCount % this.cleanupEveryNHeartbeats === 0) {
        // Clean up connections from dead backend instances
        this.cleanupDeadInstanceConnections().catch((err) => {
          logger.error('[DistributedState] Periodic dead instance cleanup failed:', err);
        });
        // Clean up stale members from sessions this instance participates in
        this.cleanupActiveSessionMembers().catch((err) => {
          logger.error('[DistributedState] Periodic active session cleanup failed:', err);
        });
      }
    } catch (err) {
      this.consecutiveHeartbeatFailures++;
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';

      if (this.consecutiveHeartbeatFailures >= this.maxHeartbeatFailures) {
        if (this.isHealthy) {
          logger.error(
            `[DistributedState] Heartbeat failed ${this.consecutiveHeartbeatFailures} times, ` +
              `marking as unhealthy: ${errorMessage}`,
          );
          this.isHealthy = false;
        }
      } else {
        logger.warn(
          `[DistributedState] Heartbeat failed (${this.consecutiveHeartbeatFailures}/${this.maxHeartbeatFailures}): ${errorMessage}`,
        );
      }
    }
  }
}
