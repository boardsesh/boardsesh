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

/** Durable after user deletion and receipt cleanup; generations never restart. */
export const authPasswordRecoveryState = pgTable(
  'auth_password_recovery_state',
  {
    userId: text('user_id').notNull(),
    purpose: text('purpose').$type<'password-reset'>().notNull(),
    generation: integer('generation').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.purpose] }),
    check('auth_password_recovery_state_purpose', sql`${table.purpose} = 'password-reset'`),
    check('auth_password_recovery_state_generation', sql`${table.generation} >= 0`),
  ],
);

/** No users FK: original identity/deadline evidence survives deletion. */
export const authPasswordRecoveryTokens = pgTable(
  'auth_password_recovery_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: text('user_id').notNull(),
    purpose: text('purpose').$type<'password-reset'>().notNull(),
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
      foreignColumns: [authPasswordRecoveryState.userId, authPasswordRecoveryState.purpose],
      name: 'auth_password_recovery_tokens_state_fk',
    }).onDelete('restrict'),
    uniqueIndex('auth_password_recovery_active_user_idx')
      .on(table.userId, table.purpose)
      .where(sql`${table.consumedAt} IS NULL AND ${table.supersededAt} IS NULL`),
    index('auth_password_recovery_expiry_idx').on(table.expiresAt),
    check('auth_password_recovery_tokens_purpose', sql`${table.purpose} = 'password-reset'`),
    check('auth_password_recovery_token_hash', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'auth_password_recovery_token_generations',
      sql`${table.subjectGeneration} >= 0 AND ${table.issuanceGeneration} > 0`,
    ),
    check(
      'auth_password_recovery_token_address',
      sql`length(${table.deliveredEmail}) > 0 AND length(${table.normalizedEmail}) > 0`,
    ),
    check(
      'auth_password_recovery_token_deadline',
      sql`${table.expiresAt} > ${table.issuedAt} AND ${table.expiresAt} <= ${table.issuedAt} + interval '1 hour'`,
    ),
    check('auth_password_recovery_token_terminal', sql`${table.consumedAt} IS NULL OR ${table.supersededAt} IS NULL`),
  ],
);
