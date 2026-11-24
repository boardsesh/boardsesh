import { pgTable, bigserial, bigint, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from '../auth/users';

/** Directory evidence survives deletion; actor identity clears with the account, like gym merge audits. */
export const gymDirectoryRepairAudit = pgTable(
  'gym_directory_repair_audit',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    operation: text('operation').notNull(),
    gymId: bigint('gym_id', { mode: 'number' }).notNull(),
    gymUuid: text('gym_uuid').notNull(),
    actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    reason: text('reason').notNull(),
    before: jsonb('before').notNull(),
    after: jsonb('after').notNull(),
    details: jsonb('details'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    gymHistoryIdx: index('gym_directory_repair_audit_gym_history_idx').on(table.gymUuid, table.createdAt),
    actorIdx: index('gym_directory_repair_audit_actor_idx').on(table.actorUserId),
  }),
);

export type GymDirectoryRepairAudit = typeof gymDirectoryRepairAudit.$inferSelect;
export type NewGymDirectoryRepairAudit = typeof gymDirectoryRepairAudit.$inferInsert;
