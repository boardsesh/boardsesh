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
  /**
   * Order-sensitive (v2) state hash. Additive field — sessions written before
   * this rollout have no `stateHashOrdered` in their hash, so reads coerce a
   * missing value to `''` and callers treat that as "unknown", exactly like the
   * legacy empty `stateHash` case already handled in queue-state.ts.
   */
  stateHashOrdered: string;
  lastActivity: Date;
  discoverable: boolean;
  latitude: number | null;
  longitude: number | null;
  name: string | null;
  createdByUserId: string | null;
  createdAt: Date;
};

/**
 * Sentinel for `casUpdateQueueState`'s `expectedVersion`: skip the
 * compare-and-swap guard and take whatever version is stored. Used by
 * `setQueue`, whose payload is entirely client-supplied — a full-state
 * overwrite is that mutation's contract, so it needs a unique sequence, not a
 * conflict.
 */
export const CAS_ANY_VERSION = '__ANY__';

export type QueueStateCasResult =
  | {
      status: 'OK';
      version: number;
      sequence: number;
      previousStateHash: string;
      previousStateHashOrdered: string;
    }
  | { status: 'CONFLICT'; version: number; sequence: number }
  /**
   * Redis holds no hash for this session and the caller hasn't supplied
   * Postgres floors yet. Nothing was written — read the durable counters and
   * call again with `floorsKnown: true`.
   */
  | { status: 'NEEDS_FLOOR' };

/**
 * Atomically advance a session's queue state (issue #3906).
 *
 * Why Lua rather than the read-modify-write this replaces: the whole queue
 * lives in one Redis hash, and every mutation used to HGETALL it, recompute in
 * Node, then HMSET the whole thing back. Two mutations overlapping anywhere in
 * that window — two party members, two devices of one member, or even two
 * resolvers on one socket, since graphql-ws does not serialise them — both read
 * the same version and both write `+1`. The later HMSET overwrote the entire
 * `queue` array, so a climb someone had just added silently disappeared. Redis
 * runs Lua single-threaded and atomically, so the version check and the write
 * can no longer be pulled apart. This is also the only coordination that works
 * across backend instances: Redis is the shared authority, and Railway's
 * rolling deploys mean two processes are live at once even at one replica.
 *
 * `versionFloor` / `sequenceFloor` carry the Postgres counters the caller read
 * when Redis had no hash for this session. A session dormant past the 4h Redis
 * TTL still has durable counters, and restarting at 1 would rewind the sequence
 * clients gap-check against. The script takes the max, so a live hash always
 * wins and the floor only fills a genuine hole. Same shape as the dormancy
 * reseed in `allocateBoardSeqAtLeast` (pubsub/board-presence-store.ts).
 *
 * Returns the *prior* hashes so `setQueue`'s redundant-resync diagnostic keeps
 * working without a second round trip.
 */
export const UPDATE_QUEUE_STATE_CAS_SCRIPT = `
  local sessionKey = KEYS[1]
  local recentKey = KEYS[2]

  local sessionId = ARGV[1]
  local expectedVersion = ARGV[2]
  local queueJson = ARGV[3]
  local currentClimbJson = ARGV[4]
  local stateHash = ARGV[5]
  local stateHashOrdered = ARGV[6]
  local ttl = tonumber(ARGV[7])
  local now = ARGV[8]
  local versionFloor = tonumber(ARGV[9]) or 0
  local sequenceFloor = tonumber(ARGV[10]) or 0
  local anySentinel = ARGV[11]
  local floorsKnown = ARGV[12]

  local stored = redis.call('HMGET', sessionKey, 'version', 'sequence', 'stateHash', 'stateHashOrdered')

  -- No hash at all: the session may be dormant-but-durable (past the 4h TTL,
  -- counters still in Postgres). Bail out WITHOUT writing so the caller can go
  -- read the floors and come back, rather than rewinding the sequence to 1.
  -- Skipped once the caller says it has consulted Postgres.
  if stored[1] == false and floorsKnown ~= '1' then
    return { 'NEEDS_FLOOR', 0, 0, '', '' }
  end

  local storedVersion = tonumber(stored[1]) or 0
  local storedSequence = tonumber(stored[2]) or 0
  local priorStateHash = stored[3] or ''
  local priorStateHashOrdered = stored[4] or ''

  local baseVersion = storedVersion
  if versionFloor > baseVersion then baseVersion = versionFloor end
  local baseSequence = storedSequence
  if sequenceFloor > baseSequence then baseSequence = sequenceFloor end

  if expectedVersion ~= anySentinel and baseVersion ~= tonumber(expectedVersion) then
    return { 'CONFLICT', baseVersion, baseSequence, priorStateHash, priorStateHashOrdered }
  end

  local newVersion = baseVersion + 1
  local newSequence = baseSequence + 1

  redis.call('HSET', sessionKey,
    'sessionId', sessionId,
    'queue', queueJson,
    'currentClimbQueueItem', currentClimbJson,
    'version', tostring(newVersion),
    'sequence', tostring(newSequence),
    'stateHash', stateHash,
    'stateHashOrdered', stateHashOrdered,
    'lastActivity', now)
  redis.call('EXPIRE', sessionKey, ttl)
  redis.call('ZADD', recentKey, now, sessionId)

  return { 'OK', newVersion, newSequence, priorStateHash, priorStateHashOrdered }
`;

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
      stateHashOrdered: data.stateHashOrdered,
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
   * Update only queue state at a version/sequence the caller already decided
   * (optimized for queue mutations).
   *
   * NOT safe for concurrent queue mutations — it is a blind overwrite. Live
   * party mutations must go through `casUpdateQueueState` instead (issue
   * #3906). This remains for the paths that own the counters themselves:
   * session creation / restoration and the Postgres-authoritative
   * `updateQueueStateImmediate`, where the version was already settled by a
   * guarded SQL statement.
   */
  async updateQueueState(
    sessionId: string,
    queue: ClimbQueueItem[],
    currentClimbQueueItem: ClimbQueueItem | null,
    version: number,
    sequence: number,
    stateHash: string,
    stateHashOrdered: string,
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
      stateHashOrdered: stateHashOrdered,
      lastActivity: Date.now().toString(),
    });

    multi.expire(key, this.TTL);
    multi.zadd('boardsesh:session:recent', Date.now(), sessionId);

    await multi.exec();
  }

  /**
   * Atomically compare-and-swap a session's queue state (issue #3906).
   *
   * Runs `UPDATE_QUEUE_STATE_CAS_SCRIPT` — see that constant for why this has
   * to be a Lua script and what the floors are for. Pass
   * `expectedVersion: CAS_ANY_VERSION` to take whatever is stored instead of
   * guarding, and the caller's freshly-read Postgres counters as the floors
   * when Redis had no hash (0 otherwise).
   */
  async casUpdateQueueState(input: {
    sessionId: string;
    queue: ClimbQueueItem[];
    currentClimbQueueItem: ClimbQueueItem | null;
    expectedVersion: number | typeof CAS_ANY_VERSION;
    stateHash: string;
    stateHashOrdered: string;
    versionFloor: number;
    sequenceFloor: number;
    floorsKnown: boolean;
  }): Promise<QueueStateCasResult> {
    const now = Date.now().toString();
    const raw = (await this.redis.eval(
      UPDATE_QUEUE_STATE_CAS_SCRIPT,
      2,
      `boardsesh:session:${input.sessionId}`,
      'boardsesh:session:recent',
      input.sessionId,
      String(input.expectedVersion),
      JSON.stringify(input.queue),
      input.currentClimbQueueItem ? JSON.stringify(input.currentClimbQueueItem) : '',
      input.stateHash,
      input.stateHashOrdered,
      String(this.TTL),
      now,
      String(input.versionFloor),
      String(input.sequenceFloor),
      CAS_ANY_VERSION,
      input.floorsKnown ? '1' : '0',
    )) as [string, number, number, string, string];

    const [status, version, sequence, previousStateHash, previousStateHashOrdered] = raw;

    if (status === 'NEEDS_FLOOR') {
      return { status: 'NEEDS_FLOOR' };
    }

    if (status === 'CONFLICT') {
      return { status: 'CONFLICT', version, sequence };
    }

    return {
      status: 'OK',
      version,
      sequence,
      previousStateHash,
      previousStateHashOrdered,
    };
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
      stateHashOrdered: data.stateHashOrdered || '',
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
