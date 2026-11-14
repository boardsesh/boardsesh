import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Account-bound confirmation for a first password. Email is represented only
 * by a purpose/authority/UID-bound HMAC. No raw credential, mail token or
 * plaintext password is stored. User deletion cannot reassign this receipt.
 */
export const authFirstPasswordChallenges = pgTable(
  'auth_first_password_challenges',
  {
    challengeHash: text('challenge_hash').primaryKey(),
    purpose: text('purpose').$type<'first-password'>().default('first-password').notNull(),
    operationId: text('operation_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emailBindingHash: text('email_binding_hash').notNull(),
    confirmationTokenHash: text('confirmation_token_hash').notNull(),
    recoveryTokenHash: text('recovery_token_hash').notNull(),
    actorCredentialKind: text('actor_credential_kind').$type<'legacy-jwe' | 'canonical-token'>().notNull(),
    actorCredentialHash: text('actor_credential_hash').notNull(),
    actorSessionId: text('actor_session_id').notNull(),
    actorGeneration: integer('actor_generation').notNull(),
    actorAuthenticatedAt: timestamp('actor_authenticated_at', { withTimezone: true }),
    actorLinkGuarded: boolean('actor_link_guarded').notNull(),
    actorRequiresAccountCutoff: boolean('actor_requires_account_cutoff').notNull(),
    actorExpiresAt: timestamp('actor_expires_at', { withTimezone: true }).notNull(),
    browserBindingHash: text('browser_binding_hash').notNull(),
    browserVersion: integer('browser_version').notNull(),
    browserIntentHash: text('browser_intent_hash').notNull(),
    browserBindingExpiresAt: timestamp('browser_binding_expires_at', { withTimezone: true }).notNull(),
    projectionId: text('projection_id').notNull(),
    normalizerVersion: text('normalizer_version').notNull(),
    writerAuthority: text('writer_authority').$type<'current-store' | 'better-auth'>().notNull(),
    writerEpoch: integer('writer_epoch').notNull(),
    phase: text('phase').$type<'pending' | 'prepared' | 'committed' | 'terminal'>().default('pending').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Bcrypt only while prepared; cleared after finalization or cancellation. */
    pendingPasswordHash: text('pending_password_hash'),
    preparedAt: timestamp('prepared_at', { withTimezone: true }),
    preparationTokenHash: text('preparation_token_hash'),
    proposedCredentialHash: text('proposed_credential_hash'),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    candidateCredentialHash: text('candidate_credential_hash'),
    recoveryExpiresAt: timestamp('recovery_expires_at', { withTimezone: true }),
  },
  (table) => [
    check('auth_first_password_purpose', sql`${table.purpose} = 'first-password'`),
    check(
      'auth_first_password_bcrypt',
      sql`${table.pendingPasswordHash} IS NULL
        OR ${table.pendingPasswordHash} ~ '^[$]2[aby][$](0[4-9]|[12][0-9]|3[01])[$][./A-Za-z0-9]{53}$'`,
    ),
    check(
      'auth_first_password_hashes',
      sql`${table.challengeHash} ~ '^[a-f0-9]{64}$' AND ${table.emailBindingHash} ~ '^[a-f0-9]{64}$'
        AND ${table.confirmationTokenHash} ~ '^[a-f0-9]{64}$' AND ${table.recoveryTokenHash} ~ '^[a-f0-9]{64}$'
        AND ${table.actorCredentialHash} ~ '^[a-f0-9]{64}$' AND ${table.browserBindingHash} ~ '^[a-f0-9]{64}$'
        AND ${table.browserIntentHash} ~ '^[a-f0-9]{64}$'
        AND (${table.preparationTokenHash} IS NULL OR ${table.preparationTokenHash} ~ '^[a-f0-9]{64}$')
        AND (${table.proposedCredentialHash} IS NULL OR ${table.proposedCredentialHash} ~ '^[a-f0-9]{64}$')
        AND (${table.candidateCredentialHash} IS NULL OR ${table.candidateCredentialHash} ~ '^[a-f0-9]{64}$')`,
    ),
    check(
      'auth_first_password_actor',
      sql`length(${table.userId}) > 0 AND length(${table.actorSessionId}) > 0
        AND ${table.actorGeneration} >= 0 AND ${table.actorGeneration} < 2147483647
        AND ${table.browserVersion} >= 0 AND ${table.browserVersion} < 2147483647
        AND ${table.actorCredentialKind} IN ('legacy-jwe', 'canonical-token')
        AND (NOT ${table.actorLinkGuarded} OR ${table.actorAuthenticatedAt} IS NOT NULL)`,
    ),
    check(
      'auth_first_password_authority',
      sql`${table.writerAuthority} IN ('current-store', 'better-auth') AND ${table.writerEpoch} > 0
        AND length(${table.projectionId}) > 0 AND length(${table.normalizerVersion}) > 0`,
    ),
    check(
      'auth_first_password_deadline',
      sql`${table.expiresAt} > ${table.issuedAt} AND ${table.expiresAt} <= ${table.issuedAt} + interval '5 minutes'
        AND ${table.expiresAt} <= ${table.actorExpiresAt} AND ${table.expiresAt} <= ${table.browserBindingExpiresAt}
        AND (${table.preparedAt} IS NULL OR (${table.preparedAt} >= ${table.issuedAt} AND ${table.preparedAt} < ${table.expiresAt}))
        AND (${table.consumedAt} IS NULL OR (${table.consumedAt} >= ${table.issuedAt}
          AND (${table.phase} = 'terminal' OR ${table.consumedAt} <= ${table.expiresAt})))`,
    ),
    check(
      'auth_first_password_phase',
      sql`(${table.phase} = 'pending' AND ${table.pendingPasswordHash} IS NULL AND ${table.preparedAt} IS NULL
          AND ${table.preparationTokenHash} IS NULL AND ${table.proposedCredentialHash} IS NULL
          AND ${table.consumedAt} IS NULL AND ${table.candidateCredentialHash} IS NULL AND ${table.recoveryExpiresAt} IS NULL)
        OR (${table.phase} = 'prepared' AND ${table.pendingPasswordHash} IS NOT NULL AND ${table.preparedAt} IS NOT NULL
          AND ${table.preparationTokenHash} IS NOT NULL AND ${table.consumedAt} IS NULL
          AND ${table.candidateCredentialHash} IS NULL AND ${table.recoveryExpiresAt} IS NULL)
        OR (${table.phase} = 'committed' AND ${table.pendingPasswordHash} IS NULL AND ${table.preparedAt} IS NOT NULL
          AND ${table.preparationTokenHash} IS NOT NULL AND ${table.consumedAt} IS NOT NULL
          AND ${table.candidateCredentialHash} IS NOT NULL AND ${table.recoveryExpiresAt} IS NOT NULL)
        OR (${table.phase} = 'terminal' AND ${table.pendingPasswordHash} IS NULL AND ${table.preparedAt} IS NULL
          AND ${table.preparationTokenHash} IS NULL AND ${table.proposedCredentialHash} IS NULL
          AND ${table.consumedAt} IS NOT NULL AND ${table.candidateCredentialHash} IS NULL AND ${table.recoveryExpiresAt} IS NULL)`,
    ),
    check(
      'auth_first_password_candidate',
      sql`(${table.phase} NOT IN ('prepared', 'committed')
          OR (${table.actorCredentialKind} = 'canonical-token' AND ${table.proposedCredentialHash} IS NOT NULL)
          OR (${table.actorCredentialKind} = 'legacy-jwe' AND ${table.proposedCredentialHash} IS NULL))
        AND (${table.recoveryExpiresAt} IS NULL OR (${table.recoveryExpiresAt} > ${table.consumedAt}
          AND ${table.recoveryExpiresAt} <= ${table.expiresAt}
          AND ${table.recoveryExpiresAt} <= ${table.consumedAt} + interval '2 minutes'))`,
    ),
    uniqueIndex('auth_first_password_operation_idx').on(table.operationId),
    uniqueIndex('auth_first_password_active_user_idx')
      .on(table.userId)
      .where(sql`${table.consumedAt} IS NULL`),
    index('auth_first_password_expiry_idx').on(table.expiresAt),
    index('auth_first_password_recovery_expiry_idx').on(table.recoveryExpiresAt),
  ],
);
