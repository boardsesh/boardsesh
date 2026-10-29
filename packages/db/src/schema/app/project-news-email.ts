import { bigserial, boolean, check, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from '../auth/users';

/**
 * Every "Email me project news" answer a climber has given, append-only.
 *
 * The newest row per user (by `id`, the insert order under the per-user lock)
 * is the current answer; no row means never asked, which counts as off. The
 * older rows are the record of when the climber opted in and out: the Spam Act
 * and GDPR Art. 7(1) both ask us to be able to show consent. `decided_at` is
 * the server's clock, never the client's. A row is only written when the answer
 * changes, so a looping client or a repeated unsubscribe click adds nothing.
 *
 * `source` is where the answer was given: `web`, `ios` or `android` for the
 * Settings switch, `email_link` for the signed unsubscribe link in an email.
 * See `docs/project-news-email.md`.
 */
export const userProjectNewsEmailEvents = pgTable(
  'user_project_news_email_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    subscribed: boolean('subscribed').notNull(),
    source: text('source').notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('user_project_news_email_events_user_id_idx').on(table.userId, table.id.desc()),
    check(
      'user_project_news_email_events_source_check',
      sql`${table.source} IN ('web', 'ios', 'android', 'email_link')`,
    ),
  ],
);

export type UserProjectNewsEmailEvent = typeof userProjectNewsEmailEvents.$inferSelect;
export type NewUserProjectNewsEmailEvent = typeof userProjectNewsEmailEvents.$inferInsert;
