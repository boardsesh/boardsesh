import { sql } from 'drizzle-orm';
import { boolean, index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from '../auth/users';

/**
 * One row per (user, board) link: the fences and bookkeeping that let a
 * background worker sync a climber's provider account without racing the
 * account being relinked, unlinked or synced by someone else
 * (docs/background-workers.md, "Provider sync families").
 *
 * - `link_generation` changes on every link, relink and unlink. A sync job
 *   carries the generation it was queued for; every write batch re-checks it
 *   under `FOR SHARE`, so a job queued before a relink never writes the old
 *   account's data onto the new link.
 * - `linked = false` after an unlink. The row survives the credential so a
 *   queued job still finds a generation to compare against (and fails it).
 * - `pending_run_id` is the queued-or-running interactive run a "Sync now"
 *   coalesces onto, instead of queueing a second one.
 * - `active_run_id` + `active_lease_until` is the credential lease: which run is
 *   writing this account right now, and until when. A lease past its time is
 *   free to take.
 * - `notify_requester` records that a manual request arrived while another run
 *   held the lease, so a later notification can tell the climber it finished.
 *
 * Kept apart from `aurora_credentials` so a credential row can be deleted and
 * re-inserted without losing the generation that fences stale jobs.
 */
export const providerSyncControls = pgTable(
  'provider_sync_controls',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    boardType: text('board_type').notNull(),
    linkGeneration: uuid('link_generation')
      .default(sql`gen_random_uuid()`)
      .notNull(),
    linked: boolean('linked').default(true).notNull(),
    pendingRunId: uuid('pending_run_id'),
    notifyRequester: boolean('notify_requester').default(false).notNull(),
    activeRunId: uuid('active_run_id'),
    activeLeaseUntil: timestamp('active_lease_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.boardType] }),
    // The reconciler walks rows that still point at a run; almost none do.
    index('provider_sync_controls_active_run_idx')
      .on(table.activeRunId)
      .where(sql`${table.activeRunId} IS NOT NULL`),
    index('provider_sync_controls_pending_run_idx')
      .on(table.pendingRunId)
      .where(sql`${table.pendingRunId} IS NOT NULL`),
  ],
);

export type ProviderSyncControl = typeof providerSyncControls.$inferSelect;
