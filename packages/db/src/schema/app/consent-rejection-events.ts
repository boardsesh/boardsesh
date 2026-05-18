import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Anonymous, aggregate-only record of consent rejections.
 *
 * Recorded when a user picks a state that denies both analytics and error
 * monitoring — either by clicking Reject on the banner, by saving the
 * customize dialog with both toggles off, or by flipping a previously
 * granted choice back to denied from /settings.
 *
 * Intentionally carries no PII — no userId, no IP, no fingerprint. The
 * lawful basis is legitimate interest (measuring whether our consent flow
 * is working). If we ever need per-user history we'd add it as a separate
 * authenticated table.
 */
export const consentRejectionEvents = pgTable('consent_rejection_events', {
  id: uuid('id').notNull().primaryKey().defaultRandom(),
  source: text('source').notNull(), // 'banner' | 'dialog' | 'settings' — kept as text so adding a source doesn't need a migration
  recordedAt: timestamp('recorded_at').defaultNow().notNull(),
});

export type ConsentRejectionEventRow = typeof consentRejectionEvents.$inferSelect;
