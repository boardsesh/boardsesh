import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * A provider may prune an expired consumed refresh row while its rolling grant
 * still has live descendants. Keep the hashed ancestry independently of those
 * rows; token expiry alone is never permission to forget consumed-token reuse.
 * This sidecar exists only in disposable BA-01 databases.
 */
export const prototypeOAuthRefreshAncestor = pgTable(
  'prototype_oauth_refresh_ancestor',
  {
    tokenHash: text('token_hash').primaryKey(),
    clientId: text('client_id').notNull(),
    userId: text('user_id').notNull(),
    authorizationCodeId: text('authorization_code_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (ancestor) => [
    index('prototype_oauth_refresh_ancestor_family_idx').on(
      ancestor.clientId,
      ancestor.userId,
      ancestor.authorizationCodeId,
    ),
  ],
);
