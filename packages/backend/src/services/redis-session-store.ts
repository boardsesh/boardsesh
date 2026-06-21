import type Redis from 'ioredis';
import type { ClimbQueueItem, SessionUser } from '@boardsesh/shared-schema';
import { logger } from '../utils/logger';
import { KEYS } from './distributed-state/constants';

/**
 * Safely parse JSON with fallback for empty strings and malformed data.
 */
function safeJSONParse<T>(value: string | undefined | null, fallback: T): T {
  if (!value || value === '') {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    logger.error('[RedisSessionStore] JSON parse error:', error, 'Value:', value?.substring(0, 100));
    return fallback;
  }
}

export type RedisSessionData = {
  sessionId: string;
  boardPath: string;
  queue: ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
  version: number;
  sequence: number;
  stateHash: string;
  lastActivity: Date;
  discoverable: boolean;
  latitude: number | null;
  longitude: number | null;
  name: string | null;
  createdByUserId: string | null;
  createdAt: Date;
};

/**
 * Redis session store for hybrid persistence strategy.
 *
 * - Stores active/recent sessions with 4 hour TTL
 * - Handles ephemeral user presence data
 * - Provides distributed locking for concurrent access
 */
export class RedisSessionStore {
  private readonly TTL = 4 * 60 * 60; // 4 hours in seconds

  constructor(private redis: Redis) {}

  /**
   * Save complete session state to Redis with 4 hour TTL.
   */
  async saveSession(data: RedisSessionData): Promise<void> {
    const key = `boardsesh:session:${data.sessionId}`;
    const multi = this.redis.multi();

    // Save session data as hash
    multi.hmset(key, {
      sessionId: data.sessionId,
      boardPath: data.boardPath,
      queue: JSON.stringify(data.queue),
      currentClimbQueueItem: data.currentClimbQueueItem ? JSON.stringify(data.currentClimbQueueItem) : '',
      version: data.version.toString(),
      sequence: data.sequence.toString(),
      stateHash: data.stateHash,
      lastActivity: data.lastActivity.getTime().toString(),
      discoverable: data.discoverable ? '1' : '0',
      latitude: data.latitude?.toString() || '',
      longitude: data.longitude?.toString() || '',
      name: data.name || '',
      createdByUserId: data.createdByUserId || '',
      createdAt: data.createdAt.getTime().toString(),
    });

    // Set TTL on session data
    multi.expire(key, this.TTL);

    // Add to recent sessions sorted set (score = timestamp)
    multi.zadd('boardsesh:session:recent', Date.now(), data.sessionId);

    await multi.exec();
  }

  /**
   * Update only queue state (optimized for queue mutations).
   */
  async updateQueueState(
    sessionId: string,
    queue: ClimbQueueItem[],
    currentClimbQueueItem: ClimbQueueItem | null,
    version: number,
    sequence: number,
    stateHash: string,
  ): Promise<void> {
    const key = `boardsesh:session:${sessionId}`;
    const multi = this.redis.multi();

    multi.hmset(key, {
      sessionId,
      queue: JSON.stringify(queue),
      currentClimbQueueItem: currentClimbQueueItem ? JSON.stringify(currentClimbQueueItem) : '',
      version: version.toString(),
      sequence: sequence.toString(),
      stateHash: stateHash,
      lastActivity: Date.now().toString(),
    });

    multi.expire(key, this.TTL);
    multi.zadd('boardsesh:session:recent', Date.now(), sessionId);

    await multi.exec();
  }

  /**
   * Load session from Redis. Returns null if not found.
   */
  async getSession(sessionId: string): Promise<RedisSessionData | null> {
    const key = `boardsesh:session:${sessionId}`;
    const data = await this.redis.hgetall(key);

    if (!data || !data.sessionId) {
      return null;
    }

    return {
      sessionId: data.sessionId,
      boardPath: data.boardPath,
      queue: safeJSONParse(data.queue, []),
      currentClimbQueueItem: safeJSONParse(data.currentClimbQueueItem, null),
      version: parseInt(data.version, 10) || 0,
      sequence: parseInt(data.sequence, 10) || 0,
      stateHash: data.stateHash || '',
      lastActivity: new Date(parseInt(data.lastActivity, 10)),
      discoverable: data.discoverable === '1',
      latitude: data.latitude ? parseFloat(data.latitude) : null,
      longitude: data.longitude ? parseFloat(data.longitude) : null,
      name: data.name || null,
      createdByUserId: data.createdByUserId || null,
      createdAt: new Date(parseInt(data.createdAt, 10)),
    };
  }

  /**
   * Save users to Redis (ephemeral - not persisted to Postgres).
   */
  async saveUsers(sessionId: string, users: SessionUser[]): Promise<void> {
    const key = `boardsesh:session:${sessionId}:users`;
    const multi = this.redis.multi();

    // Clear existing users
    multi.del(key);

    // Add each user
    if (users.length > 0) {
      const userMap: Record<string, string> = {};
      for (const user of users) {
        userMap[user.id] = JSON.stringify(user);
      }
      multi.hmset(key, userMap);
    }

    // Set TTL
    multi.expire(key, this.TTL);

    await multi.exec();
  }

  /**
   * Get users from Redis.
   */
  async getUsers(sessionId: string): Promise<SessionUser[]> {
    const key = `boardsesh:session:${sessionId}:users`;
    const data = await this.redis.hgetall(key);

    if (!data) return [];

    return Object.values(data)
      .map((json) => safeJSONParse<SessionUser | null>(json, null))
      .filter((user): user is SessionUser => user !== null);
  }

  /**
   * Mark session as active (has connected users).
   */
  async markActive(sessionId: string): Promise<void> {
    await this.redis.sadd('boardsesh:session:active', sessionId);
  }

  /**
   * Mark session as inactive (no connected users).
   */
  async markInactive(sessionId: string): Promise<void> {
    await this.redis.srem('boardsesh:session:active', sessionId);
  }

  /**
   * Check if session exists in Redis.
   */
  async exists(sessionId: string): Promise<boolean> {
    const exists = await this.redis.exists(`boardsesh:session:${sessionId}`);
    return exists === 1;
  }

  /**
   * Check existence of multiple sessions in a single pipeline.
   * Returns a map of sessionId -> exists boolean.
   */
  async batchExists(sessionIds: string[]): Promise<Map<string, boolean>> {
    if (sessionIds.length === 0) {
      return new Map();
    }

    // Use pipeline for batch operation
    const pipeline = this.redis.pipeline();

    for (const sessionId of sessionIds) {
      pipeline.exists(`boardsesh:session:${sessionId}`);
    }

    const results = await pipeline.exec();
    const existsMap = new Map<string, boolean>();

    if (results) {
      sessionIds.forEach((sessionId, index) => {
        const [error, exists] = results[index] || [null, 0];
        if (!error) {
          existsMap.set(sessionId, exists === 1);
        }
      });
    }

    return existsMap;
  }

  /**
   * Refresh TTL on session keys to prevent expiry.
   */
  async refreshTTL(sessionId: string): Promise<void> {
    const multi = this.redis.multi();
    multi.expire(`boardsesh:session:${sessionId}`, this.TTL);
    multi.expire(`boardsesh:session:${sessionId}:users`, this.TTL);
    multi.zadd('boardsesh:session:recent', Date.now(), sessionId);
    await multi.exec();
  }

  /**
   * Delete session from Redis (when explicitly ended).
   *
   * Mirrors the per-session keys cleared by `cleanupEmptySession` in
   * `distributed-state/session-ops.ts` so neither layer leaves orphaned keys.
   */
  async deleteSession(sessionId: string): Promise<void> {
    const multi = this.redis.multi();
    multi.del(`boardsesh:session:${sessionId}`);
    multi.del(`boardsesh:session:${sessionId}:users`);
    multi.del(KEYS.sessionBoardSerial(sessionId));
    multi.srem('boardsesh:session:active', sessionId);
    multi.zrem('boardsesh:session:recent', sessionId);
    await multi.exec();
  }

  /**
   * Acquire a distributed lock for concurrent session restoration.
   * Returns true if lock acquired, false if already locked.
   */
  async acquireLock(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    // SET key value EX ttlSeconds NX
    // NX = only set if key doesn't exist
    const result = await this.redis.set(key, value, 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  /**
   * Release a distributed lock (only if we own it).
   */
  async releaseLock(key: string, value: string): Promise<void> {
    // Lua script to ensure we only delete if we own the lock
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await this.redis.eval(script, 1, key, value);
  }

  /**
   * Get the publisher Redis instance (for compatibility with existing code).
   */
  getPublisher(): Redis {
    return this.redis;
  }
}
