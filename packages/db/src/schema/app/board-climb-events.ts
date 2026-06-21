import { pgTable, text, integer, bigint, bigserial, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from '../auth/users';
import { boardSessions } from './sessions';
import { userBoards } from './boards';

/**
 * board_climb_events — the durable "what was on the wall" stream.
 *
 * Distinct from `boardsesh_ticks` (a climber's deliberate logbook entry, with
 * flash/send/attempt status): this records every climb that was actually pushed
 * to a board's LEDs, regardless of whether anyone logged it. It survives past
 * the 24h Redis presence window and is the substrate for "what was on last" and
 * future board leaderboards/competitions.
 *
 * Writes are dwell-gated: a member's sends are only persisted once they've had
 * sustained presence on the board for ~60s, so app-swiping noise doesn't land
 * here (the live Redis feed still shows everything). The display fields
 * (name/grade/setter/frames) are snapshotted at push time so history doesn't
 * drift when the catalog is later edited.
 */
export const boardClimbEvents = pgTable(
  'board_climb_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    boardId: bigint('board_id', { mode: 'number' })
      .notNull()
      .references(() => userBoards.id, { onDelete: 'cascade' }),
    boardType: text('board_type').notNull(),
    climbUuid: text('climb_uuid').notNull(),
    angle: integer('angle').notNull(),
    // The member whose phone wrote the frames. Nullable so deleting a user
    // doesn't erase the board's history.
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    // Reserved for session recaps: will hold the active session for in-session
    // pushes. Not yet populated — reportBoardClimb writes null until the
    // session-attribution follow-up threads the session through. Always null for
    // solo pushes.
    sessionId: text('session_id').references(() => boardSessions.id, { onDelete: 'set null' }),
    // Per-board monotonic sequence (reused from the live Redis feed) — gives
    // cross-instance ordering and a natural idempotency key with boardId.
    seq: bigint('seq', { mode: 'number' }).notNull(),
    // Snapshots captured at push time (the catalog may change later).
    frames: text('frames'),
    name: text('name'),
    grade: text('grade'),
    setter: text('setter'),
    confirmedAt: timestamp('confirmed_at', { mode: 'string' }).notNull(),
    createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => ({
    // "Recent sends for a board" / "what's on board X now" (LIMIT 1). A plain
    // (board, time) btree serves the DESC scan in either direction.
    boardConfirmedAtIdx: index('board_climb_events_board_confirmed_at_idx').on(table.boardId, table.confirmedAt),
    // Keyset paging + double-flush idempotency (onConflictDoNothing target).
    boardSeqUnique: uniqueIndex('board_climb_events_board_seq_unique').on(table.boardId, table.seq),
    // Session recap: every climb on the wall during a session.
    sessionIdx: index('board_climb_events_session_idx').on(table.sessionId),
    // "How often was this climb on this wall" (future leaderboards).
    boardClimbIdx: index('board_climb_events_board_climb_idx').on(table.boardId, table.climbUuid),
  }),
);

export type BoardClimbEvent = typeof boardClimbEvents.$inferSelect;
export type NewBoardClimbEvent = typeof boardClimbEvents.$inferInsert;
