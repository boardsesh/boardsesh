import { bigserial, check, date, index, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from '../auth/users';

/**
 * Every analytics consent answer a signed-in climber has given, append-only.
 *
 * The newest row per user (by `decided_at`, then `id`) is the account's current
 * answer; the older rows are the record of when consent was given and withdrawn
 * (GDPR Art. 7(1) asks us to be able to show that). `decided_at` is the
 * server's clock, never the client's. The merge with a device's own answer
 * lives in `@boardsesh/consent` (`resolveConsent`); see
 * `docs/analytics-consent.md`.
 *
 * Not a column on `user_profiles`: a profile row is not guaranteed to exist,
 * and its `updated_at` feeds the setter sitemap's `lastmod`.
 */
export const userAnalyticsConsentEvents = pgTable(
  'user_analytics_consent_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `granted` | `denied`. */
    analytics: text('analytics').notNull(),
    /** `CONSENT_VERSION` the client asked under. */
    version: integer('version').notNull(),
    /** `web` | `ios` | `android`: where the answer was given. */
    source: text('source').notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('user_analytics_consent_events_user_decided_idx').on(table.userId, table.decidedAt.desc()),
    check('user_analytics_consent_events_analytics_check', sql`${table.analytics} IN ('granted', 'denied')`),
    check('user_analytics_consent_events_source_check', sql`${table.source} IN ('web', 'ios', 'android')`),
    check('user_analytics_consent_events_version_check', sql`${table.version} > 0`),
  ],
);

export type UserAnalyticsConsentEvent = typeof userAnalyticsConsentEvents.$inferSelect;
export type NewUserAnalyticsConsentEvent = typeof userAnalyticsConsentEvents.$inferInsert;

/**
 * One row per signed-in climber per UTC day per platform they used Boardsesh on.
 *
 * The first-party active-user count: written by the backend's authenticated
 * request path whatever the climber's analytics consent (legitimate interest:
 * service statistics, no third party), so MAU survives opt-outs. The daily
 * snapshot job reads it and sends PostHog counts only; a retention job deletes
 * rows older than 13 months. `platform` is `web` | `ios` | `android` |
 * `unknown` (a client that sent no platform header).
 */
export const userActivityDays = pgTable(
  'user_activity_days',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    platform: text('platform').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.day, table.platform] }),
    index('user_activity_days_day_idx').on(table.day),
    check('user_activity_days_platform_check', sql`${table.platform} IN ('web', 'ios', 'android', 'unknown')`),
  ],
);

export type UserActivityDay = typeof userActivityDays.$inferSelect;
export type NewUserActivityDay = typeof userActivityDays.$inferInsert;
