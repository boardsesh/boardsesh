import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/** Who a counted guess is charged to: an email (by keyed digest) or a recognised device's token. */
export type PasswordGuessSubjectKind = 'email_digest' | 'device_token';
/** A fixed UTC window: the clock hour, or the UTC day. */
export type PasswordGuessWindowKind = 'hour' | 'day';

/**
 * Rejected passwords counted per subject and fixed window (#7656). One row per
 * subject and window, so one conditional upsert reserves a guess atomically
 * and a parallel burst can only take the slots that are left.
 *
 * Holds no address and no user id: an email is a keyed HMAC digest and a
 * device is its token's random id. Rows are useless a day after their window
 * starts and the backend's auth maintenance deletes them.
 */
export const authPasswordGuessWindows = pgTable(
  'auth_password_guess_windows',
  {
    subjectKind: text('subject_kind').$type<PasswordGuessSubjectKind>().notNull(),
    subjectKey: text('subject_key').notNull(),
    windowKind: text('window_kind').$type<PasswordGuessWindowKind>().notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    failures: integer('failures').notNull().default(0),
  },
  (table) => [
    primaryKey({
      name: 'auth_password_guess_windows_pk',
      columns: [table.subjectKind, table.subjectKey, table.windowKind, table.windowStart],
    }),
    index('auth_password_guess_windows_start_idx').on(table.windowStart),
    check('auth_password_guess_windows_subject_kind', sql`${table.subjectKind} IN ('email_digest', 'device_token')`),
    check(
      'auth_password_guess_windows_subject_key',
      sql`(${table.subjectKind} = 'email_digest' AND ${table.subjectKey} ~ '^[0-9a-f]{64}$') OR (${table.subjectKind} = 'device_token' AND ${table.subjectKey} ~ '^[A-Za-z0-9_-]{22}$')`,
    ),
    check('auth_password_guess_windows_window_kind', sql`${table.windowKind} IN ('hour', 'day')`),
    check('auth_password_guess_windows_failures', sql`${table.failures} >= 0`),
  ],
);
