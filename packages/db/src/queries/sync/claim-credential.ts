import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { auroraCredentials } from '../../schema/auth/mappings';
import { providerSyncControls } from '../../schema/app/provider-sync-controls';
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
 * window. The "sync now" and first-link paths would, and would silently get
 * nothing back, so they use {@link claimCredentialForRun} instead; never shrink
 * this gap to serve them.
 */
export const CREDENTIAL_MIN_RECLAIM_GAP_MS = 30_000;

// Inlined as a numeric literal rather than a bound parameter so Postgres can
// resolve `make_interval(secs => ...)` without an explicit cast.
//
// `sql.raw` is the injection-shaped escape hatch, so be explicit about why it
// is safe here and not a pattern to copy: the argument is a module-level
// number literal divided by 1000, never a request value. Anything that can
// vary at runtime belongs in a bound `${}` parameter with a cast.
const RECLAIM_GAP_SECONDS = sql.raw(String(CREDENTIAL_MIN_RECLAIM_GAP_MS / 1000));

/** TRUE when the credential was last claimed more than {@link CREDENTIAL_MIN_RECLAIM_GAP_MS} ago (or never). */
function credentialReclaimGapElapsedSql(): SQL {
  return sql`(
    ${auroraCredentials.lastSyncAttemptAt} IS NULL
    OR ${auroraCredentials.lastSyncAttemptAt} <= now() - make_interval(secs => ${RECLAIM_GAP_SECONDS})
  )`;
}

/**
 * TRUE unless the credential's control row says a background run holds a live
 * lease on it, or the link was unlinked. A `NOT EXISTS` rather than a join so
 * the claim's `FOR UPDATE` locks only the credential row, never the control
 * row: the control row comes before the credential in the fenced-batch lock
 * order (see provider-sync-control.ts), and a join would take them backwards.
 * A credential with no control row yet is claimable.
 */
function credentialNotLeasedSql(): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${providerSyncControls}
    WHERE ${providerSyncControls.userId} = ${auroraCredentials.userId}
      AND ${providerSyncControls.boardType} = ${auroraCredentials.boardType}
      AND (
        ${providerSyncControls.linked} = false
        OR (${providerSyncControls.activeRunId} IS NOT NULL AND ${providerSyncControls.activeLeaseUntil} > clock_timestamp())
      )
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
 * What the gap assumes: `now()` is `transaction_timestamp()`, so the guard
 * holds as long as a claim transaction finishes well inside the gap. This one
 * is BEGIN, one SELECT, one UPDATE, COMMIT with no application I/O between
 * them, so 30s is a large margin. A claim that stayed open LONGER than the gap
 * and then committed inside a racer's snapshot-to-lock window could still
 * double-hand; no wall-clock gap can rule that out, only a claim-token column
 * (`claimed_by`, or a 'syncing' status) would, and that is a schema change this
 * fix deliberately does not make. The cost if it ever happens is one duplicated
 * cycle, not corruption — the apply is idempotent (full snapshot re-pull, dedup
 * + ON CONFLICT).
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
  options: {
    candidateFilter: SQL | undefined;
    /**
     * Skip credentials a background run is syncing right now (a live lease on
     * the `provider_sync_controls` row) and links marked unlinked. Off by
     * default so the daemons keep claiming exactly what they claimed before.
     */
    excludeLeased?: boolean;
  },
): Promise<ClaimedCredential | null> {
  return db.transaction(async (tx) => {
    const candidates = await tx
      .select()
      .from(auroraCredentials)
      .where(
        and(
          options.candidateFilter,
          credentialRetryReadySql(),
          credentialReclaimGapElapsedSql(),
          options.excludeLeased ? credentialNotLeasedSql() : undefined,
        ),
      )
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

    // Unreachable rather than merely unlikely: the row is locked by the SELECT
    // above for the rest of this transaction, so nothing can delete it out from
    // under the UPDATE. Returning null keeps the caller on its existing
    // no-work-this-cycle path if that reasoning is ever wrong — a throw here
    // would take down a daemon cycle over a row we did not claim anyway.
    const claim = stamped[0];
    if (!claim) return null;

    return { ...candidate, lastSyncAttemptAt: claim.lastSyncAttemptAt, updatedAt: claim.updatedAt };
  });
}

/**
 * Claim ONE named credential for a run that was asked for it: a link, a relink
 * or "Sync now". This is the separate path the reclaim-gap note above asks for.
 *
 * It differs from {@link claimNextCredentialForSync} on purpose:
 *
 * - No reclaim gap and no backoff predicate. A climber who just linked or
 *   tapped "Sync now" should not be turned away because the daemon touched the
 *   row 10 s ago or because the last attempt failed. The gap exists to stop two
 *   claimers picking the SAME next row; here the caller already named the row,
 *   and the run's credential lease (provider_sync_controls) is what keeps two
 *   runs off it.
 * - No ordering, and it waits for the row lock instead of skipping it: the lock
 *   is only ever held for a claim's two statements or a Kilter token refresh.
 *
 * `candidateFilter` still applies (sync_status, required secrets), so an
 * expired or half-written credential is not claimed. Stamps
 * `last_sync_attempt_at` like the daemon claim, so the daemon's fairness clock
 * sees the attempt and moves on to other credentials.
 */
export async function claimCredentialForRun(
  db: DrizzleDb,
  options: { userId: string; boardType: string; candidateFilter: SQL | undefined },
): Promise<ClaimedCredential | null> {
  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(auroraCredentials)
      .where(
        and(
          eq(auroraCredentials.userId, options.userId),
          eq(auroraCredentials.boardType, options.boardType),
          options.candidateFilter,
        ),
      )
      .limit(1)
      .for('update');
    if (!candidate) return null;
    const [claim] = await tx
      .update(auroraCredentials)
      .set({ lastSyncAttemptAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(auroraCredentials.userId, candidate.userId), eq(auroraCredentials.boardType, candidate.boardType)))
      .returning({
        lastSyncAttemptAt: auroraCredentials.lastSyncAttemptAt,
        updatedAt: auroraCredentials.updatedAt,
      });
    if (!claim) return null;
    return { ...candidate, lastSyncAttemptAt: claim.lastSyncAttemptAt, updatedAt: claim.updatedAt };
  });
}

/** The longest a provider's Retry-After may park one credential. */
export const CREDENTIAL_RETRY_AFTER_CAP_MS = 6 * 60 * 60 * 1000;

/**
 * Push a credential's attempt clock into the future after the provider asked
 * us to back off (HTTP 429 with Retry-After). `last_sync_attempt_at = now() +
 * delay` keeps it out of {@link claimNextCredentialForSync} until the delay has
 * passed (the reclaim gap and the backoff both compare against it) and sorts it
 * to the back of the queue. The delay is clamped to 0 ..
 * {@link CREDENTIAL_RETRY_AFTER_CAP_MS} so a hostile or garbled header cannot
 * park an account for longer than the failure backoff's own cap.
 *
 * "Sync now" is unaffected: {@link claimCredentialForRun} ignores the clock.
 */
export async function deferCredentialSyncAttempt(
  db: DrizzleDb,
  options: { userId: string; boardType: string; delayMs: number },
): Promise<void> {
  const delayMs = Number.isFinite(options.delayMs)
    ? Math.min(Math.max(0, options.delayMs), CREDENTIAL_RETRY_AFTER_CAP_MS)
    : 0;
  await db
    .update(auroraCredentials)
    .set({
      lastSyncAttemptAt: sql`now() + make_interval(secs => ${delayMs / 1000}::double precision)`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(auroraCredentials.userId, options.userId), eq(auroraCredentials.boardType, options.boardType)));
}

/**
 * The credential whose token a board-wide job borrows: an `active` credential
 * for the board (plus the runner's own eligibility filter), most recently
 * synced first. The most recent success is the one most likely to still hold a
 * working token or password. Null when the board has no healthy credential.
 */
export async function findSharedSyncDonorCredential(
  db: DrizzleDb,
  options: { boardType: string; candidateFilter: SQL | undefined },
): Promise<ClaimedCredential | null> {
  const [donor] = await db
    .select()
    .from(auroraCredentials)
    .where(
      and(
        eq(auroraCredentials.boardType, options.boardType),
        eq(auroraCredentials.syncStatus, 'active'),
        options.candidateFilter,
      ),
    )
    .orderBy(sql`${auroraCredentials.lastSyncAt} DESC NULLS LAST`)
    .limit(1);
  return donor ?? null;
}
