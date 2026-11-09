import type { DbInstance } from '@boardsesh/db/client';
import { executeFirstRow } from '@boardsesh/db/client';
import { authEmailProjection, users } from '@boardsesh/db/schema/auth';
import { eq, sql } from 'drizzle-orm';

export type CurrentStoreTransaction = Parameters<Parameters<DbInstance['transaction']>[0]>[0];
export const CURRENT_EMAIL_NORMALIZER_VERSION = 'js-trim-lower-v1';

export interface ExpectedCurrentStoreAuthority {
  readonly expectedProjectionId: string;
  readonly expectedNormalizerVersion: string;
  readonly expectedWriterEpoch: number;
}

export class CurrentStoreFoundationError extends Error {
  constructor(
    readonly code:
      | 'PROJECTION_EXISTS'
      | 'UNSUPPORTED_ISOLATION'
      | 'AUTHORITY_NOT_ENFORCED'
      | 'STALE_AUTHORITY'
      | 'INVALID_COMMAND'
      | 'EMAIL_RESERVED'
      | 'EMAIL_AMBIGUOUS'
      | 'EMAIL_RETIRED'
      | 'EMAIL_INVALID'
      | 'RESERVATION_INCONSISTENT'
      | 'SUBJECT_DELETED'
      | 'STALE_GENERATION'
      | 'DUPLICATE_OPERATION',
  ) {
    super(`Current-store foundation rejected: ${code}`);
    this.name = 'CurrentStoreFoundationError';
  }
}

/** Copy trusted server context before the first asynchronous boundary. */
export function captureExpectedAuthority(expected: ExpectedCurrentStoreAuthority): ExpectedCurrentStoreAuthority {
  return {
    expectedProjectionId: expected.expectedProjectionId,
    expectedNormalizerVersion: expected.expectedNormalizerVersion,
    expectedWriterEpoch: expected.expectedWriterEpoch,
  };
}

/** Missing rows under an old snapshot can bypass both keys and tombstones. */
export async function requireReadCommitted(transaction: CurrentStoreTransaction): Promise<void> {
  const isolation = await executeFirstRow<{ transaction_isolation: string }>(
    transaction,
    sql`SHOW transaction_isolation`,
  );
  if (isolation?.transaction_isolation !== 'read committed')
    throw new CurrentStoreFoundationError('UNSUPPORTED_ISOLATION');
}

/**
 * This marker is a fail-closed software prerequisite, never proof of a role
 * fence. No production API in this slice can set the enforced phase.
 */
export async function lockEnforcedProjection(
  transaction: CurrentStoreTransaction,
  expected: ExpectedCurrentStoreAuthority,
) {
  await requireReadCommitted(transaction);
  const [manifest] = await transaction
    .select()
    .from(authEmailProjection)
    .where(eq(authEmailProjection.isCurrent, true))
    .for('update');
  if (!manifest || manifest.phase !== 'enforced') throw new CurrentStoreFoundationError('AUTHORITY_NOT_ENFORCED');
  if (
    manifest.projectionId !== expected.expectedProjectionId ||
    manifest.normalizerVersion !== CURRENT_EMAIL_NORMALIZER_VERSION ||
    expected.expectedNormalizerVersion !== CURRENT_EMAIL_NORMALIZER_VERSION ||
    manifest.writerEpoch !== expected.expectedWriterEpoch ||
    !Number.isSafeInteger(expected.expectedWriterEpoch) ||
    expected.expectedWriterEpoch <= 0
  ) {
    throw new CurrentStoreFoundationError('STALE_AUTHORITY');
  }
  return manifest;
}

/**
 * Every staged auth command queues on the one manifest row, so a command holding
 * it must not sit behind a long transaction on a user row. Account deletion holds
 * its user row through all content and the cascade, and a forgot-password request
 * naming that email needs no credentials. Call after the manifest, before the
 * first user-row lock; it stays in force to commit because everything after it
 * still holds the manifest. A longer wait fails with 55P03, which every entry
 * point reports as unavailable. 250 ms is under PostgreSQL's 1 s deadlock_timeout,
 * so a command gives up before a deletion queued on the manifest becomes a deadlock.
 * A limit rather than NOWAIT: FOR UPDATE also conflicts with the brief foreign-key
 * KEY SHARE of any ordinary write that references the user.
 */
export async function boundLockWaitsUnderManifest(transaction: CurrentStoreTransaction): Promise<void> {
  await transaction.execute(sql`SET LOCAL lock_timeout = '250ms'`);
}

/** The caller already holds the manifest. See {@link boundLockWaitsUnderManifest}. */
export async function lockUserRowUnderManifest(transaction: CurrentStoreTransaction, userId: string) {
  await boundLockWaitsUnderManifest(transaction);
  const [user] = await transaction.select().from(users).where(eq(users.id, userId)).for('update');
  return user;
}
