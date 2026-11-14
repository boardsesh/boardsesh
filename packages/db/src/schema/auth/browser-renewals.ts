import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/** Hash-only renewal evidence. No user FK or credential bytes: owner deletion
 * must remain a refusal, and an ACK cannot reconstruct a missing source. */
export const authBrowserRenewals = pgTable(
  'auth_browser_renewals',
  {
    operationHash: text('operation_hash').primaryKey(),
    preparationHash: text('preparation_hash').notNull(),
    nonceHash: text('nonce_hash').notNull(),
    bindingId: text('binding_id').notNull(),
    bindingVersion: integer('binding_version').notNull(),
    intentRevision: integer('intent_revision').notNull(),
    actorCredentialHash: text('actor_credential_hash').notNull(),
    userId: text('user_id').notNull(),
    authSessionId: text('auth_session_id').notNull(),
    projectionId: text('projection_id').notNull(),
    normalizerVersion: text('normalizer_version').notNull(),
    authority: text('authority').notNull(),
    epoch: integer('epoch').notNull(),
    /** Strictly parsed metadata only: UID/SID/provenance/cursors/deadlines. */
    preparation: jsonb('preparation').notNull(),
    metadataHash: text('metadata_hash').notNull(),
    preparedAt: timestamp('prepared_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    candidateHash: text('candidate_hash'),
    resultVersion: integer('result_version'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    acknowledgeUntil: timestamp('acknowledge_until', { withTimezone: true }),
  },
  (table) => [
    check(
      'auth_browser_renewals_hashes',
      sql`${table.operationHash} ~ '^[a-f0-9]{64}$' AND ${table.preparationHash} ~ '^[a-f0-9]{64}$' AND ${table.nonceHash} ~ '^[a-f0-9]{64}$' AND ${table.bindingId} ~ '^[a-f0-9]{64}$' AND ${table.actorCredentialHash} ~ '^[a-f0-9]{64}$' AND ${table.metadataHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'auth_browser_renewals_versions',
      sql`${table.bindingVersion} >= 0 AND ${table.intentRevision} >= 0 AND ${table.epoch} > 0`,
    ),
    check('auth_browser_renewals_authority', sql`${table.authority} IN ('current-store', 'better-auth')`),
    check(
      'auth_browser_renewals_deadline',
      sql`${table.expiresAt} > ${table.preparedAt} AND ${table.expiresAt} <= ${table.preparedAt} + interval '1 minute'`,
    ),
    check(
      'auth_browser_renewals_result',
      sql`(${table.candidateHash} IS NULL AND ${table.resultVersion} IS NULL AND ${table.completedAt} IS NULL AND ${table.acknowledgeUntil} IS NULL) OR (${table.candidateHash} IS NOT NULL AND ${table.candidateHash} ~ '^[a-f0-9]{64}$' AND ${table.resultVersion} IS NOT NULL AND ${table.resultVersion} = ${table.bindingVersion} + 1 AND ${table.completedAt} IS NOT NULL AND ${table.acknowledgeUntil} IS NOT NULL AND ${table.acknowledgeUntil} > ${table.completedAt} AND ${table.acknowledgeUntil} <= ${table.completedAt} + interval '5 minutes')`,
    ),
    index('auth_browser_renewals_binding_idx').on(table.bindingId, table.bindingVersion),
    index('auth_browser_renewals_expiry_idx').on(table.expiresAt),
  ],
);
