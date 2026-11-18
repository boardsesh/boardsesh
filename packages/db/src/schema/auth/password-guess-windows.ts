import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Who a counted guess is charged to: a typed email, or the recognised devices of
 * one account (#7656). Both are keyed HMAC digests, of the address or of the user id.
 */
export type PasswordGuessSubjectKind = 'email_digest' | 'account_digest';
/** A fixed UTC window: the clock hour, or the UTC day. */
export type PasswordGuessWindowKind = 'hour' | 'day';

/**
 * Rejected passwords counted per subject and fixed window (#7656). One row per
 * subject and window, so one conditional upsert reserves a guess atomically
 * and a parallel burst can only take the slots that are left.
 *
 * Holds no address and no user id, only keyed HMAC digests of them. Unknown
 * emails get rows too, so the table's size is driven by whoever sends sign-ins;
 * rows are useless a day after their window starts and the backend's auth
 * maintenance deletes them in batches.
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
    check('auth_password_guess_windows_subject_kind', sql`${table.subjectKind} IN ('email_digest', 'account_digest')`),
    check('auth_password_guess_windows_subject_key', sql`${table.subjectKey} ~ '^[0-9a-f]{64}$'`),
    check('auth_password_guess_windows_window_kind', sql`${table.windowKind} IN ('hour', 'day')`),
    check('auth_password_guess_windows_failures', sql`${table.failures} >= 0`),
  ],
);
