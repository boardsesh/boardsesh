import { pgTable, bigserial, text, timestamp, index, pgEnum } from 'drizzle-orm/pg-core';

export const locationSyncEntityTypeEnum = pgEnum('location_sync_entity_type', ['gym', 'board']);

/**
 * Durable record of an administrator deliberately releasing a human-curation
 * freeze. The target is polymorphic, so its UUID is stored without a foreign
 * key: the audit must survive a later hard-delete of the gym or board.
 */
export const locationSyncUnfreezeAudit = pgTable(
  'location_sync_unfreeze_audit',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    entityType: locationSyncEntityTypeEnum('entity_type').notNull(),
    entityUuid: text('entity_uuid').notNull(),
    previousSyncFrozenAt: timestamp('previous_sync_frozen_at').notNull(),
    previousDeletedAt: timestamp('previous_deleted_at'),
    // Deliberately not a FK: this snapshot should retain the prior owner id even
    // if that account is later removed.
    previousOwnerId: text('previous_owner_id').notNull(),
    reason: text('reason').notNull(),
    // Immutable actor snapshot, deliberately not a FK. Hard-deleting an account
    // must not erase who performed this administrative recovery action.
    performedBy: text('performed_by').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    entityHistoryIdx: index('location_sync_unfreeze_audit_entity_history_idx').on(
      table.entityType,
      table.entityUuid,
      table.createdAt,
    ),
    performedByIdx: index('location_sync_unfreeze_audit_performed_by_idx').on(table.performedBy),
  }),
);

export type LocationSyncUnfreezeAudit = typeof locationSyncUnfreezeAudit.$inferSelect;
export type NewLocationSyncUnfreezeAudit = typeof locationSyncUnfreezeAudit.$inferInsert;
