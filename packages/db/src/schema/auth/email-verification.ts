import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/** No users FK or expiry: deletion/receipt cleanup must not reset a purpose generation. */
export const authEmailVerificationState = pgTable(
  'auth_email_verification_state',
  {
    userId: text('user_id').notNull(),
    purpose: text('purpose').$type<'email-verification'>().notNull(),
    generation: integer('generation').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.purpose] }),
    check('auth_email_verification_state_purpose', sql`${table.purpose} = 'email-verification'`),
    check('auth_email_verification_state_generation', sql`${table.generation} >= 0`),
  ],
);

/** Immutable binding columns; application updates only terminal timestamps. */
export const authEmailVerificationTokens = pgTable(
  'auth_email_verification_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: text('user_id').notNull(),
    purpose: text('purpose').$type<'email-verification'>().notNull(),
    deliveredEmail: text('delivered_email').notNull(),
    normalizedEmail: text('normalized_email').notNull(),
    subjectGeneration: integer('subject_generation').notNull(),
    issuanceGeneration: integer('issuance_generation').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.userId, table.purpose],
      foreignColumns: [authEmailVerificationState.userId, authEmailVerificationState.purpose],
      name: 'auth_email_verification_tokens_state_fk',
    }).onDelete('restrict'),
    uniqueIndex('auth_email_verification_active_user_idx')
      .on(table.userId, table.purpose)
      .where(sql`${table.consumedAt} IS NULL AND ${table.supersededAt} IS NULL`),
    index('auth_email_verification_expiry_idx').on(table.expiresAt),
    check('auth_email_verification_tokens_purpose', sql`${table.purpose} = 'email-verification'`),
    check('auth_email_verification_token_hash', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'auth_email_verification_token_generations',
      sql`${table.subjectGeneration} >= 0 AND ${table.issuanceGeneration} > 0`,
    ),
    check(
      'auth_email_verification_token_address',
      sql`length(${table.deliveredEmail}) > 0 AND length(${table.normalizedEmail}) > 0`,
    ),
    check(
      'auth_email_verification_token_deadline',
      sql`${table.expiresAt} > ${table.issuedAt} AND ${table.expiresAt} <= ${table.issuedAt} + interval '24 hours'`,
    ),
    check('auth_email_verification_token_terminal', sql`${table.consumedAt} IS NULL OR ${table.supersededAt} IS NULL`),
  ],
);
