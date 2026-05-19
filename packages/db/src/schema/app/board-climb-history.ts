import {
  pgTable,
  pgEnum,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  bigserial,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from '../auth/users';
import { userBoards } from './boards';
import { boardSessions } from './sessions';
import { boardseshTicks } from './ascents';

/**
 * Source of a board history entry. The MVP only emits `ble_send`. The other
 * variants are reserved for future surfaces (manual log entries, relays of a
 * shared-playlist current-climb change when no BLE user is paired).
 */
export const boardHistorySourceEnum = pgEnum('board_history_source', ['ble_send', 'manual', 'shared_queue_relay']);

/**
 * Canonical, chronological log of climbs that have appeared on a physical board.
 *
 * Keyed by `board_serial` so the log exists even before the user registers a
 * `userBoards` row. When a `userBoards` row is known at write time, `board_id`
 * is populated for ergonomic per-saved-board queries; it can be null indefinitely
 * for unregistered/visitor boards.
 *
 * Append-only. Sequence numbers are allocated per board_serial via the
 * `board_history_sequences` fence table so concurrent writers across multiple
 * backend instances can't collide.
 */
export const boardClimbHistory = pgTable(
  'board_climb_history',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey().notNull(),
    // Client-generated idempotency key (same convention as boardsesh_ticks.uuid).
    // Servers do `ON CONFLICT (uuid) DO NOTHING`; clients are expected to reuse
    // the same uuid on retry of the same logical send.
    uuid: text('uuid').notNull().unique(),

    // Canonical room/log key. Always present — derived from the BLE serial of
    // the controller the climb was sent to.
    boardSerial: text('board_serial').notNull(),

    // Best-effort linkage to a saved board entity. Null when the user hadn't
    // registered the board at send time. Survives userBoards deletion via SET NULL.
    boardId: bigint('board_id', { mode: 'number' }).references(() => userBoards.id, { onDelete: 'set null' }),

    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    climbUuid: text('climb_uuid').notNull(),
    boardType: text('board_type').notNull(), // 'kilter' | 'tension'
    layoutId: bigint('layout_id', { mode: 'number' }).notNull(),
    angle: integer('angle').notNull(),
    isMirror: boolean('is_mirror').default(false).notNull(),

    // Optional: the actual frames string sent to the board. Lets future
    // "replay the wall at time T" views render without re-querying climbs.
    frames: text('frames'),

    source: boardHistorySourceEnum('source').notNull(),

    // Context: was the user inside a party session at send time, and was the
    // shared-playlist mode active. The board history is the canonical "what was
    // on the wall" log regardless of mode; these columns are for attribution.
    sessionId: text('session_id').references(() => boardSessions.id, { onDelete: 'set null' }),
    sharedPlaylistMode: boolean('shared_playlist_mode').default(false).notNull(),

    // Optional back-link to the tick the user later logged for this send. Set
    // by the ticks resolver when a matching board_climb_history row exists.
    tickId: bigint('tick_id', { mode: 'bigint' }).references(() => boardseshTicks.id, { onDelete: 'set null' }),

    // Monotonic per board_serial; allocated by board_history_sequences upsert.
    sequence: bigint('sequence', { mode: 'bigint' }).notNull(),

    sentAt: timestamp('sent_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // Primary read pattern: latest entries for a board, reverse-chronological.
    boardSerialSentAtIdx: index('board_climb_history_serial_sent_at_idx').on(
      table.boardSerial,
      sql`${table.sentAt} desc`,
    ),
    // Append-log replay for late subscribers (Redis miss → PG fallback).
    boardSerialSequenceIdx: index('board_climb_history_serial_sequence_idx').on(
      table.boardSerial,
      sql`${table.sequence} desc`,
    ),
    // Guarantees monotonic ordering per board_serial.
    boardSerialSequenceUnique: uniqueIndex('board_climb_history_serial_sequence_unique').on(
      table.boardSerial,
      table.sequence,
    ),
    // Per-saved-board logbook view (only meaningful for registered boards).
    boardIdSentAtIdx: index('board_climb_history_board_sent_at_idx')
      .on(table.boardId, sql`${table.sentAt} desc`)
      .where(sql`${table.boardId} IS NOT NULL`),
    // Cross-board "where has this climb gone up lately".
    climbUuidSentAtIdx: index('board_climb_history_climb_sent_at_idx').on(table.climbUuid, sql`${table.sentAt} desc`),
    // User's own send history.
    userIdSentAtIdx: index('board_climb_history_user_sent_at_idx').on(table.userId, sql`${table.sentAt} desc`),
  }),
);

/**
 * Single-writer fence per board. Sequence allocation happens inside the same
 * transaction as the board_climb_history insert via:
 *   INSERT INTO board_history_sequences (board_serial, last_sequence)
 *   VALUES ($1, 1)
 *   ON CONFLICT (board_serial)
 *   DO UPDATE SET last_sequence = board_history_sequences.last_sequence + 1
 *   RETURNING last_sequence
 *
 * Redis caches the counter for read paths but PG is the source of truth.
 */
export const boardHistorySequences = pgTable('board_history_sequences', {
  boardSerial: text('board_serial').primaryKey(),
  // No default — the allocator always provides a value via INSERT ... ON
  // CONFLICT DO UPDATE. Drizzle-kit can't serialize a BigInt default cleanly,
  // so we keep this column writer-driven.
  lastSequence: bigint('last_sequence', { mode: 'bigint' }).notNull(),
});

export type BoardClimbHistory = typeof boardClimbHistory.$inferSelect;
export type NewBoardClimbHistory = typeof boardClimbHistory.$inferInsert;
export type BoardHistorySequence = typeof boardHistorySequences.$inferSelect;
export type NewBoardHistorySequence = typeof boardHistorySequences.$inferInsert;
