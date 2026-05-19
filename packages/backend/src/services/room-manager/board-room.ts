/**
 * BoardRoom — per-physical-board append-only log of climbs sent to the wall.
 *
 * Keyed by BLE serial (board_serial). Lives alongside, not inside, the
 * existing session-keyed QueueRoom. Sequence numbers are allocated per
 * board_serial via the `board_history_sequences` fence table so concurrent
 * writers across multiple backend instances can't collide.
 *
 * Redis caches the hot tail (`board:<serial>:events`, capped at N=200) and
 * the last sequence (`board:<serial>:seq`); Postgres is the source of
 * truth for the full log.
 */

import { and, desc, eq, lt, sql } from 'drizzle-orm';
import {
  boardClimbHistory,
  userBoardSerials,
  type BoardClimbHistory,
  type NewBoardClimbHistory,
} from '@boardsesh/db/schema/app';
import { users } from '@boardsesh/db/schema/auth';
import { executeRows } from '@boardsesh/db/client';
import { db } from '../../db/client';
import { redisClientManager } from '../../redis/client';
import { logger } from '../../utils/logger';

/** Max entries kept in the per-serial Redis events buffer. */
const REDIS_EVENTS_CAP = 200;
/** TTL for the Redis hot-state keys (24h sliding). */
const REDIS_TTL_SECONDS = 60 * 60 * 24;

function eventsKey(serial: string): string {
  return `board:${serial}:events`;
}

function seqKey(serial: string): string {
  return `board:${serial}:seq`;
}

function metaKey(serial: string): string {
  return `board:${serial}:meta`;
}

/**
 * Compact "events buffer" entry — what we push to Redis so late subscribers
 * can hydrate without hitting PG. Field shape mirrors a serialized
 * BoardClimbHistory row.
 */
type RedisEventEntry = {
  id: string;
  uuid: string;
  boardSerial: string;
  boardId: number | null;
  userId: string;
  climbUuid: string;
  angle: number;
  isMirror: boolean;
  source: BoardClimbHistory['source'];
  sessionId: string | null;
  sequence: string;
  sentAt: string;
};

function serializeForRedis(row: BoardClimbHistory): RedisEventEntry {
  return {
    id: row.id.toString(),
    uuid: row.uuid,
    boardSerial: row.boardSerial,
    boardId: row.boardId,
    userId: row.userId,
    climbUuid: row.climbUuid,
    angle: row.angle,
    isMirror: row.isMirror,
    source: row.source,
    sessionId: row.sessionId,
    sequence: row.sequence.toString(),
    sentAt: row.sentAt.toISOString(),
  };
}

/**
 * Result of an append. `inserted` is false when the uuid was already
 * recorded (idempotent retry) — in that case `persisted` is the original
 * row and callers should NOT publish a new pubsub event.
 */
export type AppendResult = {
  inserted: boolean;
  persisted: BoardClimbHistory;
};

/**
 * Resolve a `boardId` for a given `boardSerial` by looking at the most
 * recently updated `userBoardSerials` row pointing at a saved board. Returns
 * null when the serial has never been linked to a userBoards row.
 *
 * We look up by the linked board's UUID, not the row's own user_id — any
 * paired user's link is good enough to populate the FK. (Multiple users may
 * have rows for the same serial; we accept the freshest link.)
 */
async function resolveBoardIdFromSerial(serial: string): Promise<number | null> {
  const rows = await db
    .select({
      boardUuid: userBoardSerials.boardUuid,
      updatedAt: userBoardSerials.updatedAt,
    })
    .from(userBoardSerials)
    .where(eq(userBoardSerials.serialNumber, serial))
    .orderBy(desc(userBoardSerials.updatedAt))
    .limit(1);

  const link = rows[0];
  if (!link?.boardUuid) return null;

  // Look up numeric board_id from the boards uuid (the FK target on
  // boardClimbHistory.boardId is the numeric `userBoards.id`).
  const boardRows = await executeRows<{ id: number | string }>(
    db,
    sql`SELECT id FROM user_boards WHERE uuid = ${link.boardUuid} AND deleted_at IS NULL LIMIT 1`,
  );
  const first = boardRows[0];
  if (!first) return null;
  return Number(first.id);
}

/**
 * Look up the canonical display name for a user. Returns null when the
 * user has no `name` set (unauthenticated edge cases are not relevant here
 * — `recordBoardSend` requires auth).
 */
export async function lookupUsername(userId: string): Promise<string | null> {
  const rows = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
  return rows[0]?.name ?? null;
}

/**
 * Append a new board history entry. Idempotent on `entry.uuid`.
 *
 * Flow:
 * 1. Check for an existing row with the same uuid. If found, short-circuit
 *    — return it without allocating a new sequence or publishing.
 * 2. If `boardId` is not provided on the input, resolve it from
 *    `userBoardSerials`. Best-effort; left null when unresolved.
 * 3. Inside a transaction: upsert into `board_history_sequences` and
 *    INSERT the row with `ON CONFLICT (uuid) DO NOTHING`. If the conflict
 *    fires here (another writer raced us), re-fetch the persisted row and
 *    skip the publish.
 * 4. Update Redis hot state (lpush events, set seq, expire) fire-and-forget.
 */
export async function appendBoardHistoryEntry(
  serial: string,
  entry: Omit<NewBoardClimbHistory, 'sequence' | 'boardSerial'>,
): Promise<AppendResult> {
  // Cheap dedup short-circuit. Avoids burning a sequence number on retries.
  const existing = await db.select().from(boardClimbHistory).where(eq(boardClimbHistory.uuid, entry.uuid)).limit(1);
  if (existing[0]) {
    return { inserted: false, persisted: existing[0] };
  }

  // Resolve board_id from the serial when not provided by the caller. Best
  // effort — visitor / unregistered boards leave this null forever.
  let boardId = entry.boardId ?? null;
  if (boardId == null) {
    boardId = await resolveBoardIdFromSerial(serial);
  }

  const persisted = await db.transaction(async (tx) => {
    // Allocate sequence inside the transaction so concurrent writers across
    // instances can't get the same number. The per-serial PK guarantees
    // serial allocation; ON CONFLICT bumps the counter atomically.
    const seqResult = await executeRows<{ last_sequence: string | number | bigint }>(
      tx,
      sql`
        INSERT INTO board_history_sequences (board_serial, last_sequence)
        VALUES (${serial}, 1)
        ON CONFLICT (board_serial)
        DO UPDATE SET last_sequence = board_history_sequences.last_sequence + 1
        RETURNING last_sequence
      `,
    );
    const last = seqResult[0]?.last_sequence;
    if (last == null) {
      throw new Error(`[BoardRoom] Failed to allocate sequence for serial ${serial}`);
    }
    const sequence = BigInt(last as string | number | bigint);

    const inserted = await tx
      .insert(boardClimbHistory)
      .values({
        ...entry,
        boardSerial: serial,
        boardId,
        sequence,
      })
      .onConflictDoNothing({ target: boardClimbHistory.uuid })
      .returning();

    if (inserted[0]) {
      return { row: inserted[0], wasFresh: true };
    }

    // Lost the race — another writer beat us between our pre-check and the
    // insert. Re-fetch the canonical row by uuid. Note: we've allocated a
    // sequence that won't be used; the gap is harmless because consumers
    // never assume contiguous sequence numbers.
    const after = await tx.select().from(boardClimbHistory).where(eq(boardClimbHistory.uuid, entry.uuid)).limit(1);
    if (!after[0]) {
      throw new Error(`[BoardRoom] Insert was a no-op but no row found for uuid ${entry.uuid}`);
    }
    return { row: after[0], wasFresh: false };
  });

  if (persisted.wasFresh) {
    // Fire-and-forget Redis hot-state update. Non-fatal on failure — the next
    // subscriber will fall back to PG via getRecentHistoryForSync.
    updateRedisHotState(serial, persisted.row).catch((err: unknown) => {
      logger.error(`[BoardRoom] Failed to update Redis hot state for serial ${serial}:`, err);
    });
  }

  return { inserted: persisted.wasFresh, persisted: persisted.row };
}

async function updateRedisHotState(serial: string, row: BoardClimbHistory): Promise<void> {
  if (!redisClientManager.isRedisConnected()) return;
  const { publisher } = redisClientManager.getClients();
  const entry = serializeForRedis(row);
  const pipeline = publisher.multi();
  pipeline.lpush(eventsKey(serial), JSON.stringify(entry));
  pipeline.ltrim(eventsKey(serial), 0, REDIS_EVENTS_CAP - 1);
  pipeline.set(seqKey(serial), row.sequence.toString());
  pipeline.set(metaKey(serial), Date.now().toString());
  pipeline.expire(eventsKey(serial), REDIS_TTL_SECONDS);
  pipeline.expire(seqKey(serial), REDIS_TTL_SECONDS);
  pipeline.expire(metaKey(serial), REDIS_TTL_SECONDS);
  await pipeline.exec();
}

/**
 * Page through board history in reverse chronological order. `before` is an
 * exclusive cursor on `sent_at`.
 */
export async function getBoardHistory(
  serial: string,
  opts: { limit?: number; before?: Date } = {},
): Promise<BoardClimbHistory[]> {
  const limit = Math.min(opts.limit ?? 50, 200);

  const conditions = opts.before
    ? and(eq(boardClimbHistory.boardSerial, serial), lt(boardClimbHistory.sentAt, opts.before))
    : eq(boardClimbHistory.boardSerial, serial);

  return db.select().from(boardClimbHistory).where(conditions).orderBy(desc(boardClimbHistory.sentAt)).limit(limit);
}

/**
 * Result of {@link getRecentHistoryForSync}. `sequence` is the highest
 * sequence reflected in `entries`, or 0 when there's no history yet. The
 * subscription uses it to filter incremental events that arrived during the
 * sync window.
 */
export type RecentHistorySync = {
  sequence: bigint;
  entries: BoardClimbHistory[];
};

/**
 * Used by the subscription's eager-subscribe-then-sync pattern. Reads from
 * the Redis hot-buffer first; falls back to PG when Redis is empty / cold.
 *
 * Entries are returned newest-first so they slot directly into the UI list
 * without re-sorting client-side.
 */
export async function getRecentHistoryForSync(serial: string, limit = 50): Promise<RecentHistorySync> {
  const capped = Math.min(limit, 200);

  if (redisClientManager.isRedisConnected()) {
    try {
      const { publisher } = redisClientManager.getClients();
      const raw = await publisher.lrange(eventsKey(serial), 0, capped - 1);
      if (raw.length > 0) {
        const parsed: BoardClimbHistory[] = [];
        for (const json of raw) {
          try {
            const obj = JSON.parse(json) as RedisEventEntry;
            parsed.push({
              id: BigInt(obj.id),
              uuid: obj.uuid,
              boardSerial: obj.boardSerial,
              boardId: obj.boardId,
              userId: obj.userId,
              climbUuid: obj.climbUuid,
              // Fields not carried by the hot-buffer get safe defaults — the
              // UI only renders the columns surfaced via GraphQL anyway, and
              // missing extras (boardType, layoutId, frames, tickId,
              // sharedPlaylistMode, createdAt) are not part of
              // BoardHistoryEntry.
              boardType: '',
              layoutId: 0,
              angle: obj.angle,
              isMirror: obj.isMirror,
              frames: null,
              source: obj.source,
              sessionId: obj.sessionId,
              sharedPlaylistMode: false,
              tickId: null,
              sequence: BigInt(obj.sequence),
              sentAt: new Date(obj.sentAt),
              createdAt: new Date(obj.sentAt),
            });
          } catch (err) {
            logger.error(`[BoardRoom] Failed to parse Redis buffered entry for serial ${serial}:`, err);
          }
        }
        if (parsed.length > 0) {
          // List is newest-first (lpush). Highest sequence is the head.
          return { sequence: parsed[0].sequence, entries: parsed };
        }
      }
    } catch (err) {
      logger.error(`[BoardRoom] Redis read failed for serial ${serial}, falling back to PG:`, err);
    }
  }

  const rows = await db
    .select()
    .from(boardClimbHistory)
    .where(eq(boardClimbHistory.boardSerial, serial))
    .orderBy(desc(boardClimbHistory.sequence))
    .limit(capped);

  const sequence = rows[0]?.sequence ?? 0n;
  return { sequence, entries: rows };
}

/**
 * Soft pairing gate — does the user have any `userBoardSerials` row for the
 * given serial? Used by the subscription resolver to reject casual squatting
 * on random serials. Pairing is established the first time a user connects
 * via BLE to a controller.
 */
export async function isPairedToBoard(userId: string, serial: string): Promise<boolean> {
  const rows = await db
    .select({ id: userBoardSerials.id })
    .from(userBoardSerials)
    .where(and(eq(userBoardSerials.userId, userId), eq(userBoardSerials.serialNumber, serial)))
    .limit(1);
  return rows.length > 0;
}
