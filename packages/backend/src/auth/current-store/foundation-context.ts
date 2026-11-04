import type { DbInstance } from '@boardsesh/db/client';
import { executeFirstRow } from '@boardsesh/db/client';
import { authEmailProjection } from '@boardsesh/db/schema/auth';
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
