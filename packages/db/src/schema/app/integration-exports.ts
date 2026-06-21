import { pgTable, bigserial, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from '../auth/users';

// Record of a session exported to an external platform (one row per
// provider/user/session). The unique index is the dedupe key: a 'success'
// row means the session is already on the platform; failed uploads upsert
// the same row with status 'error' so a manual retry updates in place. A
// 'pending' row is an upload claim taken before calling the platform — it
// serializes concurrent exports (auto-sync vs manual) and is taken over by
// retries once stale.
//
// session_id has no FK because it can point at board_sessions.id ('party')
// or inferred_sessions.id ('inferred' — not exported yet, reserved for when
// solo sessions sync too). HealthKit dedupe still lives on the sessions
// tables' health_kit_workout_id columns; a future migration can backfill
// those into rows here (provider 'healthkit') and drop the columns.
export const integrationExports = pgTable(
  'integration_exports',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    provider: text('provider').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionType: text('session_type').notNull(), // 'party' | 'inferred'
    sessionId: text('session_id').notNull(),
    externalActivityId: text('external_activity_id'),
    // No default on purpose: a write that forgets to set status must fail
    // loudly rather than silently masquerade as a successful export.
    status: text('status').notNull(), // 'success' | 'error' | 'pending'
    error: text('error'),
    syncedAt: timestamp('synced_at').defaultNow().notNull(),
  },
  (table) => ({
    uniqueExport: uniqueIndex('unique_integration_export').on(
      table.provider,
      table.userId,
      table.sessionType,
      table.sessionId,
    ),
    userProviderIdx: index('integration_exports_user_provider_idx').on(table.userId, table.provider),
    sessionIdx: index('integration_exports_session_idx').on(table.sessionId),
  }),
);
