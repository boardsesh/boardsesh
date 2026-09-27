/**
 * The per-link fences behind the provider sync families
 * (docs/background-workers.md, "Provider sync families").
 *
 * ## Lock order
 *
 * Every fenced sync batch takes its locks in this order, and every other
 * writer of these rows must never take them in the reverse order:
 *
 *   1. the ledger run row (`background_job_runs … FOR UPDATE`, taken by
 *      `withBackgroundJobAttempt` before the batch callback runs);
 *   2. the user tick advisory lock (`acquireUserTickMutationLock`), which both
 *      logbook appliers and updateTick/deleteTick already share;
 *   3. this module's control row (`FOR SHARE` to check the generation, then the
 *      lease UPDATE);
 *   4. credential and tick rows (`aurora_credentials`, `boardsesh_ticks`, …).
 *
 * The link producers (saveAuroraCredential & co.) and the "Sync now" mutation
 * never take the tick lock, and they lock the control row BEFORE they touch
 * `aurora_credentials`. That keeps them a prefix of the order above, so a relink
 * waits for an in-flight batch to commit instead of deadlocking with it.
 *
 * `FOR SHARE` followed by the lease `UPDATE` in one transaction is safe only
 * because step 2 serializes every fenced batch for a user: two batches never
 * hold the share lock at once and race to upgrade it.
 */
import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { BackgroundJobStatus } from '../../background-jobs';
import { backgroundJobRuns } from '../../schema/app/background-job-runs';
import { providerSyncControls } from '../../schema/app/provider-sync-controls';
import { BackgroundJobAttemptLostError } from '../background-jobs';

/** Any Drizzle Postgres database or transaction. */
export type ProviderSyncDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * Runs one write batch in one transaction, behind whatever fences its owner
 * applies. The sync runners take one of these instead of calling
 * `db.transaction` so a background job can put its attempt fence, the link
 * generation check and the credential lease around every batch.
 */
export type SyncBatchRunner = <Result>(callback: (transaction: ProviderSyncDb) => Promise<Result>) => Promise<Result>;

export type ProviderSyncKey = { userId: string; boardType: string };

/** The link this job was queued for has been relinked or unlinked since. Never retry. */
export class StaleLinkGenerationError extends Error {
  constructor() {
    super('The board link changed since this sync was queued');
    this.name = 'StaleLinkGenerationError';
  }
}

/** Another run holds a live lease on this credential. */
export class CredentialLeaseLostError extends Error {
  constructor() {
    super('Another sync holds this credential');
    this.name = 'CredentialLeaseLostError';
  }
}

/**
 * An error that means "stop writing", not "this credential failed": a fence
 * refused the batch. Runners rethrow these untouched instead of recording them
 * as a sync failure on the credential. An abort is recognised separately, by
 * the caller's own signal being aborted: matching on the error name would also
 * catch a daemon's unrelated timeout and skip its failure bookkeeping.
 */
export function isSyncFenceError(error: unknown): boolean {
  return (
    error instanceof StaleLinkGenerationError ||
    error instanceof CredentialLeaseLostError ||
    error instanceof BackgroundJobAttemptLostError
  );
}

const keyMatches = ({ userId, boardType }: ProviderSyncKey) =>
  and(eq(providerSyncControls.userId, userId), eq(providerSyncControls.boardType, boardType));

/**
 * Start a new link generation: every job queued before this call now fails its
 * first fenced batch. Clears the pending run and the lease with it, because both
 * belonged to the old generation. Upserts, so it is also how a row is created.
 */
export async function rotateLinkGeneration(
  transaction: ProviderSyncDb,
  input: ProviderSyncKey & { linked: boolean },
): Promise<{ linkGeneration: string }> {
  const [row] = await transaction
    .insert(providerSyncControls)
    .values({ userId: input.userId, boardType: input.boardType, linked: input.linked })
    .onConflictDoUpdate({
      target: [providerSyncControls.userId, providerSyncControls.boardType],
      set: {
        linkGeneration: sql`gen_random_uuid()`,
        linked: input.linked,
        pendingRunId: null,
        notifyRequester: false,
        activeRunId: null,
        activeLeaseUntil: null,
        updatedAt: sql`now()`,
      },
    })
    .returning({ linkGeneration: providerSyncControls.linkGeneration });
  return { linkGeneration: row.linkGeneration };
}

/**
 * Create the control row for a credential linked before rows existed, without
 * starting a new generation: two concurrent callers both land on one row, and
 * no queued job is fenced off by it.
 */
export async function ensureProviderSyncControl(transaction: ProviderSyncDb, key: ProviderSyncKey): Promise<void> {
  await transaction
    .insert(providerSyncControls)
    .values({ userId: key.userId, boardType: key.boardType, linked: true })
    .onConflictDoNothing();
}

/** Lock the control row for a read-modify-write (the "Sync now" path). */
export async function lockProviderSyncControl(transaction: ProviderSyncDb, key: ProviderSyncKey) {
  const [row] = await transaction.select().from(providerSyncControls).where(keyMatches(key)).for('update');
  return row;
}

/**
 * The link-generation fence. Holds the row `FOR SHARE` until the batch commits,
 * so a relink (which updates the row) waits for the batch and every later batch
 * sees the new generation.
 */
export async function assertLinkGenerationCurrent(
  transaction: ProviderSyncDb,
  input: ProviderSyncKey & { linkGeneration: string },
): Promise<void> {
  const [row] = await transaction
    .select({ linkGeneration: providerSyncControls.linkGeneration, linked: providerSyncControls.linked })
    .from(providerSyncControls)
    .where(keyMatches(input))
    .for('share');
  if (!row || !row.linked || row.linkGeneration !== input.linkGeneration) throw new StaleLinkGenerationError();
}

/**
 * Take or renew the credential lease for `runId`. Succeeds when the lease is
 * free, already this run's, or past its time; false means another run holds a
 * live lease. Uses the database clock on both sides so app skew cannot matter.
 */
export async function acquireCredentialSyncLease(
  transaction: ProviderSyncDb,
  input: ProviderSyncKey & { runId: string; ttlMs: number },
): Promise<boolean> {
  if (!Number.isInteger(input.ttlMs) || input.ttlMs <= 0) throw new Error('Invalid lease TTL');
  const acquired = await transaction
    .update(providerSyncControls)
    .set({
      activeRunId: input.runId,
      activeLeaseUntil: sql`clock_timestamp() + make_interval(secs => ${input.ttlMs / 1000}::double precision)`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        keyMatches(input),
        or(
          sql`${providerSyncControls.activeRunId} IS NULL`,
          eq(providerSyncControls.activeRunId, input.runId),
          sql`${providerSyncControls.activeLeaseUntil} IS NULL`,
          sql`${providerSyncControls.activeLeaseUntil} <= clock_timestamp()`,
        ),
      ),
    )
    .returning({ userId: providerSyncControls.userId });
  return acquired.length > 0;
}

/** Drop the lease if `runId` still holds it. A lease another run took over is left alone. */
export async function releaseCredentialSyncLease(
  transaction: ProviderSyncDb,
  input: ProviderSyncKey & { runId: string },
): Promise<void> {
  await transaction
    .update(providerSyncControls)
    .set({ activeRunId: null, activeLeaseUntil: null, updatedAt: sql`now()` })
    .where(and(keyMatches(input), eq(providerSyncControls.activeRunId, input.runId)));
}

/** Point the control row at the interactive run a later "Sync now" should coalesce onto. */
export async function setPendingProviderSyncRun(
  transaction: ProviderSyncDb,
  input: ProviderSyncKey & { runId: string },
): Promise<void> {
  await transaction
    .update(providerSyncControls)
    .set({ pendingRunId: input.runId, updatedAt: sql`now()` })
    .where(keyMatches(input));
}

/** Clear the pending run if it is still `runId`. */
export async function clearPendingProviderSyncRun(
  transaction: ProviderSyncDb,
  input: ProviderSyncKey & { runId: string },
): Promise<void> {
  await transaction
    .update(providerSyncControls)
    .set({ pendingRunId: null, updatedAt: sql`now()` })
    .where(and(keyMatches(input), eq(providerSyncControls.pendingRunId, input.runId)));
}

/** A climber asked for a sync while another run held the lease; tell them when it lands. */
export async function markProviderSyncRequesterWaiting(
  transaction: ProviderSyncDb,
  input: ProviderSyncKey,
): Promise<void> {
  await transaction
    .update(providerSyncControls)
    .set({ notifyRequester: true, updatedAt: sql`now()` })
    .where(keyMatches(input));
}

const NON_TERMINAL_RUN_STATUSES: BackgroundJobStatus[] = ['queued', 'running', 'retrying'];

/**
 * The interactive run a new request should join instead of queueing its own:
 * the control row's pending run while it is still queued, running or retrying.
 * Null when there is none, or it already finished (the reconciler clears those).
 *
 * The family queue is `stately` with one retry slot per key, so coalescing has
 * to happen here, before an enqueue, never by leaning on pg-boss to hold two
 * queued runs for one credential.
 */
export async function coalesceInteractiveRun(
  transaction: ProviderSyncDb,
  key: ProviderSyncKey,
): Promise<{ runId: string; status: BackgroundJobStatus } | null> {
  const [row] = await transaction
    .select({ runId: backgroundJobRuns.id, status: backgroundJobRuns.status })
    .from(providerSyncControls)
    .innerJoin(backgroundJobRuns, eq(backgroundJobRuns.id, providerSyncControls.pendingRunId))
    .where(and(keyMatches(key), inArray(backgroundJobRuns.status, NON_TERMINAL_RUN_STATUSES)));
  return row ?? null;
}

/**
 * One bounded reconciler pass: clear `active_run_id`/`pending_run_id` that point
 * at a run which finished or no longer exists. A worker that dies mid-run leaves
 * both behind; without this a "Sync now" would coalesce onto a dead run forever
 * and the lease would block every other run until its TTL. A run the ledger
 * still shows as queued, running or retrying keeps both.
 */
export async function clearFinishedProviderSyncRuns(database: ProviderSyncDb, limit = 100): Promise<number> {
  const runIsFinished = (column: typeof providerSyncControls.pendingRunId | typeof providerSyncControls.activeRunId) =>
    sql`NOT EXISTS (
      SELECT 1 FROM ${backgroundJobRuns}
      WHERE ${backgroundJobRuns.id} = ${column}
        AND ${backgroundJobRuns.status} IN ('queued', 'running', 'retrying')
    )`;
  const candidates = await database
    .select({
      userId: providerSyncControls.userId,
      boardType: providerSyncControls.boardType,
      pendingRunId: providerSyncControls.pendingRunId,
      activeRunId: providerSyncControls.activeRunId,
    })
    .from(providerSyncControls)
    .where(
      or(
        and(isNotNull(providerSyncControls.pendingRunId), runIsFinished(providerSyncControls.pendingRunId)),
        and(isNotNull(providerSyncControls.activeRunId), runIsFinished(providerSyncControls.activeRunId)),
      ),
    )
    .limit(limit);
  let cleared = 0;
  for (const candidate of candidates) {
    // Compare-and-set on the run IDs just read. A producer that re-pointed the
    // row meanwhile (a new pending run, a new lease) commits a row this WHERE no
    // longer matches, so the recheck skips it instead of judging the new run
    // with this statement's older snapshot, in which it does not exist yet.
    const updated = await database
      .update(providerSyncControls)
      .set({
        pendingRunId: sql`CASE WHEN ${runIsFinished(providerSyncControls.pendingRunId)} THEN NULL ELSE ${providerSyncControls.pendingRunId} END`,
        activeRunId: sql`CASE WHEN ${runIsFinished(providerSyncControls.activeRunId)} THEN NULL ELSE ${providerSyncControls.activeRunId} END`,
        activeLeaseUntil: sql`CASE WHEN ${runIsFinished(providerSyncControls.activeRunId)} THEN NULL ELSE ${providerSyncControls.activeLeaseUntil} END`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          keyMatches(candidate),
          sql`${providerSyncControls.pendingRunId} IS NOT DISTINCT FROM ${candidate.pendingRunId}::uuid`,
          sql`${providerSyncControls.activeRunId} IS NOT DISTINCT FROM ${candidate.activeRunId}::uuid`,
        ),
      )
      .returning({ userId: providerSyncControls.userId });
    cleared += updated.length;
  }
  return cleared;
}
