import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  bigserial,
  index,
  uniqueIndex,
  pgEnum,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from '../auth/users';
import { boardSessions } from './sessions';
import { userBoards } from './boards';

/**
 * Tick status enum
 * - flash: Completed on first attempt
 * - send: Completed after multiple attempts
 * - attempt: Did not complete (logged failed attempts)
 */
export const tickStatusEnum = pgEnum('tick_status', ['flash', 'send', 'attempt']);

/**
 * Provenance of a boardsesh_ticks row — WHERE the tick came from.
 * - native: created inside Boardsesh (saveTick). Counts toward the
 *   boardsesh_ascensionist_count. A native tick that later has kilter_id
 *   stamped by push-back keeps origin='native' and keeps counting.
 * - aurora_pull: pulled down from the user's Aurora logbook (Kilter/Tension
 *   API sync ascents/bids). Already inside upstream_ascensionist_count.
 * - kilter_pull: pulled down from the user's Kilter PowerSync logs.
 *   Already inside upstream_ascensionist_count.
 * - json_import: imported from an Aurora account export JSON. Already inside
 *   upstream_ascensionist_count.
 * - moonboard_import: imported from a MoonBoard account export CSV. Already
 *   inside upstream_ascensionist_count.
 *
 * The tick recompute counts a user toward boardsesh_ascensionist_count only
 * when ALL their ticks at a (board, climb, angle) key are 'native' — a user
 * with any imported tick is already represented in the upstream count, so
 * counting them again would double-count the ascent.
 */
export const tickOriginEnum = pgEnum('tick_origin', [
  'native',
  'aurora_pull',
  'kilter_pull',
  'json_import',
  'moonboard_import',
]);

/**
 * Aurora table type for sync
 * - ascents: Successful climbs (flash/send) sync to Aurora ascents table
 * - bids: Failed attempts sync to Aurora bids table
 */
export const auroraTableTypeEnum = pgEnum('aurora_table_type', ['ascents', 'bids']);

/**
 * Kilter table type for sync
 * - logs: Completed climbs (flash/send) sync to Kilter logs table
 * - attempts: Failed attempts sync to Kilter attempts table
 */
export const kilterTableTypeEnum = pgEnum('kilter_table_type', ['logs', 'attempts']);

/**
 * Boardsesh ticks table
 * Unified table for all climb attempts (successful and failed)
 * Links to NextAuth users, not Aurora board users
 */
export const boardseshTicks = pgTable(
  'boardsesh_ticks',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    uuid: text('uuid').notNull().unique(), // Our own UUID
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    boardType: text('board_type').notNull(), // 'kilter' or 'tension'
    climbUuid: text('climb_uuid').notNull(),
    angle: integer('angle').notNull(),
    isMirror: boolean('is_mirror').default(false),

    // Provenance — WHERE this tick came from. Defaults to 'native' (saveTick).
    // Every sync/import writer stamps its own value. Drives the ascensionist
    // double-count guard in recomputeClimbStats (see tickOriginEnum docs).
    origin: tickOriginEnum('origin').notNull().default('native'),

    // Tick details
    status: tickStatusEnum('status').notNull(), // flash, send, or attempt
    attemptCount: integer('attempt_count').notNull().default(1), // Always 1 for flash
    quality: integer('quality'), // 1-5 star rating (null for attempts)
    difficulty: integer('difficulty'), // Difficulty grade ID (null for attempts)
    isBenchmark: boolean('is_benchmark').default(false),
    comment: text('comment').default(''),

    // Timestamps
    climbedAt: timestamp('climbed_at', { mode: 'string' }).notNull(),
    createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow().notNull(),

    // Optional link to group session (if tick was during party mode)
    sessionId: text('session_id').references(() => boardSessions.id, { onDelete: 'set null' }),

    // Optional link to the board entity this tick was recorded on
    boardId: bigint('board_id', { mode: 'number' }).references(() => userBoards.id, {
      onDelete: 'set null',
    }),

    // Aurora sync tracking - populated by periodic sync job
    auroraType: auroraTableTypeEnum('aurora_type'), // 'ascents' or 'bids'
    auroraId: text('aurora_id'), // UUID in Aurora's system
    auroraSyncedAt: timestamp('aurora_synced_at', { mode: 'string' }),
    auroraSyncError: text('aurora_sync_error'), // Last sync error if any

    // Kilter sync tracking - populated by kilter-sync. A single row can
    // legitimately carry both aurora_id and kilter_id (Kilter historically
    // imported Aurora-exported logbooks).
    kilterType: kilterTableTypeEnum('kilter_type'),
    kilterId: text('kilter_id'),
    kilterSyncedAt: timestamp('kilter_synced_at', { mode: 'string' }),
    kilterSyncError: text('kilter_sync_error'),
    // Stamped when Kilter sends a REMOVE (soft-detach): the upstream log was
    // deleted. The detach clears kilter_id, which alone makes the row
    // indistinguishable from a never-pushed native tick — push-back would
    // re-push it and resurrect it upstream (echo loop), and the ascensionist
    // recompute would keep counting a deleted ascent. This marker lets both
    // paths exclude it. Cleared when a later PUT re-links the same log
    // (REMOVE-then-PUT snapshot redelivery: the adoption path resets it).
    kilterDetachedAt: timestamp('kilter_detached_at', { mode: 'string' }),
  },
  (table) => ({
    // Index for efficient user logbook queries
    userBoardIdx: index('boardsesh_ticks_user_board_idx').on(table.userId, table.boardType),
    // Index for looking up ticks by climb
    climbIdx: index('boardsesh_ticks_climb_idx').on(table.climbUuid, table.boardType),
    // Unique index for Aurora sync - allows upsert on aurora_id
    // PostgreSQL unique indexes allow multiple NULLs by default
    auroraIdUnique: uniqueIndex('boardsesh_ticks_aurora_id_unique').on(table.auroraId),
    // Index for pending sync queries (ticks without aurora_id)
    syncPendingIdx: index('boardsesh_ticks_sync_pending_idx').on(table.auroraId, table.userId),
    // Unique index for Kilter sync - allows upsert on kilter_id
    kilterIdUnique: uniqueIndex('boardsesh_ticks_kilter_id_unique').on(table.kilterId),
    // Index for pending kilter push queries (ticks without kilter_id)
    kilterSyncPendingIdx: index('boardsesh_ticks_kilter_sync_pending_idx').on(table.kilterId, table.userId),
    // Index for session queries
    sessionIdx: index('boardsesh_ticks_session_idx').on(table.sessionId),
    // Index for climbed_at for sorting
    climbedAtIdx: index('boardsesh_ticks_climbed_at_idx').on(table.climbedAt),
    // Composite index for user logbook feed queries that filter by user and sort/group by date
    userClimbedAtIdx: index('boardsesh_ticks_user_climbed_at_idx').on(table.userId, table.climbedAt),
    // Index for board-scoped queries
    boardClimbedAtIdx: index('boardsesh_ticks_board_climbed_at_idx').on(table.boardId, table.climbedAt),
    boardUserIdx: index('boardsesh_ticks_board_user_idx').on(table.boardId, table.userId),
    // Covering index for climb search user tick lookups (ascents/attempts per climb)
    userClimbLookupIdx: index('boardsesh_ticks_user_climb_lookup_idx').on(
      table.userId,
      table.boardType,
      table.angle,
      table.climbUuid,
    ),
    // Index for the wall-kiosk "recent senders" byline (boardClimbRecentSenders):
    // equality on board_id + climb_uuid + angle + status, then GROUP BY user_id
    // ordered by max(climbed_at). Every kiosk re-runs it on each board stats
    // event, floored at one call per 2s per wall, so it is the hottest read on
    // this table.
    //
    // The widest index it could otherwise use is
    // boardsesh_ticks_board_climbed_at_idx (board_id, climbed_at), which leaves
    // the climb/angle/status predicates to a heap filter over every tick ever
    // logged on that board — tens of thousands of rows on a busy gym wall for a
    // handful of matches. These four equality columns narrow to just the
    // matching rows; climbed_at and user_id are deliberately left out even
    // though the query groups and sorts on them, because an index-only scan
    // would also need board_type, and those three text/timestamp columns would
    // roughly double the index on the largest table we have to save a heap
    // fetch on a few dozen rows.
    //
    // status is a key column rather than a WHERE clause (the shape
    // flash_send_updated_at_idx below uses) because the resolver sends it as
    // bind parameters; a partial index would then rest on Postgres proving
    // implication from those, which a generic plan cannot do.
    boardClimbSendersIdx: index('boardsesh_ticks_board_climb_senders_idx').on(
      table.boardId,
      table.climbUuid,
      table.angle,
      table.status,
    ),
    syncCursorIdx: index('boardsesh_ticks_sync_cursor_idx').on(table.userId, table.updatedAt, table.id),
    // Partial index for the hourly recompute self-heal (aurora daemon): the
    // in-process debounced recompute uses setTimeout, so a deploy drops any
    // pending recompute and leaves board_climb_stats.updated_at older than the
    // flash/send tick that should have bumped it. The self-heal scans
    // flash/send ticks updated within a recent window and re-derives the keys
    // whose stats row is stale. Bounding the scan to (flash,send, updated_at)
    // keeps it off a full boardsesh_ticks seq-scan.
    flashSendUpdatedAtIdx: index('boardsesh_ticks_flash_send_updated_at_idx')
      .on(table.updatedAt)
      .where(sql`${table.status} IN ('flash','send')`),
    // quality is a 1-5 star rating (NULL for attempts / unrated). Enforce the
    // range at the DB so a bad conversion (raw Aurora 0-3 stars, an old
    // proportional formula, etc.) can never re-poison the column. Backfills that
    // clear existing out-of-range values run earlier (migrations 0139/0140/0152).
    //
    // ⚠️ drizzle-kit 0.31 does NOT parse this object-form check(): every
    // `drizzle-kit generate` emits a destructive DROP CONSTRAINT for it and
    // omits it from the new snapshot. Strip the DROP from the generated SQL and
    // re-add the checkConstraints block to the snapshot (see the 0155 header;
    // same manually-managed pattern as the board_beta_links FKs).
    qualityRangeCheck: check(
      'boardsesh_ticks_quality_range',
      sql`${table.quality} IS NULL OR (${table.quality} >= 1 AND ${table.quality} <= 5)`,
    ),
  }),
);

// Type exports
export type BoardseshTick = typeof boardseshTicks.$inferSelect;
export type NewBoardseshTick = typeof boardseshTicks.$inferInsert;
export type TickStatus = 'flash' | 'send' | 'attempt';
export type TickOrigin = 'native' | 'aurora_pull' | 'kilter_pull' | 'json_import' | 'moonboard_import';
export type AuroraTableType = 'ascents' | 'bids';
export type KilterTableType = 'logs' | 'attempts';
