import {
  CurrentStoreFoundationError,
  CURRENT_EMAIL_NORMALIZER_VERSION,
  lockIdentityManifest,
  type CurrentStoreTransaction,
} from './foundation-context';

/** This receipt permits only the existing store before authority enforcement. */
export type PreEnforcementContext = Readonly<{
  projectionId: string | null;
  writerEpoch: number | null;
}>;

/**
 * Preparation is only a snapshot, never identity authority. Keep its identity
 * stable under the shared gate, without treating its reservations as current.
 * An enforced store must use the qualified authority commands instead.
 */
export async function capturePreEnforcementContext(
  transaction: CurrentStoreTransaction,
): Promise<PreEnforcementContext> {
  const manifest = await lockIdentityManifest(transaction);
  if (
    manifest &&
    (manifest.phase !== 'prepared' ||
      manifest.writerAuthority !== 'current-store' ||
      manifest.normalizerVersion !== CURRENT_EMAIL_NORMALIZER_VERSION)
  )
    throw new CurrentStoreFoundationError('STALE_AUTHORITY');
  return Object.freeze({ projectionId: manifest?.projectionId ?? null, writerEpoch: manifest?.writerEpoch ?? null });
}

export async function revalidatePreEnforcementContext(
  transaction: CurrentStoreTransaction,
  expected: PreEnforcementContext,
): Promise<void> {
  const { projectionId, writerEpoch } = expected;
  const current = await capturePreEnforcementContext(transaction);
  if (current.projectionId !== projectionId || current.writerEpoch !== writerEpoch)
    throw new CurrentStoreFoundationError('STALE_AUTHORITY');
}
