import type { ClimbQueueItem } from '@boardsesh/shared-schema';
import { createRequestDb } from '../../db/client';
import { sessionQueues } from '../../db/schema';
import { eq, and, sql } from 'drizzle-orm';
import type { RedisSessionStore } from '../redis-session-store';
import { computeQueueStateHash } from '../../utils/hash';
import { VersionConflictError, type QueueState } from './types';
import { WriteScheduler, writeQueueStateToPostgres } from './write-scheduler';

/**
 * Update queue state with Redis as source of truth and debounced Postgres writes.
 */
export async function updateQueueState(
  sessionId: string,
  queue: ClimbQueueItem[],
  currentClimbQueueItem: ClimbQueueItem | null,
  expectedVersion: number | undefined,
  redisStore: RedisSessionStore | null,
  writeScheduler: WriteScheduler,
  distributedState: import('../distributed-state').DistributedStateManager | null
): Promise<{ version: number; sequence: number; stateHash: string }> {
  // Get current version and sequence from Redis if available, otherwise from Postgres
  let currentVersion = expectedVersion;
  let currentSequence = 0;

  if (currentVersion === undefined) {
    if (redisStore) {
      const redisSession = await redisStore.getSession(sessionId);
      currentVersion = redisSession?.version ?? 0;
      currentSequence = redisSession?.sequence ?? 0;
    }
    if (currentVersion === undefined || currentVersion === 0) {
      const pgState = await getQueueState(sessionId, redisStore);
      currentVersion = pgState.version;
      currentSequence = pgState.sequence;
    }
  } else {
    // If version is provided, get sequence from Redis or Postgres
    if (redisStore) {
      const redisSession = await redisStore.getSession(sessionId);
      currentSequence = redisSession?.sequence ?? 0;
    }
    if (currentSequence === 0) {
      const pgState = await getQueueState(sessionId, redisStore);
      currentSequence = pgState.sequence;
    }
  }

  const newVersion = currentVersion + 1;
  const newSequence = currentSequence + 1;
  const stateHash = computeQueueStateHash(queue, currentClimbQueueItem?.uuid || null);

  // Write to Redis immediately (source of truth for active sessions)
  if (redisStore) {
    await redisStore.updateQueueState(sessionId, queue, currentClimbQueueItem, newVersion, newSequence, stateHash);
    // Debounce Postgres write (30 seconds) - eventual consistency when Redis provides fast reads
    writeScheduler.schedulePostgresWrite(sessionId, queue, currentClimbQueueItem, newVersion, newSequence, distributedState);
  } else {
    // No Redis - write to Postgres immediately since it's the only read source
    await writeQueueStateToPostgres(sessionId, { queue, currentClimbQueueItem, version: newVersion, sequence: newSequence }, writeScheduler);
  }

  return { version: newVersion, sequence: newSequence, stateHash };
}

/**
 * Update queue state with immediate Postgres write (for critical operations).
 * Use this when you need immediate Postgres consistency (e.g., session creation).
 */
export async function updateQueueStateImmediate(
  sessionId: string,
  queue: ClimbQueueItem[],
  currentClimbQueueItem: ClimbQueueItem | null,
  expectedVersion: number | undefined,
  redisStore: RedisSessionStore | null
): Promise<number> {
  const db = createRequestDb();
  if (expectedVersion !== undefined) {
    if (expectedVersion === 0) {
      // Version 0 means no row exists yet - try to insert
      const result = await db
        .insert(sessionQueues)
        .values({
          sessionId,
          queue,
          currentClimbQueueItem,
          version: 1,
          sequence: 1, // Initial sequence for new session
          updatedAt: new Date(),
        })
        .onConflictDoNothing()
        .returning();

      if (result.length === 0) {
        throw new VersionConflictError(sessionId, expectedVersion);
      }

      // Also update Redis
      if (redisStore) {
        const stateHash = computeQueueStateHash(queue, currentClimbQueueItem?.uuid || null);
        await redisStore.updateQueueState(sessionId, queue, currentClimbQueueItem, result[0].version, result[0].sequence, stateHash);
      }

      return result[0].version;
    }

    // Optimistic locking: only update if version matches
    const result = await db
      .update(sessionQueues)
      .set({
        queue,
        currentClimbQueueItem,
        version: sql`${sessionQueues.version} + 1`,
        sequence: sql`${sessionQueues.sequence} + 1`,
        updatedAt: new Date(),
      })
      .where(and(
        eq(sessionQueues.sessionId, sessionId),
        eq(sessionQueues.version, expectedVersion)
      ))
      .returning();

    if (result.length === 0) {
      throw new VersionConflictError(sessionId, expectedVersion);
    }

    // Also update Redis
    if (redisStore) {
      const stateHash = computeQueueStateHash(queue, currentClimbQueueItem?.uuid || null);
      await redisStore.updateQueueState(sessionId, queue, currentClimbQueueItem, result[0].version, result[0].sequence, stateHash);
    }

    return result[0].version;
  }

  // No version check - insert or update
  const result = await db
    .insert(sessionQueues)
    .values({
      sessionId,
      queue,
      currentClimbQueueItem,
      version: 1,
      sequence: 1, // Initial sequence for new session
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: sessionQueues.sessionId,
      set: {
        queue,
        currentClimbQueueItem,
        version: sql`${sessionQueues.version} + 1`,
        sequence: sql`${sessionQueues.sequence} + 1`,
        updatedAt: new Date(),
      },
    })
    .returning();

  const newVersion = result[0]?.version ?? 1;
  const newSequence = result[0]?.sequence ?? 1;

  // Also update Redis
  if (redisStore) {
    const stateHash = computeQueueStateHash(queue, currentClimbQueueItem?.uuid || null);
    await redisStore.updateQueueState(sessionId, queue, currentClimbQueueItem, newVersion, newSequence, stateHash);
  }

  return newVersion;
}

/**
 * Update only the queue without touching currentClimbQueueItem.
 * Uses Redis as source of truth for real-time state. Postgres writes are debounced.
 */
export async function updateQueueOnly(
  sessionId: string,
  queue: ClimbQueueItem[],
  expectedVersion: number | undefined,
  redisStore: RedisSessionStore | null,
  writeScheduler: WriteScheduler,
  distributedState: import('../distributed-state').DistributedStateManager | null
): Promise<{ version: number; sequence: number; stateHash: string }> {
  // Get current state from Redis (source of truth for real-time sync)
  let currentVersion = 0;
  let currentSequence = 0;
  let currentClimbQueueItem: ClimbQueueItem | null = null;

  if (redisStore) {
    const redisSession = await redisStore.getSession(sessionId);
    if (redisSession) {
      currentVersion = redisSession.version;
      currentSequence = redisSession.sequence;
      currentClimbQueueItem = redisSession.currentClimbQueueItem;
    }
  }

  // Fallback to Postgres if Redis doesn't have the data
  if (currentVersion === 0 && currentSequence === 0) {
    const pgState = await getQueueState(sessionId, redisStore);
    currentVersion = pgState.version;
    currentSequence = pgState.sequence;
    currentClimbQueueItem = pgState.currentClimbQueueItem;
  }

  // Validate expectedVersion if provided (optimistic locking)
  if (expectedVersion !== undefined && currentVersion !== expectedVersion) {
    throw new VersionConflictError(sessionId, expectedVersion);
  }

  const newVersion = currentVersion + 1;
  const newSequence = currentSequence + 1;
  const stateHash = computeQueueStateHash(queue, currentClimbQueueItem?.uuid || null);

  // Write to Redis immediately (source of truth for real-time state)
  if (redisStore) {
    await redisStore.updateQueueState(
      sessionId, queue, currentClimbQueueItem, newVersion, newSequence, stateHash
    );
    // Debounce Postgres write - eventual consistency when Redis provides fast reads
    writeScheduler.schedulePostgresWrite(sessionId, queue, currentClimbQueueItem, newVersion, newSequence, distributedState);
  } else {
    // No Redis - write to Postgres immediately since it's the only read source
    await writeQueueStateToPostgres(sessionId, { queue, currentClimbQueueItem, version: newVersion, sequence: newSequence }, writeScheduler);
  }

  return { version: newVersion, sequence: newSequence, stateHash };
}

/**
 * Get current queue state from Redis (preferred) or Postgres.
 */
export async function getQueueState(
  sessionId: string,
  redisStore: RedisSessionStore | null
): Promise<QueueState> {
  const db = createRequestDb();
  // Check Redis first (source of truth for active sessions)
  if (redisStore) {
    const redisSession = await redisStore.getSession(sessionId);
    if (redisSession) {
      return {
        queue: redisSession.queue,
        currentClimbQueueItem: redisSession.currentClimbQueueItem,
        version: redisSession.version,
        sequence: redisSession.sequence,
        stateHash: redisSession.stateHash,
      };
    }
  }

  // Fall back to Postgres (for dormant sessions or when Redis is unavailable)
  const result = await db.select().from(sessionQueues).where(eq(sessionQueues.sessionId, sessionId)).limit(1);

  if (result.length === 0) {
    return {
      queue: [],
      currentClimbQueueItem: null,
      version: 0,
      sequence: 0,
      stateHash: computeQueueStateHash([], null),
    };
  }

  const stateHash = computeQueueStateHash(
    result[0].queue,
    result[0].currentClimbQueueItem?.uuid || null
  );

  return {
    queue: result[0].queue,
    currentClimbQueueItem: result[0].currentClimbQueueItem,
    version: result[0].version,
    sequence: result[0].sequence,
    stateHash,
  };
}
