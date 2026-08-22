import { sql, type SQL } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import { auroraCredentials } from '../../schema/auth/mappings';
import { credentialRetryReadySql } from './credential-backoff';

type SnapshotDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** Read-only snapshot of a credential fleet, for a daemon's health-summary log. */
export type CredentialFleetSnapshot = {
  total: number;
  active: number;
  pending: number;
  error: number;
  expired: number;
  /** Syncable credentials currently skipped because they're inside a backoff window. */
  inBackoff: number;
  /**
   * Oldest last_sync_attempt_at across the fleet (null = some never attempted).
   * Typed to admit a string: a raw `sql` aggregate carries no decoder unless one
   * is attached, and this one attaches the column's — see below.
   */
  oldestAttemptAt: Date | string | null;
};

/**
 * One aggregate scan over the credentials table: counts by sync_status, how
 * many syncable credentials sit inside a backoff window, and the oldest attempt
 * clock. Read-only, so it is safe to run every cycle even with a second daemon
 * instance overlapping.
 *
 * `scope` selects the fleet — aurora passes `ne(boardType, 'kilter')`, kilter
 * passes `eq(boardType, 'kilter')` — so both daemons report on their own
 * credentials from one implementation.
 */
export async function getCredentialFleetSnapshot(db: SnapshotDb, scope: SQL): Promise<CredentialFleetSnapshot> {
  const rows = await db
    .select({
      total: sql<number>`(count(*))::int`,
      active: sql<number>`(count(*) filter (where ${auroraCredentials.syncStatus} = 'active'))::int`,
      pending: sql<number>`(count(*) filter (where ${auroraCredentials.syncStatus} = 'pending'))::int`,
      error: sql<number>`(count(*) filter (where ${auroraCredentials.syncStatus} = 'error'))::int`,
      expired: sql<number>`(count(*) filter (where ${auroraCredentials.syncStatus} = 'expired'))::int`,
      inBackoff: sql<number>`(count(*) filter (
        where ${auroraCredentials.syncStatus} in ('pending', 'active', 'error')
          and not ${credentialRetryReadySql()}
      ))::int`,
      // .mapWith is load-bearing. A raw `sql` expression gets NO runtime decoder
      // — the <Date | null> generic is compile-time only — and drizzle's
      // postgres-js driver deliberately strips postgres.js's own date parsers
      // (last_sync_attempt_at is `timestamp`, OID 1114) so column mappers are
      // the single source of truth. Without this the value arrives as raw
      // Postgres text and any .toISOString() on it throws, which is what
      // silently killed every hourly health summary aurora-sync ever emitted.
      oldestAttemptAt: sql<Date | null>`min(${auroraCredentials.lastSyncAttemptAt})`.mapWith(
        auroraCredentials.lastSyncAttemptAt,
      ),
    })
    .from(auroraCredentials)
    .where(scope);

  const row = rows[0];
  return {
    total: Number(row?.total ?? 0),
    active: Number(row?.active ?? 0),
    pending: Number(row?.pending ?? 0),
    error: Number(row?.error ?? 0),
    expired: Number(row?.expired ?? 0),
    inBackoff: Number(row?.inBackoff ?? 0),
    oldestAttemptAt: row?.oldestAttemptAt ?? null,
  };
}
