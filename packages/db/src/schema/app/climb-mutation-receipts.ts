import { index, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import type { UpdateClimbResult } from '@boardsesh/shared-schema';
import { users } from '../auth/users';

/**
 * Durable identities for offline climb writes. These are not sync tombstones:
 * pruning them would permit an old outbox to recreate a deleted climb or replay
 * an update over a newer edit. No climb content or request payload is retained.
 * Account erasure removes attribution while leaving the used identity reserved.
 */
export const climbMutationReceipts = pgTable(
  'climb_mutation_receipts',
  {
    operationKey: text('operation_key').primaryKey(),
    climbUuid: text('climb_uuid').notNull(),
    boardType: text('board_type').notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    // Create receipts reserve an identity only; update receipts acknowledge the
    // original operation without rerunning its edit-window or geometry checks.
    result: jsonb('result').$type<UpdateClimbResult>(),
  },
  (table) => [index('climb_mutation_receipts_user_idx').on(table.userId)],
);
