import { v4 as uuidv4 } from 'uuid';
import type { RedisSessionStore } from '../redis-session-store';
import type { Session } from '../../db/schema';
import { getQueueState } from './queue-state';

/**
 * Get the Redis lock key for session restoration.
 */
export function getSessionRestoreLockKey(sessionId: string): string {
  return `boardsesh:lock:session:restore:${sessionId}`;
}

/**
 * Restore a session from Redis or Postgres into the local session map.
 * Uses a Redis distributed lock to coordinate across instances.
 *
 * @returns Whether the session is new (not found in any store)
 */
export async function restoreSessionWithLock(
  sessionId: string,
  sessionsMap: Map<string, Set<string>>,
  redisStore: RedisSessionStore,
  getSessionById: (id: string) => Promise<Session | null>,
): Promise<boolean> {
  const lockKey = getSessionRestoreLockKey(sessionId);
  const lockValue = uuidv4();
  const lockTTL = 10; // 10 seconds

  // Try to acquire lock
  const lockAcquired = await redisStore.acquireLock(lockKey, lockValue, lockTTL);

  if (lockAcquired) {
    try {
      // Double-check after acquiring lock (another instance might have initialized)
      if (!sessionsMap.has(sessionId)) {
        const isNew = await tryRestoreFromStores(sessionId, sessionsMap, redisStore, getSessionById);
        return isNew;
      }
      return false;
    } finally {
      // Always release lock
      await redisStore.releaseLock(lockKey, lockValue);
    }
  } else {
    // Lock not acquired - wait with exponential backoff for restoration to complete
    return waitForRestoration(sessionId, sessionsMap, redisStore, getSessionById);
  }
}

/**
 * Try to restore a session from Redis, then Postgres.
 * Creates the session set in the local map.
 * @returns true if session is new (not found anywhere)
 */
async function tryRestoreFromStores(
  sessionId: string,
  sessionsMap: Map<string, Set<string>>,
  redisStore: RedisSessionStore,
  getSessionById: (id: string) => Promise<Session | null>,
): Promise<boolean> {
  let isNewSession = false;

  // Try to restore session from Redis first (hot cache)
  const redisSession = await redisStore.getSession(sessionId);
  if (redisSession) {
    console.info(`[RoomManager] Restoring session ${sessionId} from Redis (inactive session)`);
  } else {
    // Not in Redis, try Postgres (dormant session)
    isNewSession = await restoreFromPostgres(sessionId, redisStore, getSessionById);
  }

  sessionsMap.set(sessionId, new Set());
  return isNewSession;
}

/**
 * Restore session from Postgres to Redis.
 * @returns true if session is new (not found in Postgres)
 */
async function restoreFromPostgres(
  sessionId: string,
  redisStore: RedisSessionStore,
  getSessionById: (id: string) => Promise<Session | null>,
): Promise<boolean> {
  const pgSession = await getSessionById(sessionId);
  if (pgSession && pgSession.status !== 'ended') {
    console.info(`[RoomManager] Restoring session ${sessionId} from Postgres (dormant session)`);
    const queueState = await getQueueState(sessionId, redisStore);
    await redisStore.saveSession({
      sessionId: pgSession.id,
      boardPath: pgSession.boardPath,
      queue: queueState.queue,
      currentClimbQueueItem: queueState.currentClimbQueueItem,
      picks: queueState.picks,
      activeClimberUserId: queueState.activeClimberUserId,
      version: queueState.version,
      sequence: queueState.sequence,
      stateHash: queueState.stateHash,
      lastActivity: pgSession.lastActivity,
      discoverable: pgSession.discoverable,
      latitude: pgSession.latitude,
      longitude: pgSession.longitude,
      name: pgSession.name,
      createdByUserId: pgSession.createdByUserId,
      createdAt: pgSession.createdAt,
    });
    return false;
  }

  // Session doesn't exist in Redis or Postgres - this is a new session
  return true;
}

/**
 * Wait for another instance to restore the session, with exponential backoff.
 * Falls back to direct restoration if the wait times out.
 */
async function waitForRestoration(
  sessionId: string,
  sessionsMap: Map<string, Set<string>>,
  redisStore: RedisSessionStore,
  getSessionById: (id: string) => Promise<Session | null>,
): Promise<boolean> {
  console.info(`[RoomManager] Lock not acquired for session ${sessionId}, waiting with backoff...`);
  let waitTime = 50;
  const maxWait = 2000;
  const maxAttempts = 5;
  let sessionRestored = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, waitTime));

    // Check if session was restored by another instance
    if (sessionsMap.has(sessionId)) {
      console.info(`[RoomManager] Session ${sessionId} restored by another instance after ${attempt + 1} attempts`);
      sessionRestored = true;
      break;
    }

    // Exponential backoff
    waitTime = Math.min(waitTime * 2, maxWait);
  }

  // After waiting, verify session state from Redis to ensure consistency
  if (!sessionRestored && !sessionsMap.has(sessionId)) {
    // Check Redis to see if the session was restored by another instance
    const redisSession = await redisStore.getSession(sessionId);
    if (redisSession) {
      console.info(`[RoomManager] Session ${sessionId} found in Redis after backoff, using restored state`);
      sessionsMap.set(sessionId, new Set());
      return false;
    }

    // Session doesn't exist in Redis - check Postgres as fallback
    const isNew = await restoreFromPostgres(sessionId, redisStore, getSessionById);
    if (!isNew) {
      console.info(`[RoomManager] Session ${sessionId} found in Postgres after backoff, restoring`);
    } else {
      console.info(`[RoomManager] Session ${sessionId} not found after backoff, treating as new session`);
    }
    sessionsMap.set(sessionId, new Set());
    return isNew;
  }

  return false;
}
