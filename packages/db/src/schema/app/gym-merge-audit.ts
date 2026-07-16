import { pgTable, bigserial, bigint, text, jsonb, timestamp, index, pgEnum } from 'drizzle-orm/pg-core';
import { gyms } from './gyms';
import { users } from '../auth/users';

/**
 * A merge either folds a duplicate gym into a canonical survivor ('merged') or
 * records that an admin looked at a candidate cluster and decided it is NOT a
 * duplicate ('dismissed'). Dismissals keep the cluster out of the review queue
 * without touching any gym row.
 */
export const gymMergeAuditActionEnum = pgEnum('gym_merge_audit_action', ['merged', 'dismissed']);

/**
 * Audit trail for the /admin/gym-duplicates review queue.
 *
 * One row per admin decision:
 *  - `merged`: a duplicate gym was folded into the canonical survivor. Both ids
 *    are set, `moved_counts` records what was re-pointed (boards, follows,
 *    members, kiosks, claims, ...) and `warnings` any side effects the admin
 *    should know about (a kiosk whose slug was suffixed, invalidating its
 *    printed install QR).
 *  - `dismissed`: the admin decided the cluster is not a duplicate. `duplicate_gym_id`
 *    is null; the row is keyed by `cluster_signature` (a stable hash of the sorted
 *    member gym ids) so the queue can hide that exact cluster on the next load.
 */
export const gymMergeAudit = pgTable(
  'gym_merge_audit',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    action: gymMergeAuditActionEnum('action').notNull(),
    // Always populated on write; nullable at the DB level with ON DELETE SET NULL
    // so a later hard-delete of a gym never strands an audit row.
    canonicalGymId: bigint('canonical_gym_id', { mode: 'number' }).references(() => gyms.id, {
      onDelete: 'set null',
    }),
    // Null for dismissals (no gym was merged); set for every 'merged' row.
    duplicateGymId: bigint('duplicate_gym_id', { mode: 'number' }).references(() => gyms.id, {
      onDelete: 'set null',
    }),
    // Stable hash of the sorted member gym ids — the cluster identity used to hide
    // dismissed clusters from the queue.
    clusterSignature: text('cluster_signature').notNull(),
    // What the merge re-pointed (null for dismissals). Shape mirrors MergeCounts.
    movedCounts: jsonb('moved_counts'),
    // The identifiers of every re-pointed row, per table (shape mirrors
    // MergeMovedRows). Null for dismissals. Aggregate counts can't say WHICH rows
    // moved, so this is what a manual reversal of a bad merge reads.
    movedRows: jsonb('moved_rows'),
    // Non-fatal side effects the admin should see (kiosk slug changes). Array of
    // MergeWarning; null for dismissals.
    warnings: jsonb('warnings'),
    // The admin who performed the action.
    performedBy: text('performed_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    // Serves the queue's "hide dismissed clusters" filter (action = 'dismissed').
    signatureActionIdx: index('gym_merge_audit_signature_action_idx').on(table.clusterSignature, table.action),
    canonicalIdx: index('gym_merge_audit_canonical_idx').on(table.canonicalGymId),
  }),
);

export type GymMergeAudit = typeof gymMergeAudit.$inferSelect;
export type NewGymMergeAudit = typeof gymMergeAudit.$inferInsert;
