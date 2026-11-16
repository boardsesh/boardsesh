import { CurrentStoreFoundationError, lockIdentityManifest, type CurrentStoreTransaction } from './foundation-context';

/**
 * Old direct writers still take the shared gate with mirroring disabled. An
 * enforced canonical owner cannot be bypassed by selecting a legacy route.
 * No manifest, or a current-store manifest, preserves the default deployment.
 * Call before any identity writes and retain this transaction through commit.
 */
export async function assertLegacyIdentityWriterAllowed(transaction: CurrentStoreTransaction): Promise<void> {
  await lockLegacyIdentityWriterManifest(transaction);
}

/**
 * The same check, returning the manifest it read for a writer that also keeps
 * that manifest's reservations in step. The shared gate holds the manifest
 * still until this transaction commits, so the caller need not read it again.
 */
export async function lockLegacyIdentityWriterManifest(transaction: CurrentStoreTransaction) {
  const manifest = await lockIdentityManifest(transaction);
  if (manifest?.phase === 'enforced' && manifest.writerAuthority !== 'current-store')
    throw new CurrentStoreFoundationError('STALE_AUTHORITY');
  return manifest;
}
