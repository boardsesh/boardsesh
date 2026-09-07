import { pgTable, text, integer, timestamp, jsonb, primaryKey, index } from 'drizzle-orm/pg-core';
import { users } from '../auth/users';

// Completion survives unlink/relink; removing the Boardsesh user removes their private ledger.
export const moonboardImportJobs = pgTable(
  'moonboard_import_jobs',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    credentialVersion: text('credential_version').notNull(),
    status: text('status').notNull().default('pending'),
    owner: text('owner'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    retryAt: timestamp('retry_at', { withTimezone: true }),
    lastError: text('last_error'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.accountId] }),
    index('moonboard_jobs_pending_idx').on(table.status, table.retryAt),
  ],
);

// A source entry stays claimed even when its tick is subsequently edited/deleted locally.
export const moonboardLogbookEntries = pgTable(
  'moonboard_logbook_entries',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    entryId: text('entry_id').notNull(),
    tickUuid: text('tick_uuid').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.accountId, table.entryId] }),
    index('moonboard_entries_tick_idx').on(table.tickUuid),
  ],
);

export const moonboardSyncState = pgTable('moonboard_sync_state', {
  key: text('key').primaryKey(),
  owner: text('owner'),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  retryAt: timestamp('retry_at', { withTimezone: true }),
  lastError: text('last_error'),
  metadata: jsonb('metadata').notNull().default({}),
});

// Counts, not credentials: resumable media reconciliation independent of local files.
export const moonboardMediaState = pgTable('moonboard_media_state', {
  problemId: integer('problem_id').primaryKey(),
  expectedCount: integer('expected_count').notNull(),
  sourceCount: integer('source_count'),
  isBenchmark: integer('is_benchmark').notNull().default(0),
  holdsetup: integer('holdsetup').notNull(),
});
