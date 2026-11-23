import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import type { OfflineWriteRelease } from '@boardsesh/shared-schema';
import { users } from '../auth/users';

/** Private operational evidence. No mutation payload, tick content, or analytics identity is retained. */
export const offlineWriteDeliveries = pgTable(
  'offline_write_deliveries',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deliveryId: text('delivery_id').notNull(),
    tableName: text('table_name').notNull(),
    operation: text('operation').notNull(),
    bindingHash: text('binding_hash'),
    queuedAt: timestamp('queued_at', { withTimezone: true }),
    connectivityReason: text('connectivity_reason'),
    originRelease: jsonb('origin_release').$type<OfflineWriteRelease>(),
    observedRelease: jsonb('observed_release').$type<OfflineWriteRelease>(),
    receivingRelease: jsonb('receiving_release').$type<OfflineWriteRelease>(),
    rejectionRelease: jsonb('rejection_release').$type<OfflineWriteRelease>(),
    clientState: text('client_state'),
    clientRevision: integer('client_revision').default(0).notNull(),
    clientObservedAt: timestamp('client_observed_at', { withTimezone: true }),
    clientServerResponseAt: timestamp('client_server_response_at', { withTimezone: true }),
    clientReconciledAt: timestamp('client_reconciled_at', { withTimezone: true }),
    firstDeadLetterAt: timestamp('first_dead_letter_at', { withTimezone: true }),
    lastDeadLetterAt: timestamp('last_dead_letter_at', { withTimezone: true }),
    recovered: boolean('recovered').default(false).notNull(),
    serverAcceptedAt: timestamp('server_accepted_at', { withTimezone: true }),
    serverRejectedAt: timestamp('server_rejected_at', { withTimezone: true }),
    serverRejectionCode: text('server_rejection_code'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
    lastReportedAt: timestamp('last_reported_at', { withTimezone: true }),
    reconciledReportedAt: timestamp('reconciled_reported_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.deliveryId] }),
    index('offline_write_deliveries_cohort_idx').on(table.firstSeenAt, table.connectivityReason),
  ],
);

export type OfflineWriteDeliveryRow = typeof offlineWriteDeliveries.$inferSelect;
