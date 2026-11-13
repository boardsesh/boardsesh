import type { DbInstance } from '@boardsesh/db/client';
import { authEmailProjection, authMigrationEpochs } from '@boardsesh/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import {
  CURRENT_EMAIL_NORMALIZER_VERSION,
  CurrentStoreFoundationError,
  lockAuthorityGateExclusively,
  lockEnforcedIdentityManifest,
  type CurrentStoreTransaction,
} from '../current-store/foundation-context';

export type IdentityAuthorityName = 'current-store' | 'better-auth';
export interface IdentityAuthorityReceipt {
  readonly projectionId: string;
  readonly normalizerVersion: string;
  readonly epoch: number;
  readonly authority: IdentityAuthorityName;
}
export interface IdentityAuthorityQualification {
  readonly expectedProjectionId: string;
  readonly expectedNormalizerVersion: string;
}

function receipt(manifest: typeof authEmailProjection.$inferSelect): IdentityAuthorityReceipt {
  if (!['current-store', 'better-auth'].includes(manifest.writerAuthority))
    throw new CurrentStoreFoundationError('STALE_AUTHORITY');
  return Object.freeze({
    projectionId: manifest.projectionId,
    normalizerVersion: manifest.normalizerVersion,
    epoch: manifest.writerEpoch,
    authority: manifest.writerAuthority,
  });
}

/** Read only after taking the gate; a process never pins an authority or epoch. */
export async function captureIdentityAuthority(
  transaction: CurrentStoreTransaction,
  qualification: IdentityAuthorityQualification,
): Promise<IdentityAuthorityReceipt> {
  const requested = { ...qualification };
  const manifest = await lockEnforcedIdentityManifest(transaction);
  if (
    manifest.projectionId !== requested.expectedProjectionId ||
    requested.expectedNormalizerVersion !== CURRENT_EMAIL_NORMALIZER_VERSION ||
    manifest.normalizerVersion !== CURRENT_EMAIL_NORMALIZER_VERSION
  )
    throw new CurrentStoreFoundationError('STALE_AUTHORITY');
  return receipt(manifest);
}

/** Capture anew for each command, before expensive work performed outside transactions. */
export async function readIdentityAuthority(
  database: DbInstance,
  qualification: IdentityAuthorityQualification,
): Promise<IdentityAuthorityReceipt> {
  const requested = { ...qualification };
  return database.transaction((transaction) => captureIdentityAuthority(transaction, requested));
}

/** Call under the command's shared gate before writes and again before completion. */
export async function revalidateIdentityAuthority(
  transaction: CurrentStoreTransaction,
  expected: IdentityAuthorityReceipt,
): Promise<void> {
  const captured = { ...expected };
  const current = await captureIdentityAuthority(transaction, {
    expectedProjectionId: captured.projectionId,
    expectedNormalizerVersion: captured.normalizerVersion,
  });
  if (current.epoch !== captured.epoch || current.authority !== captured.authority)
    throw new CurrentStoreFoundationError('STALE_AUTHORITY');
}

export interface IdentityAuthoritySwitch {
  readonly projectionId: string;
  readonly epoch: number;
  readonly from: IdentityAuthorityName;
  readonly to: IdentityAuthorityName;
}

/**
 * Transaction-bound switch core. The operator entry point must first refuse
 * open activation gates and verify the real database fence on this connection.
 * No environment or caller attestation is accepted as activation evidence.
 */
export async function switchIdentityAuthority(
  transaction: CurrentStoreTransaction,
  expected: IdentityAuthoritySwitch,
): Promise<IdentityAuthorityReceipt> {
  const change = { ...expected };
  if (
    !change.projectionId ||
    !Number.isSafeInteger(change.epoch) ||
    change.epoch <= 0 ||
    change.epoch >= 2_147_483_647 ||
    change.from === change.to ||
    !['current-store', 'better-auth'].includes(change.from) ||
    !['current-store', 'better-auth'].includes(change.to)
  )
    throw new CurrentStoreFoundationError('INVALID_COMMAND');
  await lockAuthorityGateExclusively(transaction);
  const [manifest] = await transaction
    .select()
    .from(authEmailProjection)
    .where(eq(authEmailProjection.isCurrent, true))
    .for('update');
  if (
    !manifest ||
    manifest.phase !== 'enforced' ||
    manifest.projectionId !== change.projectionId ||
    manifest.normalizerVersion !== CURRENT_EMAIL_NORMALIZER_VERSION ||
    manifest.writerEpoch !== change.epoch ||
    manifest.writerAuthority !== change.from
  )
    throw new CurrentStoreFoundationError('STALE_AUTHORITY');
  const [updated] = await transaction
    .update(authEmailProjection)
    .set({
      writerAuthority: change.to,
      writerEpoch: change.epoch + 1,
    })
    .where(
      and(
        eq(authEmailProjection.projectionId, change.projectionId),
        eq(authEmailProjection.writerEpoch, change.epoch),
        eq(authEmailProjection.writerAuthority, change.from),
        eq(authEmailProjection.isCurrent, true),
      ),
    )
    .returning();
  if (!updated) throw new CurrentStoreFoundationError('STALE_AUTHORITY');
  await transaction.insert(authMigrationEpochs).values({
    name: `writer-authority:${updated.projectionId}:${updated.writerEpoch}`,
    cutoverAt: sql`CURRENT_TIMESTAMP`,
  });
  return receipt(updated);
}

/** BA-09 owns issuance cohorts. Writer selection never changes the session format. */
export function issuerFor(userId: string): 'legacy' {
  void userId;
  return 'legacy';
}
