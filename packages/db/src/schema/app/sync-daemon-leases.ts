import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Best-effort single-active-instance lease for the long-running sync daemons
 * (`aurora-sync daemon`, `kilter-sync daemon`). One row per daemon name; the
 * holder renews `heartbeat_at` on a timer, and any instance may take the lease
 * over once the heartbeat is older than the TTL.
 *
 * This is an OPTIMISATION, not mutual exclusion. A TTL lease carries no fencing
 * token: if the holder stalls past the TTL (GC pause, a long await inside a
 * cycle, a network partition to Postgres, a suspended container) another
 * instance legitimately takes over while the original is still running and
 * still believes it holds the lease. The TTL bounds that window; it does not
 * close it. Correctness therefore has to come from each individual write being
 * safe under genuine concurrency — see claimNextCredentialForSync (queries/sync/
 * claim-credential.ts), claimSharedSyncSlot (queries/sync/shared-sync-cooldown.ts)
 * and the deterministic setter-notification uuid (queries/sync/
 * setter-notification-uuid.ts). What the lease buys is that the common case —
 * a rolling deploy with two healthy containers — stops doing everything twice.
 *
 * A row-with-TTL rather than `pg_try_advisory_lock` because application traffic
 * goes through PgBouncer in transaction-pooling mode (docs/operations/database-portability.md),
 * where a session-scoped advisory lock leaks onto a server connection the
 * holder no longer owns. `postgres-js`'s `idle_timeout` reaping and drizzle's
 * round-robin over the pool break it independently of the pooler. This table
 * carries no session state, so it works through any pooler and is greppable by
 * an operator with a plain SELECT.
 */
export const syncDaemonLeases = pgTable('sync_daemon_leases', {
  /** Stable daemon identity, e.g. 'aurora-sync' / 'kilter-sync'. */
  daemonName: text('daemon_name').primaryKey(),
  /** Per-process id (a uuid minted at boot); identifies the current holder. */
  holderId: text('holder_id').notNull(),
  /** When the CURRENT holder first took the lease (reset on takeover). */
  acquiredAt: timestamp('acquired_at').defaultNow().notNull(),
  /** Renewed on every heartbeat; a stale value is what lets another instance take over. */
  heartbeatAt: timestamp('heartbeat_at').defaultNow().notNull(),
  /** Container/host label for operators reading the row. Never load-bearing. */
  hostname: text('hostname'),
});

export type SyncDaemonLease = typeof syncDaemonLeases.$inferSelect;
export type NewSyncDaemonLease = typeof syncDaemonLeases.$inferInsert;
