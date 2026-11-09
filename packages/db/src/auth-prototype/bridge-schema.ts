import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// Prototype lifecycle state only. None of these tables enters production schema exports.
export const prototypeUserCutoff = pgTable('prototype_user_cutoff', {
  userId: text('user_id').primaryKey(),
  revokedThrough: timestamp('revoked_through', { withTimezone: true }).notNull(),
  generation: integer('generation').default(1).notNull(),
});

export const prototypeLegacyLineage = pgTable('prototype_legacy_lineage', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  sessionId: text('session_id').notNull(),
  originalAuthenticatedAt: timestamp('original_authenticated_at', { withTimezone: true }),
  originalExpiresAt: timestamp('original_expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});
