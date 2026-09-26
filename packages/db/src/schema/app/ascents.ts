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
    // The climber's own grade for this climb, on the Aurora difficulty scale.
    // NULL means they didn't give one, NOT "this is an attempt": an attempt may
    // carry a grade, which is how you re-grade a sandbagged climb you haven't
    // sent yet (#4828). Every consumer that must not hear from a non-sender
    // already filters `status IN ('flash','send')` — the grade model's rater
    // sample, the profile and session OG cards, the board leaderboard and the
    // session summary — so a graded attempt is contained by those, not by this
    // column being empty.
    difficulty: integer('difficulty'),
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
    syncCursorIdx: index('boardsesh_ticks_sync_cursor_idx').on(table.userId, table.updatedAt, table.id),
    // Covering index for the personal-grade read (#4828): "the difficulty of
    // this climber's LATEST graded tick for (board, angle, climb)". The search
    // builds that whole set once per query as a
    //   DISTINCT ON (climb_uuid) … ORDER BY climb_uuid, climbed_at DESC, uuid DESC
    // subquery, so the leading three columns are equality-bound, `climb_uuid`
    // hands the DISTINCT ON its grouping already in order, (climbed_at DESC,
    // uuid DESC) puts the latest of each group first with no sort, and the
    // trailing `difficulty` makes the scan index-only.
    //
    // ⚠️ `.nullsFirst()` on the two DESC columns is load-bearing, not decoration.
    // A bare `DESC` in a Postgres ORDER BY means DESC NULLS FIRST, while a bare
    // `.desc()` index column emits `DESC NULLS LAST`. Those are different
    // pathkeys, so the mismatched form cannot satisfy the ordering and Postgres
    // stacks a Sort node on top of the index scan (measured: `Limit -> Sort ->
    // Index Only Scan` with NULLS LAST, a bare `Index Only Scan` with this
    // form). Both columns are NOT NULL, so the two declarations are semantically
    // identical — only the pathkey match differs.
    //
    // `difficulty` is a trailing KEY column rather than an INCLUDE payload
    // because drizzle-kit 0.31 / drizzle-orm 0.45 cannot express INCLUDE, and
    // migrations here are generated, never hand-written. Same covering effect,
    // a few bytes wider per entry.
    //
    // Partial on `difficulty IS NOT NULL`: an ungraded tick can never be the
    // answer, and most ticks carry no grade, so the index stays a small slice of
    // the table. `0` is a real difficulty id, so the predicate is a NULL test,
    // never a falsy one.
    userGradeLatestIdx: index('boardsesh_ticks_user_grade_latest_idx')
      .on(
        table.userId,
        table.boardType,
        table.angle,
        table.climbUuid,
        table.climbedAt.desc().nullsFirst(),
        table.uuid.desc().nullsFirst(),
        table.difficulty,
      )
      .where(sql`${table.difficulty} IS NOT NULL`),
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
