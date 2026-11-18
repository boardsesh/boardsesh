import { and, gte, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { integer, pgTable, primaryKey, text, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users';
import { oauthClient, oauthConnections } from './partner-oauth';

/** Independent proof: legacy users.emailVerified may have been stamped without email ownership. */
export const partnerDeveloperEmails = pgTable('partner_developer_emails', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  tokenHash: text('token_hash'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
});

export const PARTNER_CONNECTION_NOTICE_MAX_ATTEMPTS = 10;

/** Written with first successful code redemption; SMTP never participates in token issuance. */
export const partnerConnectionNotices = pgTable(
  'partner_connection_notices',
  {
    connectionId: text('connection_id')
      .notNull()
      .references(() => oauthConnections.id, { onDelete: 'cascade' }),
    generation: integer('generation').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
    attempts: integer('attempts').default(0).notNull(),
  },
  (table) => ({
    identity: primaryKey({ columns: [table.connectionId, table.generation] }),
    // Index DDL requires a literal threshold, not a prepared-statement parameter.
    pending: index('partner_connection_notices_pending_idx')
      .on(table.nextAttemptAt)
      .where(
        and(isNull(table.deliveredAt), lt(table.attempts, sql.raw(String(PARTNER_CONNECTION_NOTICE_MAX_ATTEMPTS))))!,
      ),
    deliveredRetention: index('partner_connection_notices_delivered_retention_idx')
      .on(table.deliveredAt)
      .where(isNotNull(table.deliveredAt)),
    failedRetention: index('partner_connection_notices_failed_retention_idx')
      .on(table.nextAttemptAt)
      .where(
        and(isNull(table.deliveredAt), gte(table.attempts, sql.raw(String(PARTNER_CONNECTION_NOTICE_MAX_ATTEMPTS))))!,
      ),
  }),
);
