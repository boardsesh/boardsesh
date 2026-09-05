import { and, eq, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { syncDaemonLeases } from '../../schema/app/sync-daemon-leases';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** Daemon identities that take a lease. One row in `sync_daemon_leases` each. */
export const AURORA_SYNC_DAEMON = 'aurora-sync';
export const KILTER_SYNC_DAEMON = 'kilter-sync';
export const MOONBOARD_SYNC_DAEMON = 'moonboard-sync';

/**
 * How long a lease survives without a heartbeat before another instance may
 * take it over. Must comfortably exceed the heartbeat interval so an ordinary
 * event-loop hiccup doesn't hand the lease away.
 */
export const DAEMON_LEASE_TTL_MS = 90_000;
/** Heartbeat cadence — a third of the TTL, so two missed beats are survivable. */
export const DAEMON_LEASE_HEARTBEAT_MS = 30_000;

/**
 * Take the lease, or renew it if we already hold it. Returns true when this
 * holder owns the lease after the call.
 *
 * One statement, so the decision and the write are atomic: the `ON CONFLICT DO
 * UPDATE ... WHERE` predicate is evaluated while the row is locked, meaning two
 * instances racing on a free lease produce exactly one winner. `acquired_at` is
 * only reset on a genuine takeover, so an operator can see how long the current
 * holder has been in charge.
 *
 * This does NOT make the daemon a single writer — see the note on
 * {@link syncDaemonLeases}. A holder that stalls past the TTL loses the lease
 * while still running, so every write the daemon performs must be independently
 * safe under concurrency.
 */
export async function acquireOrRenewDaemonLease(
  db: DrizzleDb,
  options: { daemonName: string; holderId: string; hostname?: string | null; ttlMs?: number },
): Promise<boolean> {
  const ttlMs = options.ttlMs ?? DAEMON_LEASE_TTL_MS;
  const rows = await db
    .insert(syncDaemonLeases)
    .values({
      daemonName: options.daemonName,
      holderId: options.holderId,
      hostname: options.hostname ?? null,
    })
    .onConflictDoUpdate({
      target: syncDaemonLeases.daemonName,
      set: {
        holderId: sql`excluded.holder_id`,
        hostname: sql`excluded.hostname`,
        heartbeatAt: sql`now()`,
        // Renewal keeps the original acquisition time; a takeover restarts it.
        acquiredAt: sql`CASE WHEN ${syncDaemonLeases.holderId} = excluded.holder_id THEN ${syncDaemonLeases.acquiredAt} ELSE now() END`,
      },
      // The cast is deliberate: an untyped bind parameter can arrive as `text`
      // through postgres-js, and make_interval's `secs` is double precision.
      setWhere: sql`${syncDaemonLeases.holderId} = excluded.holder_id
        OR ${syncDaemonLeases.heartbeatAt} < now() - make_interval(secs => ${ttlMs / 1000}::double precision)`,
    })
    .returning({ holderId: syncDaemonLeases.holderId });

  return rows.length > 0;
}

/**
 * Give the lease up on shutdown so a rolling deploy hands over immediately
 * instead of idling out the TTL. Scoped to our own holder id: an instance that
 * already lost the lease must not delete the new holder's row.
 */
export async function releaseDaemonLease(
  db: DrizzleDb,
  options: { daemonName: string; holderId: string },
): Promise<void> {
  await db
    .delete(syncDaemonLeases)
    .where(and(eq(syncDaemonLeases.daemonName, options.daemonName), eq(syncDaemonLeases.holderId, options.holderId)));
}
