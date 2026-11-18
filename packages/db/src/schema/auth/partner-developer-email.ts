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
    pending: index('partner_connection_notices_pending_idx').on(table.nextAttemptAt),
  }),
);
