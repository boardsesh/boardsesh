import { pgTable, text, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from '../auth/users';
export const boardMergeRequests = pgTable(
  'board_merge_requests',
  {
    uuid: text('uuid').primaryKey(),
    signature: text('signature').notNull(),
    boardUuids: jsonb('board_uuids').$type<string[]>().notNull(),
    canonicalBoardUuid: text('canonical_board_uuid').notNull(),
    status: text('status').$type<'open' | 'approved' | 'rejected' | 'superseded'>().notNull().default('open'),
    reason: text('reason').notNull(),
    proposerId: text('proposer_id').references(() => users.id, { onDelete: 'set null' }),
    resolvedBy: text('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    resolutionReason: text('resolution_reason'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    resolvedAt: timestamp('resolved_at'),
  },
  (table) => [
    uniqueIndex('board_merge_requests_open_signature_idx')
      .on(table.signature)
      .where(sql`${table.status} = 'open'`),
    index('board_merge_requests_status_idx').on(table.status, table.createdAt),
  ],
);
export const boardMergeReports = pgTable(
  'board_merge_reports',
  {
    uuid: text('uuid').primaryKey(),
    requestUuid: text('request_uuid')
      .references(() => boardMergeRequests.uuid)
      .notNull(),
    reporterId: text('reporter_id').references(() => users.id, { onDelete: 'set null' }),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [uniqueIndex('board_merge_reports_request_user_idx').on(table.requestUuid, table.reporterId)],
);
export const boardMergeAudit = pgTable('board_merge_audit', {
  uuid: text('uuid').primaryKey(),
  canonicalBoardUuid: text('canonical_board_uuid').notNull(),
  boardUuids: jsonb('board_uuids').$type<string[]>().notNull(),
  performedBy: text('performed_by').references(() => users.id, { onDelete: 'set null' }),
  reason: text('reason').notNull(),
  beforeState: jsonb('before_state').$type<unknown>().notNull(),
  movedCounts: jsonb('moved_counts').$type<unknown>().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
