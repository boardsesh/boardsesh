import { pgTable, text, timestamp, primaryKey, index } from 'drizzle-orm/pg-core';

/** No address or users foreign key: evidence survives deletion without retaining mailboxes. */
export const authEmailResolutionLog = pgTable(
  'auth_email_resolution_log',
  {
    batchId: text('batch_id').notNull(),
    groupReference: text('group_reference').notNull(),
    userId: text('user_id').notNull(),
    action: text('action').$type<'keep' | 'retire' | 'normalize'>().notNull(),
    evidenceKind: text('evidence_kind').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.batchId, table.groupReference, table.userId] }),
    index('auth_email_resolution_group_idx').on(table.groupReference, table.recordedAt),
  ],
);
