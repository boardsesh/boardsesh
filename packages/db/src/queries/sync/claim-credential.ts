import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { auroraCredentials } from '../../schema/auth/mappings';
import { credentialRetryReadySql } from './credential-backoff';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** Full `aurora_credentials` row. Both runners' narrower record types are subsets of it. */
export type ClaimedCredential = typeof auroraCredentials.$inferSelect;

/**
 * A credential claimed less than this long ago is not claimable again.
 *
 * This is not a throttle, it is what makes the claim safe under READ COMMITTED
 * — see the EvalPlanQual note on {@link claimNextCredentialForSync}. The
 * daemon's shortest cycle is 1 minute (`DEFAULT_DAEMON_OPTIONS.minDelayMinutes`
 * in @boardsesh/sync-runtime), so no real caller wants to re-claim inside this
 * window. A future "sync now" path that calls the claim directly would, and
 * would silently get nothing back — give it its own path rather than shrinking
 * this gap.
 */
export const CREDENTIAL_MIN_RECLAIM_GAP_MS = 30_000;

// Inlined as a numeric literal rather than a bound parameter so Postgres can
// resolve `make_interval(secs => ...)` without an explicit cast.
const RECLAIM_GAP_SECONDS = sql.raw(String(CREDENTIAL_MIN_RECLAIM_GAP_MS / 1000));

/** TRUE when the credential was last claimed more than {@link CREDENTIAL_MIN_RECLAIM_GAP_MS} ago (or never). */
function credentialReclaimGapElapsedSql(): SQL {
  return sql`(
    ${auroraCredentials.lastSyncAttemptAt} IS NULL
    OR ${auroraCredentials.lastSyncAttemptAt} <= now() - make_interval(secs => ${RECLAIM_GAP_SECONDS})
  )`;
}

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
 * ## Why the reclaim gap in the WHERE is load-bearing (#3987)
 *
 * Sorting the claimed row to the back is NOT sufficient on its own, and the gap
 * predicate below is not redundant with the ordering. Under READ COMMITTED,
 * SKIP LOCKED only skips rows whose lock is *currently held*. If claimer A
 * locks row X, stamps it and COMMITs entirely inside the window between
 * claimer B's statement snapshot and B's lock attempt on X, the lock is already
 * gone by the time B reaches it. Postgres then follows the update chain and
 * runs an EvalPlanQual recheck of the new row version — and EPQ re-evaluates
 * only the WHERE quals, never the ORDER BY. `credentialRetryReadySql()`
 * short-circuits to TRUE on `consecutive_failures <= 0` no matter how fresh the
 * attempt stamp is, so before this predicate existed every qual still passed:
 * B locked and returned the SAME row A had just claimed, and one user got
 * synced twice by two instances.
 *
 * The fix is that claiming must falsify a qual. `last_sync_attempt_at <= now()
 * - 30s` is exactly the qual the claim's own stamp breaks, so the EPQ recheck
 * throws the row out and B either idles or takes the next candidate (both are
 * correct). Do not drop it because "the ordering already handles that", and do
 * not fold this into a single `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE
 * SKIP LOCKED)` — that has the identical EPQ hazard.
 *
 * Both statements stamp and compare against the DATABASE clock (`now()`), so
 * app/DB skew cannot re-open the window.
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
      .where(and(options.candidateFilter, credentialRetryReadySql(), credentialReclaimGapElapsedSql()))
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

    // Stamp with the DB clock, not `new Date()`: the gap predicate above reads
    // the same clock, so a skewed app process cannot write a stamp that already
    // looks older than the gap and hand the row straight back to a racer.
    const stamped = await tx
      .update(auroraCredentials)
      .set({ lastSyncAttemptAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(auroraCredentials.userId, candidate.userId), eq(auroraCredentials.boardType, candidate.boardType)))
      .returning({
        lastSyncAttemptAt: auroraCredentials.lastSyncAttemptAt,
        updatedAt: auroraCredentials.updatedAt,
      });

    const claim = stamped[0];
    if (!claim) return null;

    return { ...candidate, lastSyncAttemptAt: claim.lastSyncAttemptAt, updatedAt: claim.updatedAt };
  });
}
