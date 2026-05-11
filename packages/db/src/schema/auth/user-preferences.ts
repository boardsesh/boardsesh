import { jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Generic per-user key/value preferences store.
 *
 * Used for any small preference the user can toggle (consent flags,
 * onboarding completion markers, feature opt-ins, etc.) that should
 * survive across devices when the user is signed in.
 *
 * Composite PK on (userId, key) — one row per (user, key) pair.
 * onDelete: cascade so a user account deletion cleans up prefs.
 */
export const userPreferences = pgTable(
  'user_preferences',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.key] }) }),
);

export type UserPreferenceRow = typeof userPreferences.$inferSelect;
