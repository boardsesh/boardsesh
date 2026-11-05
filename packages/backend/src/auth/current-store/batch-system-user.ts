import { createHash } from 'node:crypto';
import {
  BATCH_SYSTEM_USER_COMMAND_FUTURE_SKEW_MS,
  BATCH_SYSTEM_USER_COMMAND_MAX_AGE_MS,
  BATCH_SYSTEM_USER_COMMAND_TIMEOUT_MS,
  batchSystemUserCommandSchema,
  type BatchSystemUserCommand,
} from '@boardsesh/auth-protocol';
import { BACKGROUND_JOB_QUEUES } from '@boardsesh/db/background-jobs';
import type { DbInstance } from '@boardsesh/db/client';
import { BackgroundJobAttemptLostError, withBackgroundJobAttemptTransaction } from '@boardsesh/db/queries';
import { backgroundJobRuns } from '@boardsesh/db/schema';
import { verificationTokens } from '@boardsesh/db/schema/auth';
import { eq } from 'drizzle-orm';
import {
  refreshHoldFeaturesPayload,
  refreshRecommendationsPayload,
} from '../../workers/families/batch-system-user-payloads';
import { transactionSettings } from './command-context';
import { captureExpectedAuthority, type ExpectedCurrentStoreAuthority } from './foundation-context';
import { ensureReservedSystemIdentity, type SystemIdentityKind } from './system-identities';

export class BatchSystemUserError extends Error {
  constructor(readonly code: 'request_expired' | 'attempt_lost' | 'replayed_request' | 'unavailable') {
    super('Batch system-user command rejected');
    this.name = 'BatchSystemUserError';
  }
}

function assertFresh(issuedAt: number, deadlineAt: number): void {
  const now = Date.now();
  if (
    !Number.isSafeInteger(issuedAt) ||
    issuedAt < 0 ||
    issuedAt > now + BATCH_SYSTEM_USER_COMMAND_FUTURE_SKEW_MS ||
    now - issuedAt > BATCH_SYSTEM_USER_COMMAND_MAX_AGE_MS ||
    !Number.isFinite(deadlineAt) ||
    performance.now() >= deadlineAt
  )
    throw new BatchSystemUserError('request_expired');
}

function identityForRun(run: typeof backgroundJobRuns.$inferSelect): SystemIdentityKind {
  if (run.role !== 'batch' || run.queue !== BACKGROUND_JOB_QUEUES.batch) throw new BatchSystemUserError('unavailable');
  if (run.family === 'refresh-recommendations' && refreshRecommendationsPayload.safeParse(run.payload).success)
    return 'recommendations';
  if (run.family === 'refresh-hold-features') {
    const parsed = refreshHoldFeaturesPayload.safeParse(run.payload);
    if (parsed.success && parsed.data.dryRun !== true && parsed.data.shadow !== false) return 'hold-classifier';
  }
  throw new BatchSystemUserError('unavailable');
}

/**
 * Fixed machine identity only. Run/queue fencing, nonce and reservation commit
 * together; no network request or worker database transaction is held here.
 * Existing worker ledger DML is not tamper-proof family provenance.
 */
export async function executeBatchSystemUserCommand(
  database: DbInstance,
  authorityInput: ExpectedCurrentStoreAuthority,
  command: BatchSystemUserCommand,
  deadlineAt: number,
): Promise<void> {
  const authority = captureExpectedAuthority(authorityInput);
  const parsed = batchSystemUserCommandSchema.safeParse(command);
  if (!parsed.success) throw new BatchSystemUserError('unavailable');
  const {
    requestId,
    issuedAt,
    payload: { runId, attemptToken },
  } = parsed.data;
  assertFresh(issuedAt, deadlineAt);
  const commandHash = createHash('sha256').update(requestId).digest('hex');
  try {
    await database.transaction(async (transaction) => {
      // Apply the limits before waiting for either the ledger or queue lock.
      await transactionSettings(transaction);
      assertFresh(issuedAt, deadlineAt);
      await withBackgroundJobAttemptTransaction(transaction, runId, attemptToken, async (fencedTransaction) => {
        assertFresh(issuedAt, deadlineAt);
        // The fence already owns this row lock. Never trust a caller's family.
        const [run] = await fencedTransaction.select().from(backgroundJobRuns).where(eq(backgroundJobRuns.id, runId));
        if (!run) throw new BatchSystemUserError('attempt_lost');
        const kind = identityForRun(run);
        assertFresh(issuedAt, deadlineAt);
        const claimed = await fencedTransaction
          .insert(verificationTokens)
          .values({
            identifier: `ba03-batch-system-user:v1:${commandHash}`,
            token: commandHash,
            expires: new Date(
              issuedAt +
                BATCH_SYSTEM_USER_COMMAND_MAX_AGE_MS +
                BATCH_SYSTEM_USER_COMMAND_FUTURE_SKEW_MS +
                BATCH_SYSTEM_USER_COMMAND_TIMEOUT_MS,
            ),
          })
          .onConflictDoNothing()
          .returning({ token: verificationTokens.token });
        assertFresh(issuedAt, deadlineAt);
        if (claimed.length !== 1) throw new BatchSystemUserError('replayed_request');
        await ensureReservedSystemIdentity(fencedTransaction, authority, kind);
        assertFresh(issuedAt, deadlineAt);
      });
      // Lease/deadline rechecks in the fence are asynchronous too.
      assertFresh(issuedAt, deadlineAt);
    });
  } catch (error) {
    if (error instanceof BackgroundJobAttemptLostError) throw new BatchSystemUserError('attempt_lost');
    throw error;
  }
}
