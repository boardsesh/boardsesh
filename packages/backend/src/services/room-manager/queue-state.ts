import type { ClimbQueueItem, UserPick } from '@boardsesh/shared-schema';
import { db } from '../../db/client';
import { sessionQueues } from '../../db/schema';
import { eq, and, sql } from 'drizzle-orm';
import type { RedisSessionStore } from '../redis-session-store';
import type { DistributedStateManager } from '../distributed-state';
import { computeQueueStateHash } from '../../utils/hash';
import { VersionConflictError, type QueueState } from './types';
import { type WriteScheduler, writeQueueStateToPostgres } from './write-scheduler';

type QueueStateOptions = {
  picks?: UserPick[];
  activeClimberUserId?: string | null;
  sequenceIncrement?: number;
};

function normalizeSequenceIncrement(value?: number): number {
  return Math.max(1, Math.floor(value ?? 1));
}

function hasOwn<T extends object>(obj: T | undefined, key: keyof T): boolean {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function computeStateHash(state: {
  queue: ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
  picks: UserPick[];
  activeClimberUserId: string | null;
}): string {
  return computeQueueStateHash(
    state.queue,
    state.currentClimbQueueItem?.uuid || null,
    state.picks,
    state.activeClimberUserId,
  );
}

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
  distributedState: DistributedStateManager | null,
  options?: QueueStateOptions,
): Promise<{ version: number; sequence: number; stateHash: string }> {
  const currentState = await getQueueState(sessionId, redisStore);

  if (expectedVersion !== undefined && currentState.version !== expectedVersion) {
    throw new VersionConflictError(sessionId, expectedVersion);
  }

  const picks = options?.picks ?? currentState.picks;
  const activeClimberUserId = hasOwn(options, 'activeClimberUserId')
    ? (options?.activeClimberUserId ?? null)
    : currentState.activeClimberUserId;
  const newVersion = currentState.version + 1;
  const newSequence = currentState.sequence + normalizeSequenceIncrement(options?.sequenceIncrement);
  const stateHash = computeStateHash({ queue, currentClimbQueueItem, picks, activeClimberUserId });

  // Write to Redis immediately (source of truth for active sessions)
  if (redisStore) {
    await redisStore.updateQueueState(
      sessionId,
      queue,
      currentClimbQueueItem,
      picks,
      activeClimberUserId,
      newVersion,
      newSequence,
      stateHash,
    );
    // Debounce Postgres write (30 seconds) - eventual consistency when Redis provides fast reads
    writeScheduler.schedulePostgresWrite(
      sessionId,
      queue,
      currentClimbQueueItem,
      picks,
      activeClimberUserId,
      newVersion,
      newSequence,
      distributedState,
    );
  } else {
    // No Redis - write to Postgres immediately since it's the only read source
    await writeQueueStateToPostgres(
      sessionId,
      { queue, currentClimbQueueItem, picks, activeClimberUserId, version: newVersion, sequence: newSequence },
      writeScheduler,
    );
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
  redisStore: RedisSessionStore | null,
  options?: QueueStateOptions,
): Promise<number> {
  const currentState = await getQueueState(sessionId, redisStore);

  if (expectedVersion !== undefined && currentState.version !== expectedVersion) {
    throw new VersionConflictError(sessionId, expectedVersion);
  }

  const picks = options?.picks ?? currentState.picks;
  const activeClimberUserId = hasOwn(options, 'activeClimberUserId')
    ? (options?.activeClimberUserId ?? null)
    : currentState.activeClimberUserId;
  const sequenceIncrement = normalizeSequenceIncrement(options?.sequenceIncrement);

  let result: Array<{ version: number; sequence: number }> = [];

  if (expectedVersion === 0) {
    // Version 0 means no row exists yet - try to insert
    result = await db
      .insert(sessionQueues)
      .values({
        sessionId,
        queue,
        currentClimbQueueItem,
        picks,
        activeClimberUserId,
        version: 1,
        sequence: sequenceIncrement,
        updatedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ version: sessionQueues.version, sequence: sessionQueues.sequence });

    if (result.length === 0) {
      throw new VersionConflictError(sessionId, expectedVersion);
    }
  } else if (expectedVersion !== undefined) {
    result = await db
      .update(sessionQueues)
      .set({
        queue,
        currentClimbQueueItem,
        picks,
        activeClimberUserId,
        version: sql`${sessionQueues.version} + 1`,
        sequence: sql`${sessionQueues.sequence} + ${sequenceIncrement}`,
        updatedAt: new Date(),
      })
      .where(and(eq(sessionQueues.sessionId, sessionId), eq(sessionQueues.version, expectedVersion)))
      .returning({ version: sessionQueues.version, sequence: sessionQueues.sequence });

    if (result.length === 0) {
      throw new VersionConflictError(sessionId, expectedVersion);
    }
  } else {
    result = await db
      .insert(sessionQueues)
      .values({
        sessionId,
        queue,
        currentClimbQueueItem,
        picks,
        activeClimberUserId,
        version: 1,
        sequence: sequenceIncrement,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: sessionQueues.sessionId,
        set: {
          queue,
          currentClimbQueueItem,
          picks,
          activeClimberUserId,
          version: sql`${sessionQueues.version} + 1`,
          sequence: sql`${sessionQueues.sequence} + ${sequenceIncrement}`,
          updatedAt: new Date(),
        },
      })
      .returning({ version: sessionQueues.version, sequence: sessionQueues.sequence });
  }

  const newVersion = result[0]?.version ?? currentState.version + 1;
  const newSequence = result[0]?.sequence ?? currentState.sequence + sequenceIncrement;
  const stateHash = computeStateHash({ queue, currentClimbQueueItem, picks, activeClimberUserId });

  if (redisStore) {
    await redisStore.updateQueueState(
      sessionId,
      queue,
      currentClimbQueueItem,
      picks,
      activeClimberUserId,
      newVersion,
      newSequence,
      stateHash,
    );
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
  distributedState: DistributedStateManager | null,
): Promise<{ version: number; sequence: number; stateHash: string }> {
  const currentState = await getQueueState(sessionId, redisStore);

  if (expectedVersion !== undefined && currentState.version !== expectedVersion) {
    throw new VersionConflictError(sessionId, expectedVersion);
  }

  return updateQueueState(
    sessionId,
    queue,
    currentState.currentClimbQueueItem,
    currentState.version,
    redisStore,
    writeScheduler,
    distributedState,
    {
      picks: currentState.picks,
      activeClimberUserId: currentState.activeClimberUserId,
    },
  );
}

/**
 * Get current queue state from Redis (preferred) or Postgres.
 */
export async function getQueueState(sessionId: string, redisStore: RedisSessionStore | null): Promise<QueueState> {
  // Check Redis first (source of truth for active sessions)
  if (redisStore) {
    const redisSession = await redisStore.getSession(sessionId);
    if (redisSession) {
      const stateHash =
        redisSession.stateHash ||
        computeStateHash({
          queue: redisSession.queue,
          currentClimbQueueItem: redisSession.currentClimbQueueItem,
          picks: redisSession.picks,
          activeClimberUserId: redisSession.activeClimberUserId,
        });
      return {
        queue: redisSession.queue,
        currentClimbQueueItem: redisSession.currentClimbQueueItem,
        picks: redisSession.picks,
        activeClimberUserId: redisSession.activeClimberUserId,
        version: redisSession.version,
        sequence: redisSession.sequence,
        stateHash,
      };
    }
  }

  // Fall back to Postgres (for dormant sessions or when Redis is unavailable)
  const result = await db.select().from(sessionQueues).where(eq(sessionQueues.sessionId, sessionId)).limit(1);

  if (result.length === 0) {
    return {
      queue: [],
      currentClimbQueueItem: null,
      picks: [],
      activeClimberUserId: null,
      version: 0,
      sequence: 0,
      stateHash: computeQueueStateHash([], null),
    };
  }

  const row = result[0];
  const picks = row.picks ?? [];
  const activeClimberUserId = row.activeClimberUserId ?? null;
  const stateHash = computeStateHash({
    queue: row.queue,
    currentClimbQueueItem: row.currentClimbQueueItem,
    picks,
    activeClimberUserId,
  });

  return {
    queue: row.queue,
    currentClimbQueueItem: row.currentClimbQueueItem,
    picks,
    activeClimberUserId,
    version: row.version,
    sequence: row.sequence,
    stateHash,
  };
}
