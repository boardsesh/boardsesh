import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Unmounted operator state. No user FK: security mappings must survive retirement/deletion. */
export const accountConsolidationBatches = pgTable(
  'account_consolidation_batches',
  {
    batchId: text('batch_id').primaryKey(),
    planSha256: text('plan_sha256').notNull(),
    policyVersion: integer('policy_version').notNull(),
    status: text('status').$type<'planned' | 'applying' | 'applied' | 'failed'>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('account_consolidation_batches_plan_idx').on(table.planSha256),
    check('account_consolidation_batches_status', sql`${table.status} IN ('planned','applying','applied','failed')`),
    check('account_consolidation_batches_policy', sql`${table.policyVersion} > 0`),
  ],
);

export const accountConsolidationMembers = pgTable(
  'account_consolidation_members',
  {
    sourceUserId: text('source_user_id').primaryKey(),
    canonicalUserId: text('canonical_user_id').notNull(),
    mergeId: text('merge_id').notNull(),
    status: text('status').$type<'planned' | 'applied'>().notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
  },
  (table) => [
    index('account_consolidation_members_target_idx').on(table.canonicalUserId),
    check('account_consolidation_members_distinct', sql`${table.sourceUserId} <> ${table.canonicalUserId}`),
    check('account_consolidation_members_status', sql`${table.status} IN ('planned','applied')`),
    check('account_consolidation_members_applied', sql`${table.status} <> 'applied' OR ${table.appliedAt} IS NOT NULL`),
  ],
);

export const accountConsolidationTickAliases = pgTable(
  'account_consolidation_tick_aliases',
  {
    retiredUuid: text('retired_uuid').primaryKey(),
    canonicalUuid: text('canonical_uuid'),
    targetUserId: text('target_user_id').notNull(),
    mergeId: text('merge_id').notNull(),
    tombstoned: boolean('tombstoned').default(false).notNull(),
  },
  (table) => [
    check(
      'account_consolidation_tick_alias_distinct',
      sql`${table.canonicalUuid} IS NULL OR ${table.retiredUuid} <> ${table.canonicalUuid}`,
    ),
    check('account_consolidation_tick_alias_tombstone', sql`${table.tombstoned} OR ${table.canonicalUuid} IS NOT NULL`),
  ],
);

export const accountConsolidationImportAliases = pgTable(
  'account_consolidation_import_aliases',
  {
    formerUserId: text('former_user_id').notNull(),
    provider: text('provider').notNull(),
    kind: text('kind').$type<'tick' | 'playlist' | 'climb'>().notNull(),
    externalId: text('external_id').notNull(),
    canonicalResourceId: text('canonical_resource_id'),
    targetUserId: text('target_user_id').notNull(),
    mergeId: text('merge_id').notNull(),
    tombstoned: boolean('tombstoned').default(false).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.formerUserId, table.provider, table.kind, table.externalId] }),
    check('account_consolidation_import_kind', sql`${table.kind} IN ('tick','playlist','climb')`),
    check(
      'account_consolidation_import_tombstone',
      sql`${table.tombstoned} OR ${table.canonicalResourceId} IS NOT NULL`,
    ),
  ],
);

export const accountConsolidationSessionAliases = pgTable(
  'account_consolidation_session_aliases',
  {
    retiredSessionId: text('retired_session_id').primaryKey(),
    canonicalSessionId: text('canonical_session_id'),
    targetUserId: text('target_user_id').notNull(),
    mergeId: text('merge_id').notNull(),
    tombstoned: boolean('tombstoned').default(false).notNull(),
  },
  (table) => [
    check(
      'account_consolidation_session_alias_distinct',
      sql`${table.canonicalSessionId} IS NULL OR ${table.retiredSessionId} <> ${table.canonicalSessionId}`,
    ),
    check(
      'account_consolidation_session_alias_tombstone',
      sql`${table.tombstoned} OR ${table.canonicalSessionId} IS NOT NULL`,
    ),
  ],
);

export const accountConsolidationGroupAudits = pgTable('account_consolidation_group_audits', {
  mergeId: text('merge_id').primaryKey(),
  batchId: text('batch_id').notNull(),
  groupReference: text('group_reference').notNull(),
  beforeFingerprint: text('before_fingerprint').notNull(),
  afterFingerprint: text('after_fingerprint').notNull(),
  counts: jsonb('counts').$type<Readonly<Record<string, number>>>().notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }).defaultNow().notNull(),
});
