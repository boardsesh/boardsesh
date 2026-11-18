import { bigserial, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/** Actor and app snapshots deliberately survive account and application deletion. */
export const partnerAppCapAudit = pgTable(
  'partner_app_cap_audit',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    clientId: text('client_id').notNull(),
    performedBy: text('performed_by').notNull(),
    previousMaxActiveConnections: integer('previous_max_active_connections').notNull(),
    previousMaxNewConnectionsPerDay: integer('previous_max_new_connections_per_day').notNull(),
    maxActiveConnections: integer('max_active_connections').notNull(),
    maxNewConnectionsPerDay: integer('max_new_connections_per_day').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('partner_app_cap_audit_client_history_idx').on(table.clientId, table.createdAt),
    index('partner_app_cap_audit_actor_idx').on(table.performedBy),
  ],
);
