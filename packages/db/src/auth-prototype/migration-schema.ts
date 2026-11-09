import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/** Migration boundaries outlive ordinary verification/token cleanup. */
export const prototypeAuthMigrationEpoch = pgTable('prototype_auth_migration_epoch', {
  name: text('name').primaryKey(),
  cutoverAt: timestamp('cutover_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
