import type { ClimbQueueItem } from '@boardsesh/shared-schema';
import { db } from '../../db/client';
import { sessionQueues } from '../../db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { CAS_ANY_VERSION, type RedisSessionStore, type QueueStateCasResult } from '../redis-session-store';
import { computeQueueStateHash, computeQueueStateHashOrdered, historyLine } from '@boardsesh/queue';
import { VersionConflictError, type QueueState, type QueueWriteResult, type RoomManagerDeps } from './types';
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
    /**
     * The History / Up next line (F3, docs/current-climb-outside-queue.md,
     * section 2). Required, so the compiler finds every writer: a write that
     * left it to a default would erase the line while nothing is current.
     */
    historyCount: number;
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
 * The line a write stores: the current climb's index when it is in `queue`,
 * else the caller's value clamped to `[0, queue.length]` (invariant 5 of the
 * F3 design: every write stores a computed, in-range line).
 */
function storedLine(queue: ClimbQueueItem[], currentClimbQueueItem: ClimbQueueItem | null, historyCount: number) {
  return historyLine({ queue, currentClimbQueueItem, historyCount });
}

/**
 * The Postgres-only single-instance fallback has no Redis hash to keep the F3
 * fields in, and `board_session_queues` has no column for them (no migration,
 * section 2). They live here, keyed by session, and count only while the row's
 * version still matches. After a restart the line comes back as derived.
 * Bounded: past {@link MAX_POSTGRES_ONLY_LINES} sessions the least recently
 * written is forgotten, and its line comes back as derived too.
 */
const MAX_POSTGRES_ONLY_LINES = 5000;
const postgresOnlyLines = new Map<
  string,
  { version: number; historyCount: number; currentUuid: string | null; currentChangedAt: string }
>();

function rememberPostgresOnlyLine(
  sessionId: string,
  version: number,
  historyCount: number,
  currentClimbQueueItem: ClimbQueueItem | null,
): string {
  const currentUuid = currentClimbQueueItem?.uuid ?? null;
  const previous = postgresOnlyLines.get(sessionId);
  const currentChangedAt =
    previous && previous.currentUuid === currentUuid ? previous.currentChangedAt : new Date().toISOString();
  // Delete first so the Map's insertion order is least recently written first.
  postgresOnlyLines.delete(sessionId);
  postgresOnlyLines.set(sessionId, { version, historyCount, currentUuid, currentChangedAt });
  if (postgresOnlyLines.size > MAX_POSTGRES_ONLY_LINES) {
    const oldestSessionId = postgresOnlyLines.keys().next().value;
    if (oldestSessionId !== undefined) postgresOnlyLines.delete(oldestSessionId);
  }
  return currentChangedAt;
}

/** Test seam: forget the Postgres-only lines. */
export function resetPostgresOnlyQueueLines(): void {
  postgresOnlyLines.clear();
}

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
  historyCount: number,
): Promise<QueueWriteResult & { previousStateHash: string | null; previousStateHashOrdered: string | null }> {
  const { redisStore, writeScheduler, distributedState } = deps;
  const line = storedLine(queue, currentClimbQueueItem, historyCount);

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
    const currentChangedAt = rememberPostgresOnlyLine(sessionId, newVersion, line, currentClimbQueueItem);
    return {
      version: newVersion,
      sequence: newSequence,
      stateHash,
      stateHashOrdered,
      historyCount: line,
      currentChangedAt,
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
    historyCount: line,
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
    historyCount: line,
    currentChangedAt: new Date(result.currentChangedAt).toISOString(),
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
  historyCount: number,
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
    historyCount,
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
  historyCount: number,
): Promise<number> {
  const { redisStore } = deps;
  const line = storedLine(queue, currentClimbQueueItem, historyCount);
  // Mirror the settled row into Redis, or (Postgres-only) into the in-memory line store.
  const settle = async (version: number, sequence: number) => {
    if (redisStore) {
      await mirrorSettledStateToRedis(redisStore, sessionId, queue, currentClimbQueueItem, version, sequence, line);
    } else {
      rememberPostgresOnlyLine(sessionId, version, line, currentClimbQueueItem);
    }
  };

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

      await settle(result[0].version, result[0].sequence);
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

    await settle(result[0].version, result[0].sequence);
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

  await settle(newVersion, newSequence);
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
  knownState: Pick<QueueState, 'currentClimbQueueItem'> | undefined,
  historyCount: number,
): Promise<QueueWriteResult> {
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
    const line = storedLine(queue, pgState.currentClimbQueueItem, historyCount);
    const currentChangedAt = rememberPostgresOnlyLine(sessionId, newVersion, line, pgState.currentClimbQueueItem);
    return {
      version: newVersion,
      sequence: newSequence,
      stateHash: computeQueueStateHash(queue, currentClimbUuid),
      stateHashOrdered: computeQueueStateHashOrdered(queue, currentClimbUuid),
      historyCount: line,
      currentChangedAt,
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
  // Without the line, every add or reorder would bump `version` past
  // `historyCountVersion` and the reader would fall back to 0 while nothing is
  // current: the erased line this field exists to prevent.
  const line = storedLine(queue, currentClimbQueueItem, historyCount);

  const result = await casWithDormancyFloor(redisStore, sessionId, {
    queue,
    currentClimbQueueItem,
    expectedVersion: expectedVersion ?? CAS_ANY_VERSION,
    stateHash,
    stateHashOrdered,
    historyCount: line,
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

  return {
    version: result.version,
    sequence: result.sequence,
    stateHash,
    stateHashOrdered,
    historyCount: line,
    currentChangedAt: new Date(result.currentChangedAt).toISOString(),
  };
}

/**
 * Get current queue state from Redis (preferred) or Postgres.
 */
export async function getQueueState(sessionId: string, redisStore: RedisSessionStore | null): Promise<QueueState> {
  // Check Redis first (source of truth for active sessions)
  if (redisStore) {
    const redisSession = await redisStore.getSession(sessionId);
    if (redisSession) {
      // A pre-F3 instance's write (rolling deploy) bumps `version` and leaves
      // the F3 fields behind: count them only when they were written at this
      // version, otherwise derive the line (the current index, or 0 with
      // nothing current, which is today's display) and fall back to
      // `lastActivity`, which that old write just stamped (errs towards lighting).
      const fieldsFresh =
        redisSession.historyCountVersion !== null && redisSession.historyCountVersion === redisSession.version;
      return {
        queue: redisSession.queue,
        currentClimbQueueItem: redisSession.currentClimbQueueItem,
        version: redisSession.version,
        sequence: redisSession.sequence,
        historyCount: historyLine({
          queue: redisSession.queue,
          currentClimbQueueItem: redisSession.currentClimbQueueItem,
          historyCount: fieldsFresh ? redisSession.historyCount : null,
        }),
        currentChangedAt: (fieldsFresh && redisSession.currentChangedAt
          ? redisSession.currentChangedAt
          : redisSession.lastActivity
        ).toISOString(),
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
      historyCount: 0,
      currentChangedAt: null,
      stateHash: computeQueueStateHash([], null),
      stateHashOrdered: computeQueueStateHashOrdered([], null),
    };
  }

  const row = result[0];
  const stateHash = computeQueueStateHash(row.queue, row.currentClimbQueueItem?.uuid || null);
  const stateHashOrdered = computeQueueStateHashOrdered(row.queue, row.currentClimbQueueItem?.uuid || null);
  // No Postgres column holds the line (section 2): a dormant restore derives
  // it from the current index, or 0 with nothing current, and takes the hold's
  // clock from `updated_at`, which every queue flush writes. That is
  // approximate in one direction only: an Up next add also bumps `updated_at`,
  // so a restored room can read as changed recently and light, never the
  // other way. The Postgres-only single instance keeps both in memory.
  const remembered = postgresOnlyLines.get(sessionId);
  const rememberedFresh = !redisStore && remembered !== undefined && remembered.version === row.version;

  return {
    queue: row.queue,
    currentClimbQueueItem: row.currentClimbQueueItem,
    version: row.version,
    sequence: row.sequence,
    historyCount: historyLine({
      queue: row.queue,
      currentClimbQueueItem: row.currentClimbQueueItem,
      historyCount: rememberedFresh ? remembered.historyCount : null,
    }),
    currentChangedAt: rememberedFresh ? remembered.currentChangedAt : row.updatedAt.toISOString(),
    stateHash,
    stateHashOrdered,
  };
}
