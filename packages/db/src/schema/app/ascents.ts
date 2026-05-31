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
} from 'drizzle-orm/pg-core';
import { users } from '../auth/users';
import { boardSessions } from './sessions';
import { userBoards } from './boards';
import { inferredSessions } from './inferred-sessions';

/**
 * Tick status enum
 * - flash: Completed on first attempt
 * - send: Completed after multiple attempts
 * - attempt: Did not complete (logged failed attempts)
 */
export const tickStatusEnum = pgEnum('tick_status', ['flash', 'send', 'attempt']);

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

    // Optional link to inferred session (for ticks not in party mode)
    inferredSessionId: text('inferred_session_id').references(() => inferredSessions.id, {
      onDelete: 'set null',
    }),

    // Stores original inferredSessionId before manual reassignment (for undo)
    previousInferredSessionId: text('previous_inferred_session_id').references(() => inferredSessions.id, {
      onDelete: 'set null',
    }),

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
    // Index for inferred session queries
    inferredSessionIdx: index('boardsesh_ticks_inferred_session_idx').on(table.inferredSessionId),
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
    // Composite-cursor index for syncTicks (offline sync pull). The resolver
    // filters `user_id = $userId` then walks (updated_at, id) row-value pairs, so
    // a leading user_id keeps each user's pull index-only — no per-page filter +
    // in-memory sort. Seq component is the bigserial id.
    syncCursorIdx: index('boardsesh_ticks_sync_cursor_idx').on(table.userId, table.updatedAt, table.id),
  }),
);

// Type exports
export type BoardseshTick = typeof boardseshTicks.$inferSelect;
export type NewBoardseshTick = typeof boardseshTicks.$inferInsert;
export type TickStatus = 'flash' | 'send' | 'attempt';
export type AuroraTableType = 'ascents' | 'bids';
export type KilterTableType = 'logs' | 'attempts';
