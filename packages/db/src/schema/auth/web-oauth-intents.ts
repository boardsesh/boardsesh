import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/** One-use browser flow evidence survives deletion; never stores raw state/JWE. */
export const authWebOAuthIntents = pgTable(
  'auth_web_oauth_intents',
  {
    intentHash: text('intent_hash').primaryKey(),
    provider: text('provider').$type<'apple' | 'google' | 'facebook'>().notNull(),
    flowHash: text('flow_hash').notNull(),
    actorUserId: text('actor_user_id'),
    actorLineageHash: text('actor_lineage_hash'),
    /** Consistency snapshot only: this does not make a legacy cookie current. */
    actorObservedGeneration: integer('actor_observed_generation'),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (table) => [
    check('auth_web_oauth_intents_provider', sql`${table.provider} IN ('apple','google','facebook')`),
    check(
      'auth_web_oauth_intents_hashes',
      sql`${table.intentHash} ~ '^[0-9a-f]{64}$' AND ${table.flowHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'auth_web_oauth_intents_actor',
      sql`(${table.actorUserId} IS NULL AND ${table.actorLineageHash} IS NULL AND ${table.actorObservedGeneration} IS NULL) OR (${table.actorUserId} IS NOT NULL AND length(${table.actorUserId}) > 0 AND ${table.actorLineageHash} IS NOT NULL AND ${table.actorLineageHash} ~ '^[0-9a-f]{64}$' AND ${table.actorObservedGeneration} IS NOT NULL AND ${table.actorObservedGeneration} >= 0)`,
    ),
    check(
      'auth_web_oauth_intents_deadline',
      sql`${table.expiresAt} > ${table.issuedAt} AND ${table.expiresAt} <= ${table.issuedAt} + interval '15 minutes'`,
    ),
    index('auth_web_oauth_intents_expiry_idx').on(table.expiresAt),
  ],
);

/** Strict transport nonce, distinct from durable provider-flow consumption. */
export const authWebOAuthCommands = pgTable(
  'auth_web_oauth_commands',
  {
    commandHash: text('command_hash').primaryKey(),
    operation: text('operation').$type<'intent' | 'resolve'>().notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    check('auth_web_oauth_commands_hash', sql`${table.commandHash} ~ '^[0-9a-f]{64}$'`),
    check('auth_web_oauth_commands_operation', sql`${table.operation} IN ('intent','resolve')`),
    check('auth_web_oauth_commands_deadline', sql`${table.expiresAt} > ${table.issuedAt}`),
    index('auth_web_oauth_commands_expiry_idx').on(table.expiresAt),
  ],
);
