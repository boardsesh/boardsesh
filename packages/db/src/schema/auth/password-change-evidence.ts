import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users';

/** A real password write, never an import or an observation of an old hash. */
export const authPasswordChangeEvidence = pgTable(
  'auth_password_change_evidence',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    passwordFingerprint: text('password_fingerprint').notNull(),
    // No default: callers must record the database clock after the real write.
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull(),
  },
  (table) => [check('auth_password_change_evidence_fingerprint', sql`${table.passwordFingerprint} ~ '^[0-9a-f]{64}$'`)],
);
