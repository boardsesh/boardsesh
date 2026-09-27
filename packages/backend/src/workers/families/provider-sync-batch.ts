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
  markProviderSyncRequesterWaiting,
  releaseCredentialSyncLease,
  type ClaimedCredential,
  type ProviderSyncDb,
  type SyncBatchRunner,
} from '@boardsesh/db/queries';
import { logger } from '../../utils/logger';
import { BackgroundJobError, type BackgroundJobContext } from './types';

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
};

export type ProviderSyncRequest = {
  userId: string;
  boardType: string;
  linkGeneration: string;
  requestedBy: 'link' | 'manual';
};

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
 * b. claim the named credential (`claimCredentialForRun`, unfenced: it only
 *    stamps the attempt clock);
 * c. run the provider sync with every write going through
 *    {@link fencedBatchRunner};
 * d. release the lease, and clear `pending_run_id` unless a retry is coming.
 *
 * A stale generation fails the run without retrying; nothing was written.
 */
export async function runProviderSync(
  context: BackgroundJobContext,
  request: ProviderSyncRequest,
  provider: {
    candidateFilter: SQL | undefined;
    sync(credential: ClaimedCredential, transaction: SyncBatchRunner): Promise<ProviderSyncOutcome>;
  },
): Promise<void> {
  const fence: ProviderSyncFence = { ...request, runId: context.runId };
  const key = { userId: request.userId, boardType: request.boardType };

  let started: 'leased' | 'busy';
  try {
    started = await context.transaction(async (transaction) => {
      await enterFence(transaction, fence);
      if (await acquireCredentialSyncLease(transaction, { ...fence, ttlMs: CREDENTIAL_LEASE_TTL_MS })) return 'leased';
      if (request.requestedBy === 'manual') await markProviderSyncRequesterWaiting(transaction, key);
      return 'busy';
    });
  } catch (error) {
    throw fenceFailure(error);
  }
  // Thrown outside the transaction so the requester flag commits.
  if (started === 'busy') throw new BackgroundJobError('CREDENTIAL_BUSY');

  // Retrying attempts keep `pending_run_id` so a "Sync now" meanwhile joins this run.
  let retryComing = true;
  try {
    const credential = await claimCredentialForRun(context.database, {
      ...key,
      candidateFilter: provider.candidateFilter,
    });
    if (!credential) {
      retryComing = false;
      throw new BackgroundJobError('CREDENTIAL_UNAVAILABLE', { retryable: false });
    }
    let outcome: ProviderSyncOutcome;
    try {
      outcome = await provider.sync(credential, fencedBatchRunner(context, fence));
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
    // Best effort: a lost attempt cannot write here, and the backend
    // reconciler clears the lease and pending run once the run is terminal.
    await context
      .transaction(async (transaction) => {
        await releaseCredentialSyncLease(transaction, fence);
        if (!retryComing) await clearPendingProviderSyncRun(transaction, { ...key, runId: context.runId });
      })
      .catch((error: unknown) => {
        logger.warn('[worker] provider sync lease release skipped', {
          runId: context.runId,
          family: context.family,
          code: error instanceof Error ? error.name : 'UNKNOWN',
        });
      });
  }
}
