import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';
import { session, user } from './schema';

/** Disposable compatibility credentials; absent from the product schema. */
export const prototypeNativeRefresh = pgTable(
  'prototype_native_refresh',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    sessionId: text('session_id')
      .notNull()
      .references(() => session.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (refresh) => [index('prototype_native_refresh_session_idx').on(refresh.sessionId)],
);
