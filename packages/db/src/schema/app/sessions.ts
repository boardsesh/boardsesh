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
} from 'drizzle-orm/pg-core';
import type { ClimbQueueItem } from '@boardsesh/shared-schema';
import { users } from '../auth/users';
import { userBoards } from './boards';

// Board sessions for party mode (renamed from 'sessions' to avoid conflict with NextAuth sessions)
export const boardSessions = pgTable(
  'board_sessions',
  {
    id: text('id').primaryKey(),
    boardPath: text('board_path').notNull(),
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
  },
  (table) => ({
    locationIdx: index('board_sessions_location_idx').on(table.latitude, table.longitude),
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

export const boardSessionClients = pgTable('board_session_clients', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .references(() => boardSessions.id, { onDelete: 'cascade' })
    .notNull(),
  username: text('username'),
  connectedAt: timestamp('connected_at').defaultNow().notNull(),
  isLeader: boolean('is_leader').default(false).notNull(),
});

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
export type BoardSessionClient = typeof boardSessionClients.$inferSelect;
export type NewBoardSessionClient = typeof boardSessionClients.$inferInsert;
export type BoardSessionQueue = typeof boardSessionQueues.$inferSelect;
export type NewBoardSessionQueue = typeof boardSessionQueues.$inferInsert;
export type SessionBoard = typeof sessionBoards.$inferSelect;
export type NewSessionBoard = typeof sessionBoards.$inferInsert;
