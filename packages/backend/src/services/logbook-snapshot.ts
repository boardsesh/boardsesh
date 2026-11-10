import { and, asc, eq, gt, inArray, isNull, lte, ne, or, sql, sum, type SQL } from 'drizzle-orm';
import { boardClimbAliases, boardseshTicks, logbookSnapshotChunks, logbookSnapshots } from '@boardsesh/db/schema';
import type { LogbookSnapshotChunkTick } from '@boardsesh/db/schema';
import type { BackgroundJobTransaction } from '@boardsesh/db/queries';
import type { Database } from '../db/client';
import { logger } from '../utils/logger';
import { getPostgresErrorCode } from '../utils/postgres-errors';
import {
  LOGBOOK_FEED_MAX_PAGE_SIZE,
  LOGBOOK_FEED_MIN_PAGE_SIZE,
  boundLogbookReadTransaction,
  logbookFeedAliasJoin,
  logbookFeedTickColumns,
  logbookVisibleTicksFilter,
  positionIsBefore,
  readLogbookFeedState,
  ticksOf,
  type FeedTransaction,
  type LogbookFeedCursor,
  type LogbookFeedEntry,
  type LogbookFeedState,
  type LogbookFeedTick,
  type LogbookPageReader,
} from './logbook-feed';

/**
 * The complete logbook snapshot a partner app downloads before following the
 * change feed. Design and proof: docs/integration-platform.md, "Complete
 * bootstrap and transition". `GET /v1/logbook/changes` without a cursor, or
 * with a snapshot cursor, drives it (handlers/public-api/logbook.ts).
 *
 * Hand-off. A snapshot captures the horizon H first, in its own transaction,
 * then copies the ticks over many short transactions. Every copied page reads
 * a later snapshot than H's, so it already contains every transaction below H.
 * Any change that lands after H has a transaction id at or above H and the
 * feed replays it from `(H, 0)`. No page-level transaction has to stay open:
 * the snapshot's own pages can be at different points in time and the two
 * sources together still cover everything, the same argument the feed makes in
 * "Why it cannot skip a change".
 *
 * Build rules: `advanceLogbookSnapshotBuild` copies a chunk at a time, one
 * short transaction each, and returns after its time budget, so the caller's
 * request never holds a transaction across the build and an abandoned build
 * resumes from where it stopped.
 *
 * The API runs these on a small dedicated pool (`LOGBOOK_SNAPSHOT_POOL_MAX` in
 * auth/partner/logbook-access.ts), so a cold chunk cannot hold a connection
 * the first-party queries need (`DB_POOL_MAX` defaults to 5).
 */

/** Readable for one hour from the moment the copy finishes, whether or not the reclaim job has run. */
export const LOGBOOK_SNAPSHOT_TTL_SECONDS = 3600;
/**
 * How long a build may run before it is abandoned. The one-hour TTL only starts
 * once the copy is done, because the client cannot download anything before then.
 * The sizing is in docs/integration-platform.md, "What it costs".
 */
export const LOGBOOK_SNAPSHOT_BUILD_DEADLINE_SECONDS = 3 * 3600;
/** One chunk holds one maximum feed page, so a page read touches at most two chunks. */
export const LOGBOOK_SNAPSHOT_CHUNK_TICKS = LOGBOOK_FEED_MAX_PAGE_SIZE;
/** A larger logbook ends its build as `too_large` rather than being truncated. */
export const LOGBOOK_SNAPSHOT_MAX_TICKS = 250_000;
/**
 * How many chunks may be copying at once across the cluster, held for one chunk
 * transaction each. Sized against the backend pool (`DB_POOL_MAX`, default 5): a
 * cold chunk holds its connection for up to the statement timeout.
 */
export const LOGBOOK_SNAPSHOT_BUILD_SLOTS = 2;
/** Advisory lock class for the build slots; the slot number is the second key. */
export const LOGBOOK_SNAPSHOT_BUILD_SLOT_LOCK_CLASS = 720_388_441;
/** Ticks stored across every snapshot, retired or live, until the reclaim job has run. */
export const LOGBOOK_SNAPSHOT_MAX_STORED_TICKS = 25_000_000;
/** Chunks deleted per reclaim transaction, however many snapshots they belong to. */
export const LOGBOOK_SNAPSHOT_RECLAIM_CHUNKS_PER_BATCH = 500;
/** Expired snapshots one reclaim transaction claims. */
export const LOGBOOK_SNAPSHOT_RECLAIM_SNAPSHOTS_PER_BATCH = 100;
/** Batches one reclaim run may delete before leaving the rest for the next run. */
export const LOGBOOK_SNAPSHOT_RECLAIM_MAX_BATCHES = 200;
/** Default time one `advance` call spends copying before it hands back to its caller. */
export const LOGBOOK_SNAPSHOT_BUILD_BUDGET_MS = 1_000;
/**
 * Consecutive statement timeouts that end a build as `stalled`. A timed-out chunk
 * leaves its pages cached, so a slow chunk gets further each try: 20 tries is
 * 100 s of reads, 3,300 cold pages at 30 ms against a worst chunk of 551. A chunk
 * that still cannot finish is not going to.
 */
export const LOGBOOK_SNAPSHOT_MAX_CONSECUTIVE_TIMEOUTS = 20;
/** Seconds a build sits out after a chunk times out, so it cannot hold a slot back to back. */
export const LOGBOOK_SNAPSHOT_TIMEOUT_COOLDOWN_SECONDS = 5;

/**
 * 5 s per statement, the same limit the partner OAuth transactions use. A worst
 * case fully cold chunk needs about 16.5 s at 30 ms a page, so it times out three
 * times and succeeds on the fourth call: the pages each failed attempt read stay
 * in shared buffers. Raising the limit would only make a cold chunk hold its
 * connection longer.
 */
const STATEMENT_TIMEOUT = '5000ms';
const LOCK_TIMEOUT = '2000ms';
/** Ends a transaction whose client froze mid-chunk, so it cannot keep a build slot. */
const IDLE_IN_TRANSACTION_TIMEOUT = '10s';

/** Seed for the per-connection advisory lock that serializes `start`. */
export const LOGBOOK_SNAPSHOT_START_LOCK_SEED = 720_388_442;

const STATEMENT_TIMEOUT_ERROR_CODE = '57014';
const LOCK_TIMEOUT_ERROR_CODE = '55P03';

function isOutOfTimeError(error: unknown): boolean {
  const code = getPostgresErrorCode(error);
  return code === STATEMENT_TIMEOUT_ERROR_CODE || code === LOCK_TIMEOUT_ERROR_CODE;
}

/** The app/climber connection a snapshot belongs to. Checked on every read and build step. */
export type LogbookSnapshotBinding = {
  userId: string;
  connectionId: string;
  connectionGeneration: number;
};

export type LogbookSnapshotCursor = { snapshotId: string; position: number };

/** A build that ended this way stays refused until its verdict expires, this many seconds from now. */
export type LogbookSnapshotVerdict = { reason: 'too_large' | 'stalled'; retryAfterSeconds: number };

export type LogbookSnapshotStart =
  | {
      status: 'started';
      cursor: LogbookSnapshotCursor;
      /** False when the call joined a snapshot that already existed: only real creations spend the rate limit. */
      created: boolean;
    }
  /**
   * `creation_limited`: the caller said a new snapshot may not be created now
   * (its creation limit is spent) and there was none to join.
   */
  | { status: 'unavailable'; reason: 'capacity' | 'busy' | 'creation_limited' }
  | ({ status: 'unavailable' } & LogbookSnapshotVerdict);

export type LogbookSnapshotBuildProgress =
  | { status: 'building' }
  | { status: 'ready' }
  | { status: 'expired' }
  | { status: 'too_large' }
  | { status: 'stalled' };

export type LogbookSnapshotExpiredReason =
  | 'snapshot_not_found'
  | 'generation_mismatch'
  | 'below_watermark'
  | 'too_large'
  | 'stalled';

export type LogbookSnapshotPage =
  | {
      status: 'ok';
      entries: LogbookFeedEntry[];
      /** The next snapshot page, or the ordinary change cursor `(H, 0)` after the last one. */
      next: { kind: 'snapshot'; cursor: LogbookSnapshotCursor } | { kind: 'changes'; cursor: LogbookFeedCursor };
      /** Always true: the snapshot leads into catch-up, and only that can end with false. */
      hasMore: true;
    }
  | { status: 'building' }
  | { status: 'expired'; reason: Exclude<LogbookSnapshotExpiredReason, LogbookSnapshotVerdict['reason']> }
  | ({ status: 'expired' } & LogbookSnapshotVerdict);

export type LogbookSnapshotReclaimResult = {
  snapshotsRemoved: number;
  chunksRemoved: number;
  /** True when the run hit its batch cap with expired rows still to remove. */
  capped: boolean;
};

function snapshotIsLive(): SQL {
  return gt(logbookSnapshots.expiresAt, sql`now()`);
}

/** Whole seconds until the row expires, by the database clock, at least 1. */
const secondsUntilExpiry = sql<number>`GREATEST(1, CEIL(EXTRACT(EPOCH FROM ${logbookSnapshots.expiresAt} - now())))::int`;

/** The one rule that keeps a snapshot private to its connection. */
function snapshotBelongsTo(binding: LogbookSnapshotBinding): SQL {
  return and(
    eq(logbookSnapshots.userId, binding.userId),
    eq(logbookSnapshots.connectionId, binding.connectionId),
    eq(logbookSnapshots.connectionGeneration, binding.connectionGeneration),
  ) as SQL;
}

async function boundThisTransaction(transaction: FeedTransaction): Promise<void> {
  await transaction.execute(
    sql`SELECT set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true), set_config('lock_timeout', ${LOCK_TIMEOUT}, true), set_config('idle_in_transaction_session_timeout', ${IDLE_IN_TRANSACTION_TIMEOUT}, true)`,
  );
}

/**
 * Keeps one chunk's cost tied to its 200 ticks. Left to itself the planner picks
 * a Merge Anti Join for the twin `NOT EXISTS` in most chunks, and that join's
 * inner scan starts at the climber's first tick because the keyset bound cannot
 * reach the `aurora_twin` alias: a chunk deep in a 100,000-tick logbook touched
 * 50,350 buffers. A Nested Loop Anti Join probes one tick at a time, so the cost
 * does not depend on position. Scoped to this transaction.
 */
async function forceChunkPlan(transaction: FeedTransaction): Promise<void> {
  await transaction.execute(
    sql`SELECT set_config('enable_mergejoin', 'off', true), set_config('enable_hashjoin', 'off', true)`,
  );
}

/** Takes a free build slot for this transaction, or answers false when all are busy. */
async function takeBuildSlot(transaction: FeedTransaction): Promise<boolean> {
  for (let slot = 0; slot < LOGBOOK_SNAPSHOT_BUILD_SLOTS; slot += 1) {
    const [{ taken }] = (await transaction.execute(
      sql`SELECT pg_try_advisory_xact_lock(${LOGBOOK_SNAPSHOT_BUILD_SLOT_LOCK_CLASS}::int, ${slot}::int) AS taken`,
    )) as unknown as Array<{ taken: boolean }>;
    if (taken) return true;
  }
  return false;
}

async function storedTicksAcrossSnapshots(transaction: FeedTransaction): Promise<number> {
  const [{ storedTicks }] = await transaction
    .select({ storedTicks: sum(logbookSnapshots.tickCount) })
    .from(logbookSnapshots);
  return Number(storedTicks ?? 0);
}

/**
 * Whether a snapshot this connection already has can still be joined: a paged
 * snapshot stays valid until it expires, as long as its catch-up still exists.
 */
function snapshotCanBeJoined(
  existing: { feedGeneration: string; horizonTxid: string },
  feedState: LogbookFeedState,
): boolean {
  return (
    existing.feedGeneration === feedState.generation &&
    !positionIsBefore({ txid: existing.horizonTxid, seq: '0' }, feedState.prunedThrough)
  );
}

/**
 * Begin a snapshot for this connection, or join the one it already has.
 *
 * Joining a build or a finished snapshot is what lets a crash retry, or a second
 * worker of one connection, reuse the copy instead of destroying it. A snapshot
 * the feed can no longer continue from (rotated generation, pruned catch-up) is
 * not joined. A build that ended `too_large` or `stalled` stays refused until
 * that verdict expires, so a restart cannot repeat the same failure.
 *
 * Nothing is retired until the new snapshot is certain to be created, so a
 * capacity refusal leaves the old one readable.
 *
 * `createAllowed: false` still joins, and answers `creation_limited` where it
 * would have created: the API passes it once the connection has spent its
 * creation limit, so a retry that joins is never refused for that limit.
 *
 * H is read before the row exists, and the row commits before any tick is
 * copied, so every copied page is read after H.
 */
export async function startLogbookSnapshot(
  database: Database,
  binding: LogbookSnapshotBinding,
  options: { maxStoredTicks?: number; createAllowed?: boolean } = {},
): Promise<LogbookSnapshotStart> {
  try {
    return await createOrJoinSnapshot(database, binding, options);
  } catch (error) {
    // A chunk holding the old row, or another start on this connection. Nothing
    // was committed, so the caller can simply come back.
    if (isOutOfTimeError(error)) return { status: 'unavailable', reason: 'busy' };
    throw error;
  }
}

async function createOrJoinSnapshot(
  database: Database,
  binding: LogbookSnapshotBinding,
  {
    maxStoredTicks = LOGBOOK_SNAPSHOT_MAX_STORED_TICKS,
    createAllowed = true,
  }: { maxStoredTicks?: number; createAllowed?: boolean },
): Promise<LogbookSnapshotStart> {
  return database.transaction(async (transaction): Promise<LogbookSnapshotStart> => {
    await boundThisTransaction(transaction);
    // One start per connection at a time. Different connections share nothing
    // here: build concurrency is enforced by the slots, per chunk.
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${binding.connectionId}, ${LOGBOOK_SNAPSHOT_START_LOCK_SEED}::bigint))`,
    );

    const feedState = await readLogbookFeedState(transaction);
    const [existing] = await transaction
      .select({
        id: logbookSnapshots.id,
        status: logbookSnapshots.status,
        feedGeneration: logbookSnapshots.feedGeneration,
        horizonTxid: logbookSnapshots.horizonTxid,
        retryAfterSeconds: secondsUntilExpiry,
      })
      .from(logbookSnapshots)
      .where(and(snapshotBelongsTo(binding), ne(logbookSnapshots.status, 'retired'), snapshotIsLive()));

    if (existing && snapshotCanBeJoined(existing, feedState)) {
      if (existing.status === 'too_large' || existing.status === 'stalled') {
        return { status: 'unavailable', reason: existing.status, retryAfterSeconds: existing.retryAfterSeconds };
      }
      return { status: 'started', cursor: { snapshotId: existing.id, position: 0 }, created: false };
    }

    if (!createAllowed) return { status: 'unavailable', reason: 'creation_limited' };

    if ((await storedTicksAcrossSnapshots(transaction)) >= maxStoredTicks) {
      return { status: 'unavailable', reason: 'capacity' };
    }

    await transaction
      .update(logbookSnapshots)
      .set({ status: 'retired', expiresAt: sql`now()` })
      .where(and(eq(logbookSnapshots.connectionId, binding.connectionId), ne(logbookSnapshots.status, 'retired')));

    const [created] = await transaction
      .insert(logbookSnapshots)
      .values({
        userId: binding.userId,
        connectionId: binding.connectionId,
        connectionGeneration: binding.connectionGeneration,
        feedGeneration: feedState.generation,
        horizonTxid: feedState.horizon,
        expiresAt: sql`now() + make_interval(secs => ${LOGBOOK_SNAPSHOT_BUILD_DEADLINE_SECONDS})`,
      })
      .returning({ id: logbookSnapshots.id });

    return { status: 'started', cursor: { snapshotId: created.id, position: 0 }, created: true };
  });
}

/** Copy the next chunk of ticks, in one short transaction of its own. */
async function buildNextChunk(
  database: Database,
  binding: LogbookSnapshotBinding,
  snapshotId: string,
  { maxTicks, maxStoredTicks }: { maxTicks: number; maxStoredTicks: number },
): Promise<{ progress: LogbookSnapshotBuildProgress; copied: boolean }> {
  return database.transaction(async (transaction) => {
    await boundThisTransaction(transaction);
    await forceChunkPlan(transaction);

    if (!(await takeBuildSlot(transaction))) {
      return { progress: await currentBuildProgress(transaction, binding, snapshotId), copied: false };
    }

    const [snapshot] = await transaction
      .select({
        tickCount: logbookSnapshots.tickCount,
        chunkCount: logbookSnapshots.chunkCount,
        nextUpdatedAt: logbookSnapshots.nextUpdatedAt,
        nextTickId: logbookSnapshots.nextTickId,
      })
      .from(logbookSnapshots)
      .where(
        and(
          eq(logbookSnapshots.id, snapshotId),
          snapshotBelongsTo(binding),
          eq(logbookSnapshots.status, 'building'),
          snapshotIsLive(),
          // Sitting out a timeout: the row is left alone until the cooldown ends.
          or(isNull(logbookSnapshots.retryNotBefore), lte(logbookSnapshots.retryNotBefore, sql`now()`)),
        ),
      )
      // Two callers of one connection never copy the same chunk twice: a second
      // caller gets no row here and answers from the row's current status.
      .for('no key update', { skipLocked: true });

    if (!snapshot) return { progress: await currentBuildProgress(transaction, binding, snapshotId), copied: false };

    // The storage cap holds during builds too, within one chunk per slot. A
    // build at the cap waits for the reclaim job rather than failing.
    if ((await storedTicksAcrossSnapshots(transaction)) >= maxStoredTicks) {
      return { progress: { status: 'building' }, copied: false };
    }

    const keyset =
      snapshot.nextUpdatedAt === null || snapshot.nextTickId === null
        ? undefined
        : sql`(${boardseshTicks.updatedAt}, ${boardseshTicks.id}) > (${snapshot.nextUpdatedAt}::timestamp, ${snapshot.nextTickId}::bigint)`;

    // `(user_id, updated_at, id)` is an existing index that serves this order
    // exactly, so the scan stops after 200 visible rows. Ordering by `climbed_at`
    // reads a whole group of equal timestamps to sort it by `id`, and the twin
    // join makes that k^2: 5,000 ticks at one instant never finished. Any order is
    // complete: a row moved by a write during the build has a change at or above
    // H, so the feed replays it. It can repeat here, never go missing.
    const rows = await transaction
      .select({ ...logbookFeedTickColumns, rowId: boardseshTicks.id })
      .from(boardseshTicks)
      .leftJoin(boardClimbAliases, logbookFeedAliasJoin)
      .where(and(logbookVisibleTicksFilter(binding.userId), keyset))
      .orderBy(asc(boardseshTicks.updatedAt), asc(boardseshTicks.id))
      .limit(LOGBOOK_SNAPSHOT_CHUNK_TICKS);

    const tickCount = snapshot.tickCount + rows.length;
    if (tickCount > maxTicks) {
      // Terminal until it expires: `start` answers `too_large` instead of
      // rebuilding the same logbook.
      await transaction
        .update(logbookSnapshots)
        .set({ status: 'too_large', expiresAt: sql`now() + make_interval(secs => ${LOGBOOK_SNAPSHOT_TTL_SECONDS})` })
        .where(eq(logbookSnapshots.id, snapshotId));
      return { progress: { status: 'too_large' }, copied: false };
    }

    if (rows.length > 0) {
      await transaction.insert(logbookSnapshotChunks).values({
        snapshotId,
        chunkIndex: snapshot.chunkCount,
        ticks: rows.map(({ rowId: _rowId, ...tick }): LogbookSnapshotChunkTick => tick),
      });
    }

    // A short chunk means the keyset ran off the end of the logbook.
    const complete = rows.length < LOGBOOK_SNAPSHOT_CHUNK_TICKS;
    const lastRow = rows[rows.length - 1];
    await transaction
      .update(logbookSnapshots)
      .set({
        status: complete ? 'ready' : 'building',
        tickCount,
        chunkCount: rows.length > 0 ? snapshot.chunkCount + 1 : snapshot.chunkCount,
        nextUpdatedAt: lastRow ? lastRow.updatedAt : snapshot.nextUpdatedAt,
        nextTickId: lastRow ? lastRow.rowId : snapshot.nextTickId,
        chunkTimeoutStreak: 0,
        retryNotBefore: null,
        // The hour a client has to download starts when there is something to download.
        ...(complete ? { expiresAt: sql`now() + make_interval(secs => ${LOGBOOK_SNAPSHOT_TTL_SECONDS})` } : {}),
      })
      .where(eq(logbookSnapshots.id, snapshotId));

    return { progress: complete ? { status: 'ready' } : { status: 'building' }, copied: true };
  });
}

/** The row's status for a caller that could not lock it or does not own it. */
async function currentBuildProgress(
  transaction: FeedTransaction,
  binding: LogbookSnapshotBinding,
  snapshotId: string,
): Promise<LogbookSnapshotBuildProgress> {
  const [snapshot] = await transaction
    .select({ status: logbookSnapshots.status })
    .from(logbookSnapshots)
    .where(and(eq(logbookSnapshots.id, snapshotId), snapshotBelongsTo(binding), snapshotIsLive()));
  if (!snapshot || snapshot.status === 'retired') return { status: 'expired' };
  return { status: snapshot.status };
}

/**
 * A chunk ran out of statement time. Its transaction rolled back, so this is
 * written separately: the streak, the cooldown, and at the limit the verdict
 * that ends the build. Logged with the snapshot id only, never the climber.
 */
async function recordChunkTimeout(
  database: Database,
  binding: LogbookSnapshotBinding,
  snapshotId: string,
): Promise<LogbookSnapshotBuildProgress> {
  const reachedLimit = sql`${logbookSnapshots.chunkTimeoutStreak} + 1 >= ${LOGBOOK_SNAPSHOT_MAX_CONSECUTIVE_TIMEOUTS}`;
  const [updated] = await database
    .update(logbookSnapshots)
    .set({
      chunkTimeoutStreak: sql`${logbookSnapshots.chunkTimeoutStreak} + 1`,
      retryNotBefore: sql`now() + make_interval(secs => ${LOGBOOK_SNAPSHOT_TIMEOUT_COOLDOWN_SECONDS})`,
      status: sql`CASE WHEN ${reachedLimit} THEN 'stalled' ELSE ${logbookSnapshots.status} END`,
      expiresAt: sql`CASE WHEN ${reachedLimit} THEN now() + make_interval(secs => ${LOGBOOK_SNAPSHOT_TTL_SECONDS}) ELSE ${logbookSnapshots.expiresAt} END`,
    })
    .where(
      and(
        eq(logbookSnapshots.id, snapshotId),
        snapshotBelongsTo(binding),
        eq(logbookSnapshots.status, 'building'),
        snapshotIsLive(),
      ),
    )
    .returning({ status: logbookSnapshots.status, timeoutStreak: logbookSnapshots.chunkTimeoutStreak });

  if (!updated) return database.transaction((transaction) => currentBuildProgress(transaction, binding, snapshotId));

  logger.warn('[logbook-snapshot] chunk hit the statement timeout', {
    snapshotId,
    timeoutStreak: updated.timeoutStreak,
    stalled: updated.status === 'stalled',
  });
  return updated.status === 'stalled' ? { status: 'stalled' } : { status: 'building' };
}

/**
 * Copy ticks into a snapshot until it is finished or `timeBudgetMs` runs out.
 * Each chunk is its own short transaction, so nothing is held between chunks,
 * and at least one chunk is attempted on every call so a tiny budget still makes
 * progress. Safe to call from any process at any time: the build position lives
 * on the row.
 *
 * A call stops at once, answering `building`, when no slot is free, another
 * caller holds the row, the storage cap is reached, the build is cooling down
 * after a timeout, or the step ran out of time or could not get a lock. The
 * rolled-back step leaves its pages cached, so the next call gets further. After
 * `LOGBOOK_SNAPSHOT_MAX_CONSECUTIVE_TIMEOUTS` statement timeouts in a row with no
 * chunk copied the build ends as `stalled`.
 */
export async function advanceLogbookSnapshotBuild(
  database: Database,
  {
    binding,
    snapshotId,
    timeBudgetMs = LOGBOOK_SNAPSHOT_BUILD_BUDGET_MS,
    maxTicks = LOGBOOK_SNAPSHOT_MAX_TICKS,
    maxStoredTicks = LOGBOOK_SNAPSHOT_MAX_STORED_TICKS,
  }: {
    binding: LogbookSnapshotBinding;
    snapshotId: string;
    timeBudgetMs?: number;
    maxTicks?: number;
    maxStoredTicks?: number;
  },
): Promise<LogbookSnapshotBuildProgress> {
  const deadline = Date.now() + timeBudgetMs;
  for (;;) {
    let step: Awaited<ReturnType<typeof buildNextChunk>>;
    try {
      step = await buildNextChunk(database, binding, snapshotId, { maxTicks, maxStoredTicks });
    } catch (error) {
      const code = getPostgresErrorCode(error);
      if (code === STATEMENT_TIMEOUT_ERROR_CODE) return recordChunkTimeout(database, binding, snapshotId);
      if (code === LOCK_TIMEOUT_ERROR_CODE) return { status: 'building' };
      throw error;
    }
    if (!step.copied || step.progress.status !== 'building' || Date.now() >= deadline) return step.progress;
  }
}

/**
 * Read one page of a finished snapshot.
 *
 * Generation, expiry, binding and chunks all come from one read-only
 * REPEATABLE READ snapshot, the way the feed reads a page. `expired` covers a
 * snapshot that is gone, past its hour, or owned by another connection: a
 * caller answers `410` for all three, so it cannot learn which it was.
 *
 * The last page returns the feed cursor `(H, 0)` and `hasMore: true` so the app
 * keeps going into catch-up.
 *
 * A build that ended `too_large` or `stalled` answers `expired` with that
 * reason and the seconds until its verdict lapses. `withinRead` runs for a page
 * that serves ticks, in the page's transaction.
 */
export async function readLogbookSnapshotPage(
  database: Database,
  {
    binding,
    cursor,
    limit,
    withinRead,
  }: {
    binding: LogbookSnapshotBinding;
    cursor: LogbookSnapshotCursor;
    limit: number;
    withinRead?: LogbookPageReader;
  },
): Promise<LogbookSnapshotPage> {
  if (!Number.isInteger(limit) || limit < LOGBOOK_FEED_MIN_PAGE_SIZE || limit > LOGBOOK_FEED_MAX_PAGE_SIZE) {
    throw new RangeError(`Logbook feed limit must be ${LOGBOOK_FEED_MIN_PAGE_SIZE}-${LOGBOOK_FEED_MAX_PAGE_SIZE}`);
  }
  if (!Number.isInteger(cursor.position) || cursor.position < 0) {
    throw new RangeError(`Malformed logbook snapshot position: ${cursor.position}`);
  }

  return database.transaction(
    async (transaction): Promise<LogbookSnapshotPage> => {
      await boundLogbookReadTransaction(transaction);
      const feedState = await readLogbookFeedState(transaction);
      const [snapshot] = await transaction
        .select({
          status: logbookSnapshots.status,
          feedGeneration: logbookSnapshots.feedGeneration,
          horizonTxid: logbookSnapshots.horizonTxid,
          tickCount: logbookSnapshots.tickCount,
          retryAfterSeconds: secondsUntilExpiry,
        })
        .from(logbookSnapshots)
        .where(and(eq(logbookSnapshots.id, cursor.snapshotId), snapshotBelongsTo(binding), snapshotIsLive()));

      if (!snapshot || snapshot.status === 'retired') return { status: 'expired', reason: 'snapshot_not_found' };
      if (snapshot.status === 'too_large' || snapshot.status === 'stalled') {
        return { status: 'expired', reason: snapshot.status, retryAfterSeconds: snapshot.retryAfterSeconds };
      }
      if (snapshot.feedGeneration !== feedState.generation) {
        return { status: 'expired', reason: 'generation_mismatch' };
      }
      if (positionIsBefore({ txid: snapshot.horizonTxid, seq: '0' }, feedState.prunedThrough)) {
        return { status: 'expired', reason: 'below_watermark' };
      }
      if (snapshot.status === 'building') return { status: 'building' };

      const start = Math.min(cursor.position, snapshot.tickCount);
      const end = Math.min(start + limit, snapshot.tickCount);
      const ticks = end > start ? await readTickRange(transaction, cursor.snapshotId, start, end) : [];

      const entries = ticks.map((tick): LogbookFeedEntry => ({ type: 'tick', tick }));
      await withinRead?.(transaction, ticksOf(entries));
      const next: Extract<LogbookSnapshotPage, { status: 'ok' }>['next'] =
        end < snapshot.tickCount
          ? { kind: 'snapshot', cursor: { snapshotId: cursor.snapshotId, position: end } }
          : {
              kind: 'changes',
              cursor: { generation: snapshot.feedGeneration, txid: snapshot.horizonTxid, seq: '0' },
            };

      return { status: 'ok', entries, next, hasMore: true };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

/** Ticks `[start, end)` of the stream, from the one or two chunks that hold them. */
async function readTickRange(
  transaction: FeedTransaction,
  snapshotId: string,
  start: number,
  end: number,
): Promise<LogbookFeedTick[]> {
  const firstChunk = Math.floor(start / LOGBOOK_SNAPSHOT_CHUNK_TICKS);
  const lastChunk = Math.floor((end - 1) / LOGBOOK_SNAPSHOT_CHUNK_TICKS);
  const chunks = await transaction
    .select({ chunkIndex: logbookSnapshotChunks.chunkIndex, ticks: logbookSnapshotChunks.ticks })
    .from(logbookSnapshotChunks)
    .where(
      and(
        eq(logbookSnapshotChunks.snapshotId, snapshotId),
        inArray(
          logbookSnapshotChunks.chunkIndex,
          Array.from({ length: lastChunk - firstChunk + 1 }, (_unused, offset) => firstChunk + offset),
        ),
      ),
    )
    .orderBy(asc(logbookSnapshotChunks.chunkIndex));

  const offsetIntoFirstChunk = start - firstChunk * LOGBOOK_SNAPSHOT_CHUNK_TICKS;
  return chunks.flatMap((chunk) => chunk.ticks).slice(offsetIntoFirstChunk, offsetIntoFirstChunk + (end - start));
}

/**
 * Remove expired snapshots. One transaction claims up to
 * `LOGBOOK_SNAPSHOT_RECLAIM_SNAPSHOTS_PER_BATCH` of them and deletes up to
 * `LOGBOOK_SNAPSHOT_RECLAIM_CHUNKS_PER_BATCH` chunks between them, and a run stops
 * after `maxBatches` transactions, so a run stays bounded however much has piled
 * up. Safe to retry and safe to run twice at once: each batch skips rows another
 * batch holds, and a row being copied by a build step is locked, so its build
 * keeps going and the next run takes it.
 *
 * Expiry is enforced when a snapshot is read, so this only reclaims storage;
 * running it late changes nothing a client can see.
 */
export async function reclaimExpiredLogbookSnapshots(
  runBatch: <Result>(callback: (transaction: BackgroundJobTransaction) => Promise<Result>) => Promise<Result>,
  {
    maxBatches = LOGBOOK_SNAPSHOT_RECLAIM_MAX_BATCHES,
    snapshotsPerBatch = LOGBOOK_SNAPSHOT_RECLAIM_SNAPSHOTS_PER_BATCH,
    chunksPerBatch = LOGBOOK_SNAPSHOT_RECLAIM_CHUNKS_PER_BATCH,
    signal,
  }: { maxBatches?: number; snapshotsPerBatch?: number; chunksPerBatch?: number; signal?: AbortSignal } = {},
): Promise<LogbookSnapshotReclaimResult> {
  let snapshotsRemoved = 0;
  let chunksRemoved = 0;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    signal?.throwIfAborted();
    const removed = await runBatch(async (transaction) => {
      const expired = await transaction
        .select({ id: logbookSnapshots.id })
        .from(logbookSnapshots)
        .where(lte(logbookSnapshots.expiresAt, sql`now()`))
        .orderBy(asc(logbookSnapshots.expiresAt))
        .limit(snapshotsPerBatch)
        .for('update', { skipLocked: true });
      if (expired.length === 0) return null;
      const expiredIds = expired.map((snapshot) => snapshot.id);

      const chunksToDelete = transaction
        .select({ snapshotId: logbookSnapshotChunks.snapshotId, chunkIndex: logbookSnapshotChunks.chunkIndex })
        .from(logbookSnapshotChunks)
        .where(inArray(logbookSnapshotChunks.snapshotId, expiredIds))
        .orderBy(asc(logbookSnapshotChunks.snapshotId), asc(logbookSnapshotChunks.chunkIndex))
        .limit(chunksPerBatch);
      const deletedChunks = await transaction
        .delete(logbookSnapshotChunks)
        .where(inArray(sql`(${logbookSnapshotChunks.snapshotId}, ${logbookSnapshotChunks.chunkIndex})`, chunksToDelete))
        .returning({ snapshotId: logbookSnapshotChunks.snapshotId });

      // A header goes only when none of its chunks are left, so a large
      // snapshot spans batches and an interrupted run loses nothing.
      const stillHolding = await transaction
        .selectDistinct({ snapshotId: logbookSnapshotChunks.snapshotId })
        .from(logbookSnapshotChunks)
        .where(inArray(logbookSnapshotChunks.snapshotId, expiredIds));
      const unfinished = new Set(stillHolding.map((row) => row.snapshotId));
      const finishedIds = expiredIds.filter((id) => !unfinished.has(id));
      if (finishedIds.length > 0) {
        await transaction.delete(logbookSnapshots).where(inArray(logbookSnapshots.id, finishedIds));
      }
      return { chunks: deletedChunks.length, snapshots: finishedIds.length };
    });

    if (!removed) return { snapshotsRemoved, chunksRemoved, capped: false };
    chunksRemoved += removed.chunks;
    snapshotsRemoved += removed.snapshots;
  }

  return { snapshotsRemoved, chunksRemoved, capped: true };
}
