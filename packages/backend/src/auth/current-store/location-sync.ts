import { createHash } from 'node:crypto';
import {
  LOCATION_SYNC_COMMAND_FUTURE_SKEW_MS,
  LOCATION_SYNC_COMMAND_MAX_AGE_MS,
  LOCATION_SYNC_COMMAND_TIMEOUT_MS,
  locationSyncCommandSchema,
  locationSyncProviderSchema,
  type LocationSyncCommand,
} from '@boardsesh/auth-protocol';
import { BACKGROUND_JOB_QUEUES } from '@boardsesh/db/background-jobs';
import type { DbInstance } from '@boardsesh/db/client';
import { BackgroundJobAttemptLostError, withBackgroundJobAttemptTransaction } from '@boardsesh/db/queries';
import { backgroundJobRuns } from '@boardsesh/db/schema';
import { verificationTokens } from '@boardsesh/db/schema/auth';
import { applyPublicBoardLocationsInTransaction, type LocationSyncSummary } from '@boardsesh/location-sync';
import { eq } from 'drizzle-orm';
import {
  captureIdentityAuthority,
  revalidateIdentityAuthority,
  type IdentityAuthorityQualification,
  type IdentityAuthorityReceipt,
} from '../authority/router';
import { transactionSettings } from './command-context';
import { ensureReservedSystemIdentity } from './system-identities';

export class LocationSyncCommandError extends Error {
  constructor(readonly code: 'request_expired' | 'attempt_lost' | 'replayed_request' | 'unavailable') {
    super('Location-sync command rejected');
    this.name = 'LocationSyncCommandError';
  }
}

function assertFresh(issuedAt: number, deadlineAt: number) {
  const now = Date.now();
  if (
    issuedAt > now + LOCATION_SYNC_COMMAND_FUTURE_SKEW_MS ||
    now - issuedAt > LOCATION_SYNC_COMMAND_MAX_AGE_MS ||
    !Number.isFinite(deadlineAt) ||
    performance.now() >= deadlineAt
  )
    throw new LocationSyncCommandError('request_expired');
}

function boardForRun(run: typeof backgroundJobRuns.$inferSelect): string {
  if (run.role !== 'routine-provider' || run.queue !== BACKGROUND_JOB_QUEUES['routine-provider'])
    throw new LocationSyncCommandError('unavailable');
  if (
    run.family === 'moonboard-locations-sync' &&
    typeof run.payload === 'object' &&
    run.payload !== null &&
    Object.keys(run.payload).length === 0
  )
    return 'moonboard';
  if (
    run.family === 'aurora-shared-sync' &&
    typeof run.payload === 'object' &&
    run.payload !== null &&
    Object.keys(run.payload).length === 1 &&
    'board' in run.payload &&
    run.payload.board !== 'moonboard' &&
    locationSyncProviderSchema.safeParse(run.payload.board).success
  )
    return String(run.payload.board);
  throw new LocationSyncCommandError('unavailable');
}

/** Job fence → selected receipt → fixed owner → complete-gym data, one commit. No provider HTTP. */
export async function executeLocationSyncCommand(
  database: DbInstance,
  qualificationInput: IdentityAuthorityQualification,
  commandInput: LocationSyncCommand,
  deadlineAt: number,
): Promise<LocationSyncSummary> {
  const parsed = locationSyncCommandSchema.safeParse(commandInput);
  if (!parsed.success) throw new LocationSyncCommandError('unavailable');
  const qualification = { ...qualificationInput };
  const {
    requestId,
    issuedAt,
    payload: { runId, attemptToken, records },
  } = parsed.data;
  assertFresh(issuedAt, deadlineAt);
  const commandHash = createHash('sha256').update(requestId).digest('hex');
  try {
    return await database.transaction(async (transaction) => {
      await transactionSettings(transaction);
      let receipt: IdentityAuthorityReceipt | undefined;
      const summary = await withBackgroundJobAttemptTransaction(
        transaction,
        runId,
        attemptToken,
        async (fencedTransaction) => {
          const assertActive = () => assertFresh(issuedAt, deadlineAt);
          assertActive();
          const [run] = await fencedTransaction.select().from(backgroundJobRuns).where(eq(backgroundJobRuns.id, runId));
          if (!run) throw new LocationSyncCommandError('attempt_lost');
          const board = boardForRun(run);
          if (
            records.some(
              (record) =>
                record.boardType !== board ||
                !record.sourceKey.startsWith(`${board}:`) ||
                !record.gymSourceKey.startsWith(`${board}:`),
            )
          )
            throw new LocationSyncCommandError('unavailable');
          const claimed = await fencedTransaction
            .insert(verificationTokens)
            .values({
              // Reuse the existing bounded expired-command cleanup, with a disjoint subnamespace.
              identifier: `ba03-web-auth:location-sync:v1:${commandHash}`,
              token: commandHash,
              expires: new Date(
                issuedAt +
                  LOCATION_SYNC_COMMAND_MAX_AGE_MS +
                  LOCATION_SYNC_COMMAND_FUTURE_SKEW_MS +
                  LOCATION_SYNC_COMMAND_TIMEOUT_MS,
              ),
            })
            .onConflictDoNothing()
            .returning({ token: verificationTokens.token });
          assertActive();
          if (claimed.length !== 1) throw new LocationSyncCommandError('replayed_request');
          receipt = await captureIdentityAuthority(fencedTransaction, qualification);
          await ensureReservedSystemIdentity(
            fencedTransaction,
            {
              expectedProjectionId: receipt.projectionId,
              expectedNormalizerVersion: receipt.normalizerVersion,
              expectedWriterEpoch: receipt.epoch,
            },
            'board-owner',
            receipt,
          );
          assertActive();
          const summary = await applyPublicBoardLocationsInTransaction(
            fencedTransaction,
            records.map((record) => ({
              ...record,
              latitude: Number(record.latitude),
              longitude: Number(record.longitude),
            })),
            { assertActive },
          );
          await revalidateIdentityAuthority(fencedTransaction, receipt);
          assertActive();
          return summary;
        },
      );
      const selectedReceipt = receipt;
      if (!selectedReceipt) throw new LocationSyncCommandError('unavailable');
      // Receipt revalidation follows the data fence check; this second fence
      // keeps lease/deadline validation last after that asynchronous read.
      await withBackgroundJobAttemptTransaction(transaction, runId, attemptToken, async (fencedTransaction) => {
        await revalidateIdentityAuthority(fencedTransaction, selectedReceipt);
        assertFresh(issuedAt, deadlineAt);
      });
      assertFresh(issuedAt, deadlineAt);
      return summary;
    });
  } catch (error) {
    if (error instanceof BackgroundJobAttemptLostError) throw new LocationSyncCommandError('attempt_lost');
    throw error;
  }
}
