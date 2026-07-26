import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { auroraCredentials } from '../../schema/auth/mappings';
import { credentialRetryReadySql } from './credential-backoff';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** Full `aurora_credentials` row. Both runners' narrower record types are subsets of it. */
export type ClaimedCredential = typeof auroraCredentials.$inferSelect;

/**
 * Pick the next credential to sync AND claim it, so two daemon instances take
 * disjoint work instead of racing for the same row.
 *
 * Both runners used to run a bare `SELECT ... ORDER BY last_sync_attempt_at ASC
 * NULLS FIRST LIMIT 1`, which nothing stopped two instances from answering
 * identically — the same user would be logged in and synced twice, and both
 * copies would then piggyback the same shared/catalog sync. Adding `FOR UPDATE
 * SKIP LOCKED` to that bare select would have changed nothing: outside an
 * explicit transaction the implicit one commits immediately and drops the row
 * lock. The lock has to be held across a write that makes the row unattractive
 * to the other instance, which is what this does:
 *
 *   1. lock the best candidate with FOR UPDATE SKIP LOCKED — a concurrent
 *      claimer skips straight past it to the next candidate rather than
 *      blocking on it;
 *   2. stamp `last_sync_attempt_at` so that by COMMIT the row has sorted to the
 *      back of the queue and won't be re-picked;
 *   3. commit.
 *
 * The transaction is two statements with no network I/O between them, so it is
 * safe under PgBouncer transaction pooling and never holds a row lock across
 * an Aurora/Kilter HTTP call.
 *
 * Deliberate semantics change: `last_sync_attempt_at` now advances when the
 * attempt STARTS rather than when it finishes, so a per-credential backoff
 * window is measured from attempt-start. The upside is that a process killed
 * mid-sync no longer instantly replays the same credential on reboot.
 *
 * `candidateFilter` carries the board-specific eligibility (aurora excludes
 * kilter and requires username/password/aurora id; kilter requires a refresh
 * token) — the fairness ordering and the backoff predicate are shared and live
 * here so the two runners cannot drift.
 */
export async function claimNextCredentialForSync(
  db: DrizzleDb,
  options: { candidateFilter: SQL | undefined },
): Promise<ClaimedCredential | null> {
  return db.transaction(async (tx) => {
    const candidates = await tx
      .select()
      .from(auroraCredentials)
      .where(and(options.candidateFilter, credentialRetryReadySql()))
      // Order by the ATTEMPT clock (bumped on every attempt), not last_sync_at
      // (bumped only on success): a persistently failing credential must rotate
      // to the back rather than sorting to the front every cycle and wedging
      // the single-user-per-cycle queue. NULLS FIRST keeps never-attempted
      // credentials at the front. Served by aurora_credentials_sync_attempt_priority_idx.
      .orderBy(sql`${auroraCredentials.lastSyncAttemptAt} ASC NULLS FIRST`)
      .limit(1)
      .for('update', { skipLocked: true });

    const candidate = candidates[0];
    if (!candidate) return null;

    const claimedAt = new Date();
    await tx
      .update(auroraCredentials)
      .set({ lastSyncAttemptAt: claimedAt, updatedAt: claimedAt })
      .where(and(eq(auroraCredentials.userId, candidate.userId), eq(auroraCredentials.boardType, candidate.boardType)));

    return { ...candidate, lastSyncAttemptAt: claimedAt };
  });
}
