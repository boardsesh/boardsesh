import { integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Prototype-owned lifecycle sidecars. These tables belong only to the disposable
 * BA-01 database and are absent from the production migration registry.
 */
export const prototypeOAuthConnection = pgTable(
  'prototype_oauth_connection',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    clientId: text('client_id').notNull(),
    generation: integer('generation').notNull().default(0),
    revokedAt: timestamp('revoked_at'),
  },
  (connection) => [
    uniqueIndex('prototype_oauth_connection_user_client_unique').on(connection.userId, connection.clientId),
  ],
);

export const prototypeOAuthInteraction = pgTable('prototype_oauth_interaction', {
  digest: text('digest').primaryKey(),
  userId: text('user_id').notNull(),
  sessionId: text('session_id').notNull(),
  clientId: text('client_id').notNull(),
  connectionGeneration: integer('connection_generation').notNull(),
  createdAt: timestamp('created_at').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  consumedAt: timestamp('consumed_at'),
});
