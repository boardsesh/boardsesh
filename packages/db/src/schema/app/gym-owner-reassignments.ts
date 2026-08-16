import { pgTable, bigserial, text, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * Durable record of an administrator moving a gym's ownership to another
 * account — a sold gym, a departed committee member, a claim approved to the
 * wrong person. Modelled on `location_sync_unfreeze_audit`: the gym is
 * identified by UUID and both owner ids are plain text, so the record survives
 * a later hard-delete of the gym or of either account.
 *
 * `syncFrozenAtBefore`/`syncFrozenAtAfter` snapshot the human-curation marker
 * either side of the write. A reassignment must never touch it — including
 * leaving NULL as NULL — so recording both makes that machine-checkable rather
 * than a claim in a comment.
 */
export const gymOwnerReassignments = pgTable(
  'gym_owner_reassignments',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    gymUuid: text('gym_uuid').notNull(),
    // Deliberately not FKs: the audit outlives an account deletion.
    previousOwnerId: text('previous_owner_id').notNull(),
    newOwnerId: text('new_owner_id').notNull(),
    syncFrozenAtBefore: timestamp('sync_frozen_at_before'),
    syncFrozenAtAfter: timestamp('sync_frozen_at_after'),
    reason: text('reason').notNull(),
    // Immutable actor snapshot, deliberately not a FK.
    performedBy: text('performed_by').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    gymHistoryIdx: index('gym_owner_reassignments_gym_history_idx').on(table.gymUuid, table.createdAt),
    performedByIdx: index('gym_owner_reassignments_performed_by_idx').on(table.performedBy),
  }),
);

export type GymOwnerReassignment = typeof gymOwnerReassignments.$inferSelect;
export type NewGymOwnerReassignment = typeof gymOwnerReassignments.$inferInsert;
