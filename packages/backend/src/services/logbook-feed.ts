import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { notAuroraTwinDuplicate } from '@boardsesh/db/queries';
import {
  LOGBOOK_CHANGE_WATERMARK_SINGLETON_ID,
  boardClimbAliases,
  boardseshTicks,
  logbookChangeWatermark,
  logbookChanges,
} from '@boardsesh/db/schema';
import type { Database } from '../db/client';

/**
 * Reads the logbook change feed: the proof and the protocol are in
 * docs/integration-platform.md, "Incremental sync". `GET /v1/logbook/changes`
 * (handlers/public-api/logbook.ts) and the snapshot bootstrap build on it.
 *
 * Every step of one page runs in a single read-only REPEATABLE READ
 * transaction, so the horizon, the feed generation, the watermark and the rows
 * all come from the same snapshot. The transaction is bounded like the partner
 * OAuth ones (5 s per statement, 2 s per lock wait, 10 s idle), so a slow page
 * cannot hold a pool connection; a caller answers 57014 and 55P03 as an empty
 * page at the same cursor.
 */

/** A point in the change stream. Decimal strings: `xid8` overflows a JS number. */
export type LogbookFeedPosition = { txid: string; seq: string };

export type LogbookFeedCursor = LogbookFeedPosition & { generation: string };

/** The columns of a tick the public serializer reads, plus its canonical climb. */
export type LogbookFeedTick = {
  uuid: string;
  boardType: string;
  climbUuid: string;
  /** `COALESCE(alias.canonical_uuid, climb_uuid)`, resolved at read time. */
  canonicalClimbUuid: string;
  angle: number;
  isMirror: boolean | null;
  status: string;
  attemptCount: number;
  quality: number | null;
  difficulty: number | null;
  isBenchmark: boolean | null;
  comment: string | null;
  climbedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type LogbookFeedEntry = { type: 'tick'; tick: LogbookFeedTick } | { type: 'tick.deleted'; id: string };

export type LogbookFeedExpiredReason = 'generation_mismatch' | 'below_watermark';

export type LogbookFeedPage =
  | {
      status: 'ok';
      generation: string;
      /** The transaction horizon this page was read at. */
      horizon: string;
      entries: LogbookFeedEntry[];
      /** Save this and pass it back with `generation` to read the next page. */
      next: LogbookFeedPosition;
      hasMore: boolean;
    }
  | { status: 'expired'; reason: LogbookFeedExpiredReason };

export const LOGBOOK_FEED_MIN_PAGE_SIZE = 1;
export const LOGBOOK_FEED_MAX_PAGE_SIZE = 200;

/** The start of the change stream. Valid until retention prunes past it. */
export const LOGBOOK_FEED_ORIGIN: LogbookFeedPosition = { txid: '0', seq: '0' };

export type LogbookFeedState = {
  generation: string;
  horizon: string;
  prunedThrough: LogbookFeedPosition;
};

export type FeedTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Runs inside a page's read transaction, after the rows are read and before it
 * ends, with the ticks the page serves (in order). The API uses it to check the
 * connection again and to read the climbs' public metadata under the privacy
 * rules as they stand at delivery, in the same snapshot as the ticks. Throwing
 * from it fails the page.
 */
export type LogbookPageReader = (transaction: FeedTransaction, ticks: LogbookFeedTick[]) => Promise<void>;

const STATEMENT_TIMEOUT = '5000ms';
const LOCK_TIMEOUT = '2000ms';
const IDLE_IN_TRANSACTION_TIMEOUT = '10s';

/**
 * Scoped to the caller's transaction. In REPEATABLE READ this statement takes
 * the transaction snapshot, which every later statement shares, so the horizon
 * argument is unchanged.
 */
export async function boundLogbookReadTransaction(transaction: FeedTransaction): Promise<void> {
  await transaction.execute(
    sql`SELECT set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true), set_config('lock_timeout', ${LOCK_TIMEOUT}, true), set_config('idle_in_transaction_session_timeout', ${IDLE_IN_TRANSACTION_TIMEOUT}, true)`,
  );
}

const ROW_COUNT_DIGITS = /^\d+$/;

function comparablePosition(position: LogbookFeedPosition): readonly [bigint, bigint] {
  if (!ROW_COUNT_DIGITS.test(position.txid) || !ROW_COUNT_DIGITS.test(position.seq)) {
    throw new RangeError(`Malformed logbook feed position: ${position.txid},${position.seq}`);
  }
  return [BigInt(position.txid), BigInt(position.seq)];
}

export function positionIsBefore(left: LogbookFeedPosition, right: LogbookFeedPosition): boolean {
  const [leftTxid, leftSeq] = comparablePosition(left);
  const [rightTxid, rightSeq] = comparablePosition(right);
  return leftTxid < rightTxid || (leftTxid === rightTxid && leftSeq < rightSeq);
}

/**
 * The horizon and feed state, read in the caller's REPEATABLE READ snapshot.
 *
 * The horizon is the oldest transaction still running when the snapshot was
 * taken (or the next unassigned id if none are). Every transaction below it has
 * finished, so committed rows below it cannot grow after this snapshot: that is
 * what lets the feed advance past them. Exported for the snapshot bootstrap,
 * which starts its change cursor at `(horizon, 0)`.
 */
export async function readLogbookFeedState(transaction: FeedTransaction): Promise<LogbookFeedState> {
  const [state] = await transaction
    .select({
      generation: logbookChangeWatermark.feedGeneration,
      prunedThroughTxid: sql<string>`${logbookChangeWatermark.prunedThroughTxid}::text`,
      prunedThroughSeq: sql<string>`${logbookChangeWatermark.prunedThroughSeq}::text`,
      horizon: sql<string>`pg_snapshot_xmin(pg_current_snapshot())::text`,
    })
    .from(logbookChangeWatermark)
    .where(eq(logbookChangeWatermark.id, LOGBOOK_CHANGE_WATERMARK_SINGLETON_ID));
  if (!state) {
    throw new Error('logbook_change_watermark has no row: the logbook trigger migration has not run');
  }
  return {
    generation: state.generation,
    horizon: state.horizon,
    prunedThrough: { txid: state.prunedThroughTxid, seq: state.prunedThroughSeq },
  };
}

/**
 * The serializer's columns plus the canonical climb. The feed and the snapshot
 * both read exactly this, so a tick means the same thing in both.
 */
export const logbookFeedTickColumns = {
  uuid: boardseshTicks.uuid,
  boardType: boardseshTicks.boardType,
  climbUuid: boardseshTicks.climbUuid,
  canonicalClimbUuid: sql<string>`COALESCE(${boardClimbAliases.canonicalUuid}, ${boardseshTicks.climbUuid})`,
  angle: boardseshTicks.angle,
  isMirror: boardseshTicks.isMirror,
  status: boardseshTicks.status,
  attemptCount: boardseshTicks.attemptCount,
  quality: boardseshTicks.quality,
  difficulty: boardseshTicks.difficulty,
  isBenchmark: boardseshTicks.isBenchmark,
  comment: boardseshTicks.comment,
  climbedAt: boardseshTicks.climbedAt,
  createdAt: boardseshTicks.createdAt,
  updatedAt: boardseshTicks.updatedAt,
};

/** The alias join every visible-tick read uses: `climb.id` follows catalog merges. */
export const logbookFeedAliasJoin = and(
  eq(boardClimbAliases.boardType, boardseshTicks.boardType),
  eq(boardClimbAliases.aliasUuid, boardseshTicks.climbUuid),
) as SQL;

/** This climber's ticks an app can see: their own, minus Aurora twin copies. */
export function logbookVisibleTicksFilter(userId: string): SQL {
  return and(eq(boardseshTicks.userId, userId), notAuroraTwinDuplicate(boardseshTicks)) as SQL;
}

/** Current rows for the page's ticks, through the same twin rule as the logbook. */
async function loadVisibleTicks(
  transaction: FeedTransaction,
  userId: string,
  tickUuids: string[],
): Promise<Map<string, LogbookFeedTick>> {
  if (tickUuids.length === 0) return new Map();

  const rows = await transaction
    .select(logbookFeedTickColumns)
    .from(boardseshTicks)
    .leftJoin(boardClimbAliases, logbookFeedAliasJoin)
    .where(and(logbookVisibleTicksFilter(userId), inArray(boardseshTicks.uuid, tickUuids)));

  return new Map(rows.map((row) => [row.uuid, row]));
}

/**
 * Read one page of a climber's change feed starting after `cursor`.
 *
 * The cursor is validated against the feed generation and the retention
 * watermark in the same snapshot as the rows. A cursor from another generation
 * or below the watermark is expired: the caller answers `410` and bootstraps.
 *
 * Rows are served in `(txid, seq)` order and only below the horizon, so the
 * returned position can only pass rows that can no longer gain a neighbour.
 * Repeats of one tick in the page collapse to its last position; each entry is
 * the tick as it is now, or `tick.deleted` when it is gone, hidden as a twin or
 * no longer this climber's.
 */
export async function readLogbookFeedPage(
  database: Database,
  {
    userId,
    cursor,
    limit,
    withinRead,
  }: { userId: string; cursor: LogbookFeedCursor; limit: number; withinRead?: LogbookPageReader },
): Promise<LogbookFeedPage> {
  if (!Number.isInteger(limit) || limit < LOGBOOK_FEED_MIN_PAGE_SIZE || limit > LOGBOOK_FEED_MAX_PAGE_SIZE) {
    throw new RangeError(`Logbook feed limit must be ${LOGBOOK_FEED_MIN_PAGE_SIZE}-${LOGBOOK_FEED_MAX_PAGE_SIZE}`);
  }
  comparablePosition(cursor);

  return database.transaction(
    async (transaction): Promise<LogbookFeedPage> => {
      await boundLogbookReadTransaction(transaction);
      const state = await readLogbookFeedState(transaction);

      if (cursor.generation !== state.generation) {
        return { status: 'expired', reason: 'generation_mismatch' };
      }
      if (positionIsBefore(cursor, state.prunedThrough)) {
        return { status: 'expired', reason: 'below_watermark' };
      }

      const changes = await transaction
        .select({
          txid: sql<string>`${logbookChanges.txid}::text`,
          seq: sql<string>`${logbookChanges.seq}::text`,
          tickUuid: logbookChanges.tickUuid,
        })
        .from(logbookChanges)
        .where(
          and(
            eq(logbookChanges.userId, userId),
            sql`(${logbookChanges.txid}, ${logbookChanges.seq}) > (${cursor.txid}::xid8, ${cursor.seq}::bigint)`,
            sql`${logbookChanges.txid} < ${state.horizon}::xid8`,
          ),
        )
        .orderBy(asc(logbookChanges.txid), asc(logbookChanges.seq))
        .limit(limit);

      // Delete-then-add keeps each uuid at its last position in iteration order.
      const tickUuidsByLastPosition = new Set<string>();
      for (const change of changes) {
        tickUuidsByLastPosition.delete(change.tickUuid);
        tickUuidsByLastPosition.add(change.tickUuid);
      }
      const orderedTickUuids = [...tickUuidsByLastPosition];
      const visibleTicks = await loadVisibleTicks(transaction, userId, orderedTickUuids);

      const entries = orderedTickUuids.map((tickUuid): LogbookFeedEntry => {
        const tick = visibleTicks.get(tickUuid);
        return tick ? { type: 'tick', tick } : { type: 'tick.deleted', id: tickUuid };
      });
      await withinRead?.(transaction, ticksOf(entries));

      const hasMore = changes.length === limit;
      // A full page resumes after its last row. A short one has read everything
      // below the horizon for this climber, so the next read can start there.
      const lastChange = changes[changes.length - 1];
      const next: LogbookFeedPosition = hasMore
        ? { txid: lastChange.txid, seq: lastChange.seq }
        : { txid: state.horizon, seq: '0' };

      return { status: 'ok', generation: state.generation, horizon: state.horizon, entries, next, hasMore };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

/** The ticks a page serves, in entry order. */
export function ticksOf(entries: readonly LogbookFeedEntry[]): LogbookFeedTick[] {
  return entries.flatMap((entry) => (entry.type === 'tick' ? [entry.tick] : []));
}

/**
 * One of a climber's visible ticks by its uuid, through the same twin rule and
 * columns as the feed, or null when it is gone, hidden as a twin, or another
 * climber's: the API answers `404` for all three, so a caller cannot tell them
 * apart. Bounded and read-only like a feed page, with the same `withinRead`.
 */
export async function readLogbookTick(
  database: Database,
  { userId, tickUuid, withinRead }: { userId: string; tickUuid: string; withinRead?: LogbookPageReader },
): Promise<LogbookFeedTick | null> {
  return database.transaction(
    async (transaction): Promise<LogbookFeedTick | null> => {
      await boundLogbookReadTransaction(transaction);
      const tick = (await loadVisibleTicks(transaction, userId, [tickUuid])).get(tickUuid) ?? null;
      await withinRead?.(transaction, tick ? [tick] : []);
      return tick;
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
