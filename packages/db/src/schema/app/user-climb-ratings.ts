import { pgTable, text, integer, timestamp, index, primaryKey } from 'drizzle-orm/pg-core';
import { users } from '../auth/users';

/**
 * Per-user climb quality projection.
 * One row per (user, climb) — angle-independent. Updated on every tick write
 * by the latest tick (by climbedAt) that supplied a quality value.
 */
export const userClimbQualities = pgTable(
  'user_climb_qualities',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    boardType: text('board_type').notNull(),
    climbUuid: text('climb_uuid').notNull(),
    quality: integer('quality').notNull(),
    updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.boardType, table.climbUuid] }),
    climbIdx: index('user_climb_qualities_climb_idx').on(table.boardType, table.climbUuid),
  }),
);

/**
 * Per-user climb grade projection.
 * One row per (user, climb, angle). Updated on every tick write by the latest
 * tick (by climbedAt) at the same angle that supplied a difficulty value.
 */
export const userClimbGrades = pgTable(
  'user_climb_grades',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    boardType: text('board_type').notNull(),
    climbUuid: text('climb_uuid').notNull(),
    angle: integer('angle').notNull(),
    difficulty: integer('difficulty').notNull(),
    updatedAt: timestamp('updated_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.boardType, table.climbUuid, table.angle] }),
    climbIdx: index('user_climb_grades_climb_idx').on(table.boardType, table.climbUuid, table.angle),
  }),
);

export type UserClimbQuality = typeof userClimbQualities.$inferSelect;
export type NewUserClimbQuality = typeof userClimbQualities.$inferInsert;
export type UserClimbGrade = typeof userClimbGrades.$inferSelect;
export type NewUserClimbGrade = typeof userClimbGrades.$inferInsert;
