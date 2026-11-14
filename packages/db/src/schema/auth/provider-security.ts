import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/** Private, exact-actor commands. No user FK: deletion must never revive an old intent. */
export const authProviderSecurityIntents = pgTable(
  'auth_provider_security_intents',
  {
    intentHash: text('intent_hash').primaryKey(),
    operationId: text('operation_id').notNull(),
    userId: text('user_id').notNull(),
    actorCredentialKind: text('actor_credential_kind').$type<'legacy-jwe' | 'canonical-token'>().notNull(),
    actorCredentialHash: text('actor_credential_hash').notNull(),
    recoveryTokenHash: text('recovery_token_hash').notNull(),
    browserBindingHash: text('browser_binding_hash').notNull(),
    browserVersion: integer('browser_version').notNull(),
    browserIntentHash: text('browser_intent_hash').notNull(),
    browserBindingExpiresAt: timestamp('browser_binding_expires_at', { withTimezone: true }).notNull(),
    actorSessionId: text('actor_session_id').notNull(),
    actorGeneration: integer('actor_generation').notNull(),
    actorAuthenticatedAt: timestamp('actor_authenticated_at', { withTimezone: true }),
    actorLinkGuarded: boolean('actor_link_guarded').notNull(),
    actorRequiresAccountCutoff: boolean('actor_requires_account_cutoff').notNull(),
    actorExpiresAt: timestamp('actor_expires_at', { withTimezone: true }).notNull(),
    operation: text('operation').$type<'link' | 'unlink'>().notNull(),
    provider: text('provider').$type<'google' | 'apple'>().notNull(),
    providerSubject: text('provider_subject'),
    flowHash: text('flow_hash'),
    reauthenticationFlowHash: text('reauthentication_flow_hash'),
    reauthenticationNonceHash: text('reauthentication_nonce_hash'),
    projectionId: text('projection_id').notNull(),
    normalizerVersion: text('normalizer_version').notNull(),
    writerAuthority: text('writer_authority').$type<'current-store' | 'better-auth'>().notNull(),
    writerEpoch: integer('writer_epoch').notNull(),
    phase: text('phase').$type<'pending' | 'prepared' | 'committed' | 'terminal'>().default('pending').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    preparedAt: timestamp('prepared_at', { withTimezone: true }),
    preparationTokenHash: text('preparation_token_hash'),
    reauthenticationReceiptHash: text('reauthentication_receipt_hash'),
    proposedCredentialHash: text('proposed_credential_hash'),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    /** Exact candidate bytes remain caller-held; a receipt can only acknowledge their hash. */
    candidateCredentialHash: text('candidate_credential_hash'),
    recoveryExpiresAt: timestamp('recovery_expires_at', { withTimezone: true }),
  },
  (table) => [
    check(
      'auth_provider_security_intent_hashes',
      sql`${table.intentHash} ~ '^[a-f0-9]{64}$' AND ${table.actorCredentialHash} ~ '^[a-f0-9]{64}$' AND ${table.recoveryTokenHash} ~ '^[a-f0-9]{64}$'
        AND ${table.browserBindingHash} ~ '^[a-f0-9]{64}$' AND ${table.browserIntentHash} ~ '^[a-f0-9]{64}$'
        AND (${table.flowHash} IS NULL OR ${table.flowHash} ~ '^[a-f0-9]{64}$')
        AND (${table.reauthenticationFlowHash} IS NULL OR ${table.reauthenticationFlowHash} ~ '^[a-f0-9]{64}$')
        AND (${table.reauthenticationNonceHash} IS NULL OR ${table.reauthenticationNonceHash} ~ '^[a-f0-9]{64}$')
        AND (${table.preparationTokenHash} IS NULL OR ${table.preparationTokenHash} ~ '^[a-f0-9]{64}$')
        AND (${table.reauthenticationReceiptHash} IS NULL OR ${table.reauthenticationReceiptHash} ~ '^[a-f0-9]{64}$')
        AND (${table.proposedCredentialHash} IS NULL OR ${table.proposedCredentialHash} ~ '^[a-f0-9]{64}$')
        AND (${table.candidateCredentialHash} IS NULL OR ${table.candidateCredentialHash} ~ '^[a-f0-9]{64}$')`,
    ),
    check(
      'auth_provider_security_intent_actor',
      sql`length(${table.userId}) > 0 AND length(${table.actorSessionId}) > 0 AND ${table.actorGeneration} >= 0
        AND ${table.browserVersion} >= 0 AND ${table.browserVersion} < 2147483647
        AND ${table.actorCredentialKind} IN ('legacy-jwe', 'canonical-token')
        AND (NOT ${table.actorLinkGuarded} OR ${table.actorAuthenticatedAt} IS NOT NULL)`,
    ),
    check('auth_provider_security_intent_operation', sql`${table.operation} IN ('link', 'unlink')`),
    check('auth_provider_security_intent_provider', sql`${table.provider} IN ('google', 'apple')`),
    check(
      'auth_provider_security_intent_subject',
      sql`(${table.operation} = 'link' OR ${table.providerSubject} IS NOT NULL)
        AND (${table.providerSubject} IS NULL OR length(${table.providerSubject}) > 0)`,
    ),
    check(
      'auth_provider_security_intent_authority',
      sql`${table.writerAuthority} IN ('current-store', 'better-auth') AND ${table.writerEpoch} > 0`,
    ),
    check(
      'auth_provider_security_intent_deadline',
      sql`${table.expiresAt} > ${table.issuedAt} AND ${table.expiresAt} <= ${table.issuedAt} + interval '15 minutes'
        AND ${table.expiresAt} <= ${table.actorExpiresAt} AND ${table.expiresAt} <= ${table.browserBindingExpiresAt}`,
    ),
    check(
      'auth_provider_security_intent_phase',
      sql`(${table.phase} = 'pending' AND ${table.preparedAt} IS NULL AND ${table.preparationTokenHash} IS NULL AND ${table.reauthenticationReceiptHash} IS NULL AND ${table.proposedCredentialHash} IS NULL AND ${table.consumedAt} IS NULL AND ${table.candidateCredentialHash} IS NULL AND ${table.recoveryExpiresAt} IS NULL)
        OR (${table.phase} = 'prepared' AND ${table.preparedAt} IS NOT NULL AND ${table.preparationTokenHash} IS NOT NULL AND ${table.reauthenticationReceiptHash} IS NOT NULL AND ${table.providerSubject} IS NOT NULL AND ${table.consumedAt} IS NULL AND ${table.candidateCredentialHash} IS NULL AND ${table.recoveryExpiresAt} IS NULL)
        OR (${table.phase} = 'committed' AND ${table.preparedAt} IS NOT NULL AND ${table.preparationTokenHash} IS NOT NULL AND ${table.reauthenticationReceiptHash} IS NOT NULL AND ${table.providerSubject} IS NOT NULL AND ${table.consumedAt} IS NOT NULL AND ${table.candidateCredentialHash} IS NOT NULL AND ${table.recoveryExpiresAt} IS NOT NULL)
        OR (${table.phase} = 'terminal' AND ${table.consumedAt} IS NOT NULL AND ${table.candidateCredentialHash} IS NULL AND ${table.recoveryExpiresAt} IS NULL)`,
    ),
    check(
      'auth_provider_security_intent_candidate',
      sql`${table.recoveryExpiresAt} IS NULL OR (${table.recoveryExpiresAt} > ${table.consumedAt} AND ${table.recoveryExpiresAt} <= ${table.expiresAt} AND ${table.recoveryExpiresAt} <= ${table.consumedAt} + interval '2 minutes')`,
    ),
    uniqueIndex('auth_provider_security_operation_idx').on(table.operationId),
    uniqueIndex('auth_provider_security_flow_idx').on(table.provider, table.flowHash),
    uniqueIndex('auth_provider_security_reauthentication_flow_idx').on(table.reauthenticationFlowHash),
    uniqueIndex('auth_provider_security_reauthentication_nonce_idx').on(table.reauthenticationNonceHash),
    index('auth_provider_security_expiry_idx').on(table.expiresAt),
    index('auth_provider_security_recovery_expiry_idx').on(table.recoveryExpiresAt),
  ],
);

/** A proof of actual reauthentication authorizes only its one exact actor/operation intent. */
export const authProviderReauthenticationReceipts = pgTable(
  'auth_provider_reauthentication_receipts',
  {
    receiptHash: text('receipt_hash').primaryKey(),
    intentHash: text('intent_hash').notNull(),
    method: text('method').$type<'password' | 'google-auth-time'>().notNull(),
    proofBindingHash: text('proof_binding_hash').notNull(),
    proofProviderSubject: text('proof_provider_subject'),
    authenticatedAt: timestamp('authenticated_at', { withTimezone: true }).notNull(),
    proofExpiresAt: timestamp('proof_expires_at', { withTimezone: true }).notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (table) => [
    check(
      'auth_provider_reauthentication_hashes',
      sql`${table.receiptHash} ~ '^[a-f0-9]{64}$' AND ${table.intentHash} ~ '^[a-f0-9]{64}$' AND ${table.proofBindingHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'auth_provider_reauthentication_method',
      sql`(${table.method} = 'password' AND ${table.proofProviderSubject} IS NULL)
        OR (${table.method} = 'google-auth-time' AND ${table.proofProviderSubject} IS NOT NULL AND length(${table.proofProviderSubject}) > 0)`,
    ),
    check(
      'auth_provider_reauthentication_deadline',
      sql`${table.authenticatedAt} <= ${table.issuedAt} AND ${table.expiresAt} > ${table.issuedAt}
        AND ${table.expiresAt} <= ${table.authenticatedAt} + interval '5 minutes' AND ${table.expiresAt} <= ${table.proofExpiresAt}`,
    ),
    uniqueIndex('auth_provider_reauthentication_active_idx')
      .on(table.intentHash)
      .where(sql`${table.consumedAt} IS NULL`),
    index('auth_provider_reauthentication_expiry_idx').on(table.expiresAt),
  ],
);
