import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';
import { boardSessions } from './sessions';
import { users } from '../auth/users';

// APNs device tokens for ActivityKit Live Activity push updates
export const activityPushTokens = pgTable(
  'activity_push_tokens',
  {
    token: text('token').primaryKey(),
    bundleId: text('bundle_id').notNull().default('com.boardsesh.app'),
    sessionId: text('session_id')
      .references(() => boardSessions.id, { onDelete: 'cascade' })
      .notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    sessionIdx: index('activity_push_tokens_session_idx').on(table.sessionId),
    userIdx: index('activity_push_tokens_user_idx').on(table.userId),
    // Supports the cluster-wide stale-token sweep in `apns/cleanup.ts`
    // (`DELETE WHERE updated_at < cutoff`). The per-session eviction in
    // `registerActivityPushToken` is served by the existing
    // (session_id) index at the small row counts involved (≤8 per session).
    updatedAtIdx: index('activity_push_tokens_updated_at_idx').on(table.updatedAt),
  }),
);

// Type exports
export type ActivityPushToken = typeof activityPushTokens.$inferSelect;
export type NewActivityPushToken = typeof activityPushTokens.$inferInsert;
