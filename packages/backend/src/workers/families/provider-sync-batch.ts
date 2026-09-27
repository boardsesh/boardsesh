/**
 * The one place the provider sync families put their fences around a write.
 *
 * A personal-data batch commits only while all three hold:
 *
 * 1. the attempt fence: `context.transaction` locks the ledger run row and
 *    checks this attempt still owns the run and its pg-boss lease;
 * 2. the link generation: the account has not been relinked or unlinked since
 *    the job was queued (`assertLinkGenerationCurrent`);
 * 3. the credential lease: no other run is syncing this account
 *    (`acquireCredentialSyncLease`, renewed by every batch).
 *
 * The user tick advisory lock sits between 1 and 2 because the logbook appliers
 * take it anyway; taking it first keeps one lock order for every writer (see
 * the header of packages/db/src/queries/sync/provider-sync-control.ts).
 * Provider HTTP never runs in here: the runners call the provider between
 * batches.
 */
import type { SQL } from 'drizzle-orm';
import {
  StaleLinkGenerationError,
  CredentialLeaseLostError,
  acquireCredentialSyncLease,
  acquireUserTickMutationLock,
  assertLinkGenerationCurrent,
  claimCredentialForRun,
  clearPendingProviderSyncRun,
  coalesceInteractiveRun,
  deferCredentialSyncAttempt,
  ensureProviderSyncControl,
  isSameClaimedCredential,
  markProviderSyncRequesterWaiting,
  readCredentialForShare,
  readProviderSyncControl,
  releaseCredentialSyncLease,
  setPendingProviderSyncRun,
  type ClaimedCredential,
  type ProviderSyncDb,
  type SyncBatchRunner,
} from '@boardsesh/db/queries';
import { logger } from '../../utils/logger';
import { BackgroundJobError, InvalidJobPayloadError, type BackgroundJobContext } from './types';

/** A lease outlives one batch by a wide margin; every batch renews it. */
export const CREDENTIAL_LEASE_TTL_MS = 10 * 60 * 1000;

export type ProviderSyncFence = {
  userId: string;
  boardType: string;
  linkGeneration: string;
  runId: string;
};

async function enterFence(transaction: ProviderSyncDb, fence: ProviderSyncFence): Promise<void> {
  await acquireUserTickMutationLock(transaction, fence.userId);
  await assertLinkGenerationCurrent(transaction, fence);
}

/** Wrap every write batch of one sync run in the attempt, generation and lease fences. */
export function fencedBatchRunner(context: BackgroundJobContext, fence: ProviderSyncFence): SyncBatchRunner {
  return (callback) =>
    context.transaction(async (transaction) => {
      await enterFence(transaction, fence);
      const leased = await acquireCredentialSyncLease(transaction, { ...fence, ttlMs: CREDENTIAL_LEASE_TTL_MS });
      if (!leased) throw new CredentialLeaseLostError();
      return callback(transaction);
    });
}

/** How the provider-specific half reports back. Mirrors the runners' `SyncOutcome`. */
export type ProviderSyncOutcome = {
  status: 'active' | 'error' | 'expired';
  error?: string;
  transient?: boolean;
  /** The provider answered 429 with a readable `Retry-After`. */
  retryAfterMs?: number;
};

export type SyncProvider = 'aurora' | 'kilter';

/**
 * The provider-specific half every provider sync family shares: which
 * credentials the provider's runner can sync, and how to sync one claimed
 * credential with every write going through the caller's fenced runner.
 */
export type ProviderSyncAdapter = {
  provider: SyncProvider;
  /** The interactive family that runs a first sync for this provider's accounts. */
  interactiveFamily: 'aurora-user-sync' | 'kilter-user-sync';
  candidateFilter: SQL | undefined;
  /** `signal` defaults to the run's; the routine cycle passes a per-credential deadline. */
  sync(credential: ClaimedCredential, transaction: SyncBatchRunner, signal?: AbortSignal): Promise<ProviderSyncOutcome>;
  /**
   * Record a transient failure the runner itself never saw (the routine
   * cycle's per-credential deadline) through the daemons' bookkeeping: the
   * attempt clock, `consecutive_failures` (so backoff parks the account) and
   * `last_sync_error`, never the status the climber sees.
   */
  recordTransientFailure(credential: ClaimedCredential, transaction: ProviderSyncDb, code: string): Promise<void>;
};

/**
 * Build the adapter for `provider`: the one place a family turns a claimed
 * credential into a runner call. Aurora skips the board-wide shared sync and
 * Kilter the catalog: both have their own scheduled families. Every user-sync
 * page or flush, and every credential write, goes through `transaction`; the
 * appliers recompute climb stats after each page commits, in batches of their
 * own, because `transaction` is set.
 *
 * The runners are loaded here, not at module scope: the registry is imported on
 * every backend, operator and worker boot, and the sync runners pull in the
 * whole provider stack that only a provider worker ever runs.
 */
export async function loadProviderSyncAdapter(
  context: BackgroundJobContext,
  provider: SyncProvider,
): Promise<ProviderSyncAdapter> {
  const onLog = (message: string) => logger.debug(message, { runId: context.runId, family: context.family });
  // The outcome carries the failure; the message can hold provider detail, so
  // only the bounded code ever reaches the ledger.
  const onError = () => {};
  if (provider === 'aurora') {
    const { SyncRunner, recordAuroraSyncFailure, syncableAuroraCredentialsFilter } =
      await import('@boardsesh/aurora-sync/runner');
    return {
      provider,
      interactiveFamily: 'aurora-user-sync',
      candidateFilter: syncableAuroraCredentialsFilter(),
      sync(credential, transaction, signal = context.signal) {
        const runner = new SyncRunner({ db: context.database, transaction, signal, onLog, onError });
        return runner.syncCredential(credential, { skipSharedSync: true });
      },
      recordTransientFailure: (credential, transaction, code) => recordAuroraSyncFailure(transaction, credential, code),
    };
  }
  const [{ SyncRunner, recordKilterFailure, syncableKilterCredentialsFilter }, { KilterApiError }] = await Promise.all([
    import('@boardsesh/kilter-sync/runner'),
    import('@boardsesh/kilter-sync/api'),
  ]);
  return {
    provider,
    interactiveFamily: 'kilter-user-sync',
    candidateFilter: syncableKilterCredentialsFilter(),
    async recordTransientFailure(credential, transaction, code) {
      // `timeout` is a transient Kilter code: status untouched, backoff counted.
      await recordKilterFailure(transaction, credential, new KilterApiError('timeout', code));
    },
    sync(credential, transaction, signal = context.signal) {
      // The Keycloak token refresh runs unfenced on the worker's pool, exactly
      // as the daemon does it: its own transaction holds the credential row
      // `FOR UPDATE` across the Keycloak call, so rotating refresh tokens are
      // read and written under one lock.
      const runner = new SyncRunner({ db: context.database, onLog, onError });
      return runner.runCycleForCredential(context.database, credential, {
        transaction,
        signal,
        skipCatalogSync: true,
      });
    },
  };
}

export type ProviderSyncRequest = {
  userId: string;
  boardType: string;
  linkGeneration: string;
  /** `routine`: the routine cycle handed over a never-synced account (first sync). */
  requestedBy: 'link' | 'manual' | 'routine';
};

/**
 * Under the fences, check the generation and take the credential lease.
 * `'busy'` when another run holds a live one; `onBusy` runs in the same
 * transaction first. A stale generation throws `StaleLinkGenerationError`.
 */
async function takeLease(
  context: BackgroundJobContext,
  fence: ProviderSyncFence,
  onBusy?: (transaction: ProviderSyncDb) => Promise<void>,
): Promise<'leased' | 'busy'> {
  return context.transaction(async (transaction) => {
    await enterFence(transaction, fence);
    if (await acquireCredentialSyncLease(transaction, { ...fence, ttlMs: CREDENTIAL_LEASE_TTL_MS })) return 'leased';
    await onBusy?.(transaction);
    return 'busy';
  });
}

/** Best effort: a lost attempt cannot write, and the reconciler clears the lease once the run is terminal. */
async function releaseLease(
  context: BackgroundJobContext,
  fence: ProviderSyncFence,
  alsoInTransaction?: (transaction: ProviderSyncDb) => Promise<void>,
): Promise<void> {
  await context
    .transaction(async (transaction) => {
      await releaseCredentialSyncLease(transaction, fence);
      await alsoInTransaction?.(transaction);
    })
    .catch((error: unknown) => {
      logger.warn('[worker] provider sync lease release skipped', {
        runId: context.runId,
        family: context.family,
        code: error instanceof Error ? error.name : 'UNKNOWN',
      });
    });
}

/** Translate a fence refusal into the bounded code the run records. */
function fenceFailure(error: unknown): unknown {
  if (error instanceof StaleLinkGenerationError) {
    return new BackgroundJobError('STALE_LINK_GENERATION', { retryable: false });
  }
  if (error instanceof CredentialLeaseLostError) return new BackgroundJobError('CREDENTIAL_BUSY');
  return error;
}

/**
 * The provider-agnostic body of `aurora-user-sync` and `kilter-user-sync`:
 *
 * a. under the fences, check the generation and take the lease. A live lease
 *    held by another run (an earlier attempt whose lease has not expired;
 *    from PR-3, the routine cycle) ends this attempt with a retryable
 *    `CREDENTIAL_BUSY`. The daemons take no lease: they share the tick lock
 *    order instead, and an overlap costs one duplicate, idempotent sync;
 *    a manual request first records that the climber is waiting;
 * b. claim the named credential (`claimCredentialForRun`) in a fenced
 *    transaction: it stamps the attempt clock, which a stale run must not;
 * c. run the provider sync with every write going through
 *    {@link fencedBatchRunner};
 * d. release the lease, and clear `pending_run_id` unless a retry is coming.
 *
 * A stale generation fails the run without retrying; nothing was written.
 */
export async function runProviderSync(
  context: BackgroundJobContext,
  request: ProviderSyncRequest,
  provider: Pick<ProviderSyncAdapter, 'candidateFilter' | 'sync'>,
): Promise<void> {
  const fence: ProviderSyncFence = { ...request, runId: context.runId };
  const key = { userId: request.userId, boardType: request.boardType };

  let started: 'leased' | 'busy';
  try {
    started = await takeLease(context, fence, async (transaction) => {
      // Nothing reads this flag yet: its consumer is #5618, which tells the
      // climber when the run holding the lease finishes.
      if (request.requestedBy === 'manual') await markProviderSyncRequesterWaiting(transaction, key);
    });
  } catch (error) {
    throw fenceFailure(error);
  }
  // Thrown outside the transaction so the requester flag commits.
  if (started === 'busy') throw new BackgroundJobError('CREDENTIAL_BUSY');

  // Retrying attempts keep `pending_run_id` so a "Sync now" meanwhile joins this run.
  let retryComing = true;
  try {
    // Fenced like any write: a run gone stale since step a must not stamp the
    // new link's attempt clock. Two statements, no HTTP; the fence takes the
    // control row before the claim takes the credential row.
    const fenced = fencedBatchRunner(context, fence);
    let outcome: ProviderSyncOutcome;
    try {
      const credential = await fenced((transaction) =>
        claimCredentialForRun(transaction, { ...key, candidateFilter: provider.candidateFilter }),
      );
      if (!credential) throw new BackgroundJobError('CREDENTIAL_UNAVAILABLE', { retryable: false });
      outcome = await provider.sync(credential, fenced);
    } catch (error) {
      const translated = fenceFailure(error);
      if (translated instanceof BackgroundJobError && !translated.retryable) retryComing = false;
      throw translated;
    }
    if (outcome.status === 'active') {
      retryComing = false;
      return;
    }
    // The failure is already recorded on the credential. A transient one is
    // worth this run's retries; a permanent one (bad password, revoked token)
    // is not, and the card now says so.
    if (outcome.transient) throw new BackgroundJobError('PROVIDER_UNAVAILABLE');
    retryComing = false;
    throw new BackgroundJobError(outcome.status === 'expired' ? 'CREDENTIAL_EXPIRED' : 'PROVIDER_SYNC_FAILED', {
      retryable: false,
    });
  } finally {
    await releaseLease(context, fence, async (transaction) => {
      if (!retryComing) await clearPendingProviderSyncRun(transaction, { ...key, runId: context.runId });
    });
  }
}

/** How long before the run's lease ends a credential's sync is stopped and recorded. */
export const ROUTINE_CREDENTIAL_DEADLINE_MARGIN_MS = 60_000;

/**
 * How one credential of a routine cycle ended. `failed`: the provider sync
 * failed and the failure is recorded on the credential. `skipped`: nothing
 * synced, because another run holds the account or it was relinked or
 * unlinked meanwhile. `queued`: a never-synced account was handed to its
 * interactive family. None of them fails the cycle.
 */
export type RoutineCredentialResult = {
  result: 'synced' | 'failed' | 'skipped' | 'queued';
  reason?:
    | 'NOT_LINKED'
    | 'CREDENTIAL_BUSY'
    | 'STALE_LINK_GENERATION'
    | 'CREDENTIAL_RELINKED'
    | 'CYCLE_DEADLINE'
    | 'FIRST_SYNC';
  /** Set when the provider throttled us; the credential is held until the delay has passed. */
  retryAfterMs?: number;
  /** For `queued`: the interactive run the account was handed to, and whether it already existed. */
  runId?: string;
  coalesced?: boolean;
};

/**
 * Hand a never-synced account to its interactive family: a first sync is the
 * one that can take longer than a routine cycle's lease, and the interactive
 * family has 30 minutes. Coalesces onto a pending interactive run (a link or
 * "Sync now" already queued) exactly as "Sync now" does, and records the new
 * run as `pending_run_id` so a later "Sync now" joins it.
 *
 * One transaction under the fences does all of it: take the credential lease
 * (another run holding it live is a skip), enqueue or coalesce, record the
 * pending run, and hand the lease back so the interactive run can take it.
 * There is no committed lease before the enqueue, so no gap in which the lease
 * could be lost and the enqueue silently abandoned.
 */
async function queueFirstSync(
  context: BackgroundJobContext,
  fence: ProviderSyncFence,
  claimed: ClaimedCredential,
  adapter: Pick<ProviderSyncAdapter, 'interactiveFamily'>,
): Promise<RoutineCredentialResult> {
  const key = { userId: fence.userId, boardType: fence.boardType };
  return context.transaction(async (transaction) => {
    await enterFence(transaction, fence);
    if (!(await acquireCredentialSyncLease(transaction, { ...fence, ttlMs: CREDENTIAL_LEASE_TTL_MS }))) {
      throw new CredentialLeaseLostError();
    }
    if (!isSameClaimedCredential(claimed, await readCredentialForShare(transaction, key))) {
      // Relinked (or otherwise rewritten) since the claim: that link's own run
      // handles it. Hand the lease straight back.
      await releaseCredentialSyncLease(transaction, fence);
      return { result: 'skipped', reason: 'CREDENTIAL_RELINKED' };
    }
    const pending = await coalesceInteractiveRun(transaction, key);
    let queued: RoutineCredentialResult;
    if (pending) {
      queued = { result: 'queued', reason: 'FIRST_SYNC', runId: pending.runId, coalesced: true };
    } else {
      const { runId } = await context.enqueue(transaction, {
        family: adapter.interactiveFamily,
        payload: { ...key, linkGeneration: fence.linkGeneration, requestedBy: 'routine' },
      });
      await setPendingProviderSyncRun(transaction, { ...key, runId });
      queued = { result: 'queued', reason: 'FIRST_SYNC', runId, coalesced: false };
    }
    await releaseCredentialSyncLease(transaction, fence);
    return queued;
  });
}

/**
 * Take the lease for a claimed credential and bind the run to the credential
 * row as it is NOW, in one fenced transaction. The claim's row is a snapshot:
 * a relink between the claim and this point rotates the link generation the
 * fence was just built from AND rewrites the secrets, so syncing the snapshot
 * would sign into the old account and apply its logbook under the new
 * generation. Under the control row's lock (then the credential's `FOR SHARE`,
 * the documented order) the row must still be the one claimed; if it is not,
 * the lease goes straight back and the credential is skipped.
 */
async function takeRoutineLease(
  context: BackgroundJobContext,
  fence: ProviderSyncFence,
  claimed: ClaimedCredential,
): Promise<{ status: 'busy' } | { status: 'relinked' } | { status: 'leased'; credential: ClaimedCredential }> {
  return context.transaction(async (transaction) => {
    await enterFence(transaction, fence);
    if (!(await acquireCredentialSyncLease(transaction, { ...fence, ttlMs: CREDENTIAL_LEASE_TTL_MS }))) {
      return { status: 'busy' as const };
    }
    const current = await readCredentialForShare(transaction, fence);
    if (!current || !isSameClaimedCredential(claimed, current)) {
      await releaseCredentialSyncLease(transaction, fence);
      return { status: 'relinked' as const };
    }
    return { status: 'leased' as const, credential: current };
  });
}

/**
 * Sync one credential the routine cycle already claimed
 * (`claimNextCredentialForSync`, which stamped its attempt clock), through the
 * same fences and adapter as a first-link sync:
 *
 * 1. read the link generation, unfenced (creating the control row for a
 *    credential linked before rows existed, without a new generation);
 * 2. an account that has never synced (`last_sync_at IS NULL`) is handed to
 *    its interactive family instead, in one fenced transaction
 *    ({@link queueFirstSync});
 * 3. take the credential lease under the fences; a live lease another run
 *    holds (a first-link or "Sync now" run that started after the claim) is a
 *    skip. In the same transaction the credential row is re-read and must
 *    still be the claimed one ({@link takeRoutineLease}); a relink since the
 *    claim is a `CREDENTIAL_RELINKED` skip, and the sync runs on the re-read
 *    row, never the claim's snapshot (the first-sync handoff checks the same);
 * 4. otherwise run the adapter with every write behind
 *    {@link fencedBatchRunner}, under a deadline one minute before the run's
 *    lease ends. A sync that hits it stops, and a transient `CYCLE_DEADLINE`
 *    failure is recorded on the credential while the fence is still live, so
 *    backoff parks it and the operator can see it;
 * 5. on a provider 429 with `Retry-After`, hold the credential until then
 *    (`provider_retry_after_until`), still under the fences;
 * 6. release the lease.
 *
 * Only a shutdown, a lost attempt or a database error throws: those end the
 * whole cycle.
 */
export async function runRoutineCredentialSync(
  context: BackgroundJobContext,
  claimed: ClaimedCredential,
  adapter: Pick<ProviderSyncAdapter, 'sync' | 'recordTransientFailure' | 'interactiveFamily'>,
): Promise<RoutineCredentialResult> {
  const key = { userId: claimed.userId, boardType: claimed.boardType };
  let control = await readProviderSyncControl(context.database, key);
  if (!control) {
    await context.transaction((transaction) => ensureProviderSyncControl(transaction, key));
    control = await readProviderSyncControl(context.database, key);
  }
  if (!control?.linked) return { result: 'skipped', reason: 'NOT_LINKED' };
  const fence: ProviderSyncFence = { ...key, linkGeneration: control.linkGeneration, runId: context.runId };

  if (claimed.lastSyncAt === null) {
    try {
      return await queueFirstSync(context, fence, claimed, adapter);
    } catch (error) {
      if (error instanceof StaleLinkGenerationError) return { result: 'skipped', reason: 'STALE_LINK_GENERATION' };
      if (error instanceof CredentialLeaseLostError) return { result: 'skipped', reason: 'CREDENTIAL_BUSY' };
      // A row the interactive family's payload refuses (a board type written
      // before #5453) syncs inline instead, where the runner quarantines it.
      if (!(error instanceof InvalidJobPayloadError)) throw error;
    }
  }

  let credential: ClaimedCredential;
  try {
    const lease = await takeRoutineLease(context, fence, claimed);
    if (lease.status === 'busy') return { result: 'skipped', reason: 'CREDENTIAL_BUSY' };
    if (lease.status === 'relinked') return { result: 'skipped', reason: 'CREDENTIAL_RELINKED' };
    credential = lease.credential;
  } catch (error) {
    if (error instanceof StaleLinkGenerationError) return { result: 'skipped', reason: 'STALE_LINK_GENERATION' };
    throw error;
  }

  const deadline = AbortSignal.timeout(
    Math.max(1_000, context.expiresAt - Date.now() - ROUTINE_CREDENTIAL_DEADLINE_MARGIN_MS),
  );
  const fenced = fencedBatchRunner(context, fence);
  try {
    let outcome: ProviderSyncOutcome;
    try {
      outcome = await adapter.sync(credential, fenced, AbortSignal.any([context.signal, deadline]));
    } catch (error) {
      // Only this credential's deadline, not a shutdown or a lost attempt.
      if (!deadline.aborted || context.signal.aborted) throw error;
      await fenced((transaction) => adapter.recordTransientFailure(credential, transaction, 'CYCLE_DEADLINE'));
      return { result: 'failed', reason: 'CYCLE_DEADLINE' };
    }
    const result = outcome.status === 'active' ? 'synced' : 'failed';
    if (outcome.retryAfterMs === undefined) return { result };
    const delayMs = outcome.retryAfterMs;
    try {
      // The runner counted the 429 as a failure; the Retry-After park replaces
      // that backoff step rather than adding to it.
      await fenced((transaction) => deferCredentialSyncAttempt(transaction, { ...key, delayMs, forgiveFailure: true }));
    } catch (error) {
      // Relinked or taken over since: that run owns the clock now. The
      // throttle still ends this cycle.
      if (!(error instanceof StaleLinkGenerationError || error instanceof CredentialLeaseLostError)) throw error;
    }
    return { result, retryAfterMs: delayMs };
  } catch (error) {
    if (error instanceof StaleLinkGenerationError) return { result: 'skipped', reason: 'STALE_LINK_GENERATION' };
    if (error instanceof CredentialLeaseLostError) return { result: 'skipped', reason: 'CREDENTIAL_BUSY' };
    throw error;
  } finally {
    await releaseLease(context, fence);
  }
}
