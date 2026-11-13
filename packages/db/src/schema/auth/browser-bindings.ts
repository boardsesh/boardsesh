import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// No users FK: a deleted owner must remain a refused selection, never silently
// become an anonymous binding that can fall through to an older cookie.
export const authBrowserBindings = pgTable(
  'auth_browser_bindings',
  {
    id: text('id').primaryKey(),
    version: integer('version').default(0).notNull(),
    intentRevision: integer('intent_revision').default(0).notNull(),
    userId: text('user_id'),
    credentialKind: text('credential_kind'),
    authSessionId: text('auth_session_id'),
    generation: integer('generation'),
    authenticatedAt: timestamp('authenticated_at', { withTimezone: true }),
    credentialExpiresAt: timestamp('credential_expires_at', { withTimezone: true }),
    requiresAccountCutoff: boolean('requires_account_cutoff').default(false).notNull(),
    linkGuarded: boolean('link_guarded').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    check('auth_browser_binding_digest', sql`${table.id} ~ '^[a-f0-9]{64}$'`),
    check('auth_browser_binding_versions', sql`${table.version} >= 0 AND ${table.intentRevision} >= 0`),
    check('auth_browser_binding_deadline', sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      'auth_browser_binding_selection',
      sql`(
    ${table.userId} IS NULL AND ${table.credentialKind} IS NULL AND ${table.authSessionId} IS NULL AND ${table.generation} IS NULL
    AND ${table.authenticatedAt} IS NULL AND ${table.credentialExpiresAt} IS NULL
    AND NOT ${table.requiresAccountCutoff} AND NOT ${table.linkGuarded}
  ) OR (
    ${table.userId} IS NOT NULL AND ${table.credentialKind} IS NOT NULL AND ${table.credentialKind} IN ('legacy-jwe', 'canonical-token') AND ${table.authSessionId} IS NOT NULL AND ${table.generation} IS NOT NULL AND ${table.generation} >= 0
    AND ${table.credentialExpiresAt} IS NOT NULL
    AND (NOT ${table.linkGuarded} OR ${table.authenticatedAt} IS NOT NULL)
  )`,
    ),
    index('auth_browser_binding_expiry_idx').on(table.expiresAt),
  ],
);

export const authBrowserIntents = pgTable(
  'auth_browser_intents',
  {
    id: text('id').primaryKey(),
    bindingId: text('binding_id')
      .notNull()
      .references(() => authBrowserBindings.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    expectedVersion: integer('expected_version').notNull(),
    operation: text('operation').notNull(),
    projectionId: text('projection_id').notNull(),
    authority: text('authority').notNull(),
    epoch: integer('epoch').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    resultVersion: integer('result_version'),
    // Preserve the physical order of the already-reviewed two-step schema.
    formatVersion: integer('format_version').default(1).notNull(),
    actorCredentialHash: text('actor_credential_hash'),
    resultCredentialHash: text('result_credential_hash'),
  },
  (table) => [
    check('auth_browser_intent_digest', sql`${table.id} ~ '^[a-f0-9]{64}$'`),
    check(
      'auth_browser_intent_versions',
      sql`${table.revision} > 0 AND ${table.expectedVersion} >= 0 AND ${table.epoch} > 0`,
    ),
    check('auth_browser_intent_operation', sql`${table.operation} IN ('login', 'logout', 'replacement')`),
    check('auth_browser_intent_format', sql`${table.formatVersion} IN (1, 2)`),
    check(
      'auth_browser_intent_actor_hash',
      sql`${table.actorCredentialHash} IS NULL OR ${table.actorCredentialHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'auth_browser_intent_result_hash',
      sql`${table.resultCredentialHash} IS NULL OR ${table.resultCredentialHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check('auth_browser_intent_authority', sql`${table.authority} IN ('current-store', 'better-auth')`),
    check('auth_browser_intent_deadline', sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      'auth_browser_intent_consumption',
      sql`(${table.consumedAt} IS NULL AND ${table.resultVersion} IS NULL)
    OR (${table.consumedAt} IS NOT NULL AND ${table.resultVersion} IS NOT NULL AND ${table.resultVersion} = ${table.expectedVersion} + 1)`,
    ),
    index('auth_browser_intent_binding_idx').on(table.bindingId),
    index('auth_browser_intent_expiry_idx').on(table.expiresAt),
  ],
);
