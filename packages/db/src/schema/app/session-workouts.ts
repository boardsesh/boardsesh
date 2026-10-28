import { pgTable, text, timestamp, jsonb, integer, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from '../auth/users';
import { boardSessions } from './sessions';

/**
 * The workout a climber followed in a session (#6903): one row per climber per
 * session, written by their own phone through `recordSessionWorkout`. What each
 * block came to is never stored; readers derive it from the climber's ticks in
 * the session with `@boardsesh/workout-summary`. See docs/workout-stages.md,
 * "Workouts on the server".
 *
 * Both JSON columns are typed `unknown` on purpose: every reader runs them
 * through `parseSessionWorkoutPlan` / `parseSessionWorkoutTickMap`, so a row
 * written by a newer server than the reader is checked, not trusted.
 */
export const sessionWorkouts = pgTable(
  'session_workouts',
  {
    sessionId: text('session_id')
      .references(() => boardSessions.id, { onDelete: 'cascade' })
      .notNull(),
    userId: text('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    /** `SessionWorkoutPlan`: the stages and the climbs queued for each. */
    plan: jsonb('plan').notNull(),
    /** `SessionWorkoutTickMapEntry[]`: which queue item each tick was logged on. */
    tickMap: jsonb('tick_map')
      .default(sql`'[]'::jsonb`)
      .notNull(),
    /**
     * The phone's per-session write counter. A write lands only when its
     * revision is higher than the stored one, so an outbox replay of an older
     * write is a no-op.
     */
    revision: integer('revision').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // Leads with session_id, so it also serves every read by session.
    sessionUserIdx: uniqueIndex('session_workouts_session_user_idx').on(table.sessionId, table.userId),
  }),
);

export type SessionWorkoutRow = typeof sessionWorkouts.$inferSelect;
export type NewSessionWorkoutRow = typeof sessionWorkouts.$inferInsert;
