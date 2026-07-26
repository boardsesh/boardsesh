import type { ClimbQueueItem } from '@boardsesh/shared-schema';
import { db } from '../../db/client';
import { sessionQueues } from '../../db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { CAS_ANY_VERSION, type RedisSessionStore, type QueueStateCasResult } from '../redis-session-store';
import { computeQueueStateHash, computeQueueStateHashOrdered } from '@boardsesh/queue';
import { VersionConflictError, type QueueState, type RoomManagerDeps } from './types';
import { writeQueueStateToPostgres } from './write-scheduler';

/**
 * Run the queue-state compare-and-swap, transparently fetching the durable
 * Postgres counters and retrying once when Redis holds no hash for the session
 * (a session dormant past the 4h TTL — see `UPDATE_QUEUE_STATE_CAS_SCRIPT`).
 *
 * This function is a single round trip on the hot path — the script does its
 * own read, so there is no read-before-write *here*. That is not the same as
 * the mutation being one round trip end to end: every caller goes through
 * `withQueueVersionRetry`, which reads state first to compute the new queue,
 * so a mutation is still two Redis round trips. Same count as the
 * read-modify-write this replaces; the win is atomicity, not latency.
 */
async function casWithDormancyFloor(
  redisStore: RedisSessionStore,
  sessionId: string,
  input: {
    queue: ClimbQueueItem[];
    currentClimbQueueItem: ClimbQueueItem | null;
    expectedVersion: number | typeof CAS_ANY_VERSION;
    stateHash: string;
    stateHashOrdered: string;
  },
): Promise<QueueStateCasResult> {
  const firstAttempt = await redisStore.casUpdateQueueState({
    sessionId,
    ...input,
    versionFloor: 0,
    sequenceFloor: 0,
    floorsKnown: false,
  });

  if (firstAttempt.status !== 'NEEDS_FLOOR') {
    return firstAttempt;
  }

  // Passing `null` for the store forces the Postgres read — the script just
  // told us Redis has nothing to offer.
  const durable = await getQueueState(sessionId, null);
  return redisStore.casUpdateQueueState({
    sessionId,
    ...input,
    versionFloor: durable.version,
    sequenceFloor: durable.sequence,
    floorsKnown: true,
  });
}

/**
 * Coerce empty-string hashes to null. Legacy session rows in Redis or Postgres
 * can have `stateHash = ''` (the field was added mid-development and older rows
 * never recorded one), and `stateHashOrdered` is newer still (#3906), so
 * sessions written before that rollout have no value until their first write.
 * `computeQueueStateHash` always returns a non-empty 8-character hex string, so
 * an empty stored hash means "we don't know the previous state" — semantically
 * the same as null. Callers compare with `=== stateHash`, which would silently
 * never match for legacy sessions even when the resync *was* a no-op,
 * suppressing the diagnostic. Normalising here makes null-vs-empty a non-issue
 * at the consumer.
 */
const normalizeHash = (hash: string | undefined | null): string | null => (hash ? hash : null);

/**
 * Update queue state with Redis as source of truth and debounced Postgres writes.
 *
 * `expectedVersion` is a real optimistic-locking guard: when it is supplied and
 * the stored version has moved on, this throws `VersionConflictError` and the
 * caller must re-read and recompute. It used to be accepted and then silently
 * ignored — `newVersion` was derived from it without ever comparing it to the
 * stored value — which made every `VersionConflictError` retry loop pointed at
 * this function dead code and let concurrent mutations overwrite each other's
 * whole queue array (issue #3906).
 */
export async function updateQueueState(
  deps: RoomManagerDeps,
  sessionId: string,
  queue: ClimbQueueItem[],
  currentClimbQueueItem: ClimbQueueItem | null,
  expectedVersion: number | undefined,
): Promise<{
  version: number;
  sequence: number;
  stateHash: string;
  stateHashOrdered: string;
  previousStateHash: string | null;
  previousStateHashOrdered: string | null;
}> {
  const { redisStore, writeScheduler, distributedState } = deps;

  const stateHash = computeQueueStateHash(queue, currentClimbQueueItem?.uuid || null);
  // Order-sensitive companion (v2), computed from the exact same inputs so the
  // pair stays consistent. Both are now persisted in Redis, so the prior pair
  // comes straight back from the CAS instead of being recomputed on read.
  const stateHashOrdered = computeQueueStateHashOrdered(queue, currentClimbQueueItem?.uuid || null);

  // No Redis - Postgres is the only read source, and its guarded UPDATE is
  // already atomic. Unchanged behaviour.
  if (!redisStore) {
    const pgState = await getQueueState(sessionId, null);
    if (expectedVersion !== undefined && pgState.version !== expectedVersion) {
      throw new VersionConflictError(sessionId, expectedVersion);
    }
    const newVersion = pgState.version + 1;
    const newSequence = pgState.sequence + 1;
    await writeQueueStateToPostgres(
      sessionId,
      { queue, currentClimbQueueItem, version: newVersion, sequence: newSequence },
      writeScheduler,
    );
    return {
      version: newVersion,
      sequence: newSequence,
      stateHash,
      stateHashOrdered,
      previousStateHash: normalizeHash(pgState.stateHash),
      previousStateHashOrdered: normalizeHash(pgState.stateHashOrdered),
    };
  }

  // Single atomic read-check-write against Redis, the source of truth for
  // active sessions. The prior hashes come back from the same script call, so
  // callers (currently setQueue) can detect no-op resyncs without a second
  // round trip. setQueue's no-op check needs both: a pure reorder leaves the
  // order-insensitive v1 hash unchanged but moves v2, so comparing v1 alone
  // misreports a legitimate reorder as a no-op (issue #2387).
  const result = await casWithDormancyFloor(redisStore, sessionId, {
    queue,
    currentClimbQueueItem,
    expectedVersion: expectedVersion ?? CAS_ANY_VERSION,
    stateHash,
    stateHashOrdered,
  });

  if (result.status !== 'OK') {
    // `expectedVersion` is necessarily defined here: a CAS_ANY_VERSION call
    // cannot conflict, and NEEDS_FLOOR is resolved inside casWithDormancyFloor.
    throw new VersionConflictError(sessionId, expectedVersion ?? 0);
  }

  // Debounce Postgres write (30 seconds) - eventual consistency when Redis
  // provides fast reads.
  writeScheduler.schedulePostgresWrite(
    sessionId,
    queue,
    currentClimbQueueItem,
    result.version,
    result.sequence,
    distributedState,
  );

  return {
    version: result.version,
    sequence: result.sequence,
    stateHash,
    stateHashOrdered,
    previousStateHash: normalizeHash(result.previousStateHash),
    previousStateHashOrdered: normalizeHash(result.previousStateHashOrdered),
  };
}

/**
 * Mirror a Postgres-settled queue state into Redis. Safe as a blind write only
 * because the counters came from a guarded SQL statement that already resolved
 * the conflict — live party mutations must use the CAS instead (#3906).
 */
async function mirrorSettledStateToRedis(
  redisStore: RedisSessionStore,
  sessionId: string,
  queue: ClimbQueueItem[],
  currentClimbQueueItem: ClimbQueueItem | null,
  version: number,
  sequence: number,
): Promise<void> {
  const currentClimbUuid = currentClimbQueueItem?.uuid || null;
  await redisStore.updateQueueState(
    sessionId,
    queue,
    currentClimbQueueItem,
    version,
    sequence,
    computeQueueStateHash(queue, currentClimbUuid),
    computeQueueStateHashOrdered(queue, currentClimbUuid),
  );
}

/**
 * Update queue state with immediate Postgres write (for critical operations).
 * Use this when you need immediate Postgres consistency (e.g., session creation).
 */
export async function updateQueueStateImmediate(
  deps: RoomManagerDeps,
  sessionId: string,
  queue: ClimbQueueItem[],
  currentClimbQueueItem: ClimbQueueItem | null,
  expectedVersion: number | undefined,
): Promise<number> {
  const { redisStore } = deps;

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
        await mirrorSettledStateToRedis(
          redisStore,
          sessionId,
          queue,
          currentClimbQueueItem,
          result[0].version,
          result[0].sequence,
        );
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
      .where(and(eq(sessionQueues.sessionId, sessionId), eq(sessionQueues.version, expectedVersion)))
      .returning();

    if (result.length === 0) {
      throw new VersionConflictError(sessionId, expectedVersion);
    }

    // Also update Redis
    if (redisStore) {
      await mirrorSettledStateToRedis(
        redisStore,
        sessionId,
        queue,
        currentClimbQueueItem,
        result[0].version,
        result[0].sequence,
      );
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
    await mirrorSettledStateToRedis(redisStore, sessionId, queue, currentClimbQueueItem, newVersion, newSequence);
  }

  return newVersion;
}

/**
 * Update only the queue, carrying `currentClimbQueueItem` through unchanged.
 * Uses Redis as source of truth for real-time state. Postgres writes are debounced.
 *
 * `expectedVersion` is the optimistic-locking guard. It was already compared
 * here before #3906, but as a check-then-act across two round trips — two
 * callers could both pass the comparison and then both write. The comparison
 * now happens inside the same Lua script as the write.
 */
export async function updateQueueOnly(
  deps: RoomManagerDeps,
  sessionId: string,
  queue: ClimbQueueItem[],
  expectedVersion: number | undefined,
  knownState?: Pick<QueueState, 'currentClimbQueueItem'>,
): Promise<{ version: number; sequence: number; stateHash: string; stateHashOrdered: string }> {
  const { redisStore, writeScheduler, distributedState } = deps;

  if (!redisStore) {
    // No Redis - Postgres is the only read source, so read it. Deliberately
    // ignores `knownState` for the version comparison: the caller's
    // `expectedVersion` came out of that same snapshot, so comparing the two
    // would always agree and the guard would be vacuous. Only the Redis path,
    // where the CAS re-reads the authoritative version itself, can safely take
    // the caller's word for anything.
    const pgState = await getQueueState(sessionId, null);
    const currentClimbUuid = pgState.currentClimbQueueItem?.uuid || null;
    if (expectedVersion !== undefined && pgState.version !== expectedVersion) {
      throw new VersionConflictError(sessionId, expectedVersion);
    }
    const newVersion = pgState.version + 1;
    const newSequence = pgState.sequence + 1;
    await writeQueueStateToPostgres(
      sessionId,
      {
        queue,
        currentClimbQueueItem: pgState.currentClimbQueueItem,
        version: newVersion,
        sequence: newSequence,
      },
      writeScheduler,
    );
    return {
      version: newVersion,
      sequence: newSequence,
      stateHash: computeQueueStateHash(queue, currentClimbUuid),
      stateHashOrdered: computeQueueStateHashOrdered(queue, currentClimbUuid),
    };
  }

  // The current climb is carried through untouched, so it still has to be known
  // to recompute the hashes. Callers inside `withQueueVersionRetry` already hold
  // freshly-read state and pass it in, rather than making this a second Redis
  // read per attempt. A stale current climb can never be written either way:
  // changing it bumps the version, which the CAS below rejects.
  // Branch on whether the caller supplied state at all, not on the climb being
  // truthy — `null` is a legitimate value (no current climb) and `??` would
  // send that case back for a pointless second read.
  const currentClimbQueueItem = knownState
    ? knownState.currentClimbQueueItem
    : (await getQueueState(sessionId, redisStore)).currentClimbQueueItem;

  const stateHash = computeQueueStateHash(queue, currentClimbQueueItem?.uuid || null);
  const stateHashOrdered = computeQueueStateHashOrdered(queue, currentClimbQueueItem?.uuid || null);

  const result = await casWithDormancyFloor(redisStore, sessionId, {
    queue,
    currentClimbQueueItem,
    expectedVersion: expectedVersion ?? CAS_ANY_VERSION,
    stateHash,
    stateHashOrdered,
  });

  if (result.status !== 'OK') {
    throw new VersionConflictError(sessionId, expectedVersion ?? 0);
  }

  // Debounce Postgres write - eventual consistency when Redis provides fast reads
  writeScheduler.schedulePostgresWrite(
    sessionId,
    queue,
    currentClimbQueueItem,
    result.version,
    result.sequence,
    distributedState,
  );

  return { version: result.version, sequence: result.sequence, stateHash, stateHashOrdered };
}

/**
 * Get current queue state from Redis (preferred) or Postgres.
 */
export async function getQueueState(sessionId: string, redisStore: RedisSessionStore | null): Promise<QueueState> {
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
        // Both hashes are persisted since #3906. Sessions written before that
        // rollout have no stored v2 hash (empty string), so fall back to
        // recomputing it from the same stored queue — the pair stays consistent
        // either way.
        stateHashOrdered:
          redisSession.stateHashOrdered ||
          computeQueueStateHashOrdered(redisSession.queue, redisSession.currentClimbQueueItem?.uuid || null),
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
      stateHashOrdered: computeQueueStateHashOrdered([], null),
    };
  }

  const stateHash = computeQueueStateHash(result[0].queue, result[0].currentClimbQueueItem?.uuid || null);
  const stateHashOrdered = computeQueueStateHashOrdered(result[0].queue, result[0].currentClimbQueueItem?.uuid || null);

  return {
    queue: result[0].queue,
    currentClimbQueueItem: result[0].currentClimbQueueItem,
    version: result[0].version,
    sequence: result[0].sequence,
    stateHash,
    stateHashOrdered,
  };
}
