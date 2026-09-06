import {
  pgTable,
  text,
  timestamp,
  boolean,
  jsonb,
  integer,
  bigint,
  bigserial,
  doublePrecision,
  index,
  primaryKey,
  uniqueIndex,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { ClimbQueueItem } from '@boardsesh/shared-schema';
import { users } from '../auth/users';
import { userBoards } from './boards';

/**
 * How a session came to exist.
 * - explicit: someone pressed Start. Live party mode, presence, queue, the lot.
 * - inferred: derived from a run of ticks with no >4h gap (@boardsesh/session-inference).
 *   Always already over — `status='ended'`, `started_at`/`ended_at` from its first and
 *   last tick, `is_permanent=false`, and no board path.
 *
 * Inferred sessions live in `board_sessions` rather than a table of their own so that
 * `boardsesh_ticks.session_id` stays the single source of session membership. The
 * previous implementation (removed in #2663) kept a parallel `inferred_sessions` table
 * and had to `COALESCE(session_id, inferred_session_id)` on every read — a non-sargable
 * predicate that seq-scanned the tick table, plus a UNION whose two arms computed
 * `total_attempts` differently. One table means none of that can come back.
 *
 * Every live-session path must therefore scope itself to `origin = 'explicit'` — the
 * auto-end sweep, the join guard, the leader checks. See `docs/inferred-sessions.md`.
 */
export const sessionOriginEnum = pgEnum('session_origin', ['explicit', 'inferred']);

// Board sessions for party mode (renamed from 'sessions' to avoid conflict with NextAuth sessions)
export const boardSessions = pgTable(
  'board_sessions',
  {
    id: text('id').primaryKey(),
    // Null for inferred sessions: they are reconstructed from ticks that may span
    // several boards, so there is no one path to record. Only two places read this
    // off the row — the Strava export and `updateSessionBoardPathIfChanged` — and
    // both are explicit-session paths.
    boardPath: text('board_path'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    lastActivity: timestamp('last_activity').defaultNow().notNull(),
    // Persistent lifecycle status. Live active/inactive presence is tracked in Redis;
    // SQL only uses ended/not-ended for durable history and discovery filtering.
    // (A legacy CHECK from backend migration 0005 also permits 'inactive' — never written.)
    status: text('status').default('active').notNull(),
    // GPS coordinates for session discovery
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    // Whether session appears in nearby search
    discoverable: boolean('discoverable').default(false).notNull(),
    // Link to authenticated user who created the session
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    // Session name for display in discovery
    name: text('name'),
    // Optional link to the board entity this session is for
    boardId: bigint('board_id', { mode: 'number' }).references(() => userBoards.id, {
      onDelete: 'set null',
    }),
    // Session goal text (e.g., "Send V5 today")
    goal: text('goal'),
    // Free-text end-of-session recap (Strava-style description). Named `notes`
    // rather than `comment` because the polymorphic social comments table
    // already targets sessions and ticks carry their own `comment` column.
    notes: text('notes'),
    // Whether session appears in public discovery
    isPublic: boolean('is_public').default(true).notNull(),
    // Explicit start time
    startedAt: timestamp('started_at'),
    // When the session was ended (null = still active or inactive)
    endedAt: timestamp('ended_at'),
    // IANA timezone of the device that ended the session (e.g.
    // 'Australia/Melbourne'). Timestamps are stored UTC; external platforms
    // like Strava want wall-clock local time, which needs this to reconstruct.
    timezone: text('timezone'),
    // Exempt from auto-end cleanup
    isPermanent: boolean('is_permanent').default(false).notNull(),
    // Hex color for multi-session display
    color: text('color'),
    // See sessionOriginEnum. Defaults to 'explicit' so every pre-existing row —
    // and every party-mode insert that doesn't know about this column — keeps its
    // current behaviour.
    origin: sessionOriginEnum('origin').default('explicit').notNull(),
    // Identity anchor for inferred sessions: the lowest `boardsesh_ticks.id` the
    // session held when it was created. `id` is a bigserial assigned at insert and
    // never reassigned, so the anchor survives the session's membership changing
    // around it — which it does constantly, since 96% of kilter_pull ticks and every
    // MoonBoard import arrive back-dated.
    //
    // This is the fix for the v1 identity bug: session ids were
    // `uuidv5(userId + ':' + firstTickTimestamp)`, so a back-dated tick landing
    // earlier in the run re-keyed the session and orphaned its votes and comments.
    //
    // Deliberately NOT a foreign key. `boardsesh_ticks` already references
    // `board_sessions`, and the reverse constraint would make the two schema modules
    // circular. Reconciliation tolerates a dangling anchor: it just rebuilds the run.
    anchorTickId: bigint('anchor_tick_id', { mode: 'number' }),
    // Set once someone names or annotates a session. Decides which row survives when
    // a back-dated tick bridges two inferred sessions and they have to merge.
    userEdited: boolean('user_edited').default(false).notNull(),
  },
  (table) => ({
    locationIdx: index('board_sessions_location_idx').on(table.latitude, table.longitude),
    // Drives "this climber's inferred sessions in this window" during reconciliation.
    userOriginIdx: index('board_sessions_user_origin_idx').on(table.createdByUserId, table.origin),
    // Anchor lookup: given a run of ticks, which existing session claims it?
    //
    // UNIQUE, because reconciliation is only idempotent when re-run in sequence. Two
    // tick writers reconciling the same previously-unassigned run both read
    // `sessionId: null`, and both would mint a session against the same anchor —
    // leaving duplicate rows whose tick updates race. The constraint makes the second
    // insert fail so its caller can retry and inherit the row the first one created.
    //
    // Partial: explicit sessions never set an anchor, and Postgres treats NULLs as
    // distinct anyway, so the predicate is about intent rather than necessity.
    anchorTickIdx: uniqueIndex('board_sessions_anchor_tick_idx')
      .on(table.anchorTickId)
      .where(sql`${table.origin} = 'inferred'`),
    discoverableIdx: index('board_sessions_discoverable_idx').on(table.discoverable),
    userSessionsIdx: index('board_sessions_user_idx').on(table.createdByUserId),
    statusIdx: index('board_sessions_status_idx').on(table.status),
    lastActivityIdx: index('board_sessions_last_activity_idx').on(table.lastActivity),
    discoveryIdx: index('board_sessions_discovery_idx').on(table.discoverable, table.status, table.lastActivity),
  }),
);

export const sessionHealthKitWorkouts = pgTable(
  'session_health_kit_workouts',
  {
    sessionId: text('session_id')
      .references(() => boardSessions.id, { onDelete: 'cascade' })
      .notNull(),
    userId: text('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    workoutId: text('workout_id').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.sessionId, table.userId] }),
    sessionIdx: index('session_health_kit_workouts_session_idx').on(table.sessionId),
    userIdx: index('session_health_kit_workouts_user_idx').on(table.userId),
  }),
);

export const boardSessionQueues = pgTable('board_session_queues', {
  sessionId: text('session_id')
    .primaryKey()
    .references(() => boardSessions.id, { onDelete: 'cascade' }),
  queue: jsonb('queue').$type<ClimbQueueItem[]>().default([]).notNull(),
  currentClimbQueueItem: jsonb('current_climb_queue_item').$type<ClimbQueueItem | null>().default(null),
  version: integer('version').default(1).notNull(),
  // Sequence number for event ordering (separate from version used for optimistic locking)
  sequence: integer('sequence').default(0).notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Junction table for multi-board sessions
export const sessionBoards = pgTable(
  'session_boards',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    sessionId: text('session_id')
      .references(() => boardSessions.id, { onDelete: 'cascade' })
      .notNull(),
    boardId: bigint('board_id', { mode: 'number' })
      .references(() => userBoards.id, { onDelete: 'cascade' })
      .notNull(),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    uniqueSessionBoard: uniqueIndex('session_boards_session_board_idx').on(table.sessionId, table.boardId),
    sessionIdx: index('session_boards_session_idx').on(table.sessionId),
    boardIdx: index('session_boards_board_idx').on(table.boardId),
  }),
);

// Type exports for use in other files
export type BoardSession = typeof boardSessions.$inferSelect;
export type NewBoardSession = typeof boardSessions.$inferInsert;
export type SessionHealthKitWorkout = typeof sessionHealthKitWorkouts.$inferSelect;
export type NewSessionHealthKitWorkout = typeof sessionHealthKitWorkouts.$inferInsert;
export type BoardSessionQueue = typeof boardSessionQueues.$inferSelect;
export type NewBoardSessionQueue = typeof boardSessionQueues.$inferInsert;
export type SessionBoard = typeof sessionBoards.$inferSelect;
export type NewSessionBoard = typeof sessionBoards.$inferInsert;
