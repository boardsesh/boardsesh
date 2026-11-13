import { CurrentStoreFoundationError, lockIdentityManifest, type CurrentStoreTransaction } from './foundation-context';

/**
 * Old direct writers still take the shared gate with mirroring disabled. An
 * enforced canonical owner cannot be bypassed by selecting a legacy route.
 * No manifest, or a current-store manifest, preserves the default deployment.
 * Call before any identity writes and retain this transaction through commit.
 */
export async function assertLegacyIdentityWriterAllowed(transaction: CurrentStoreTransaction): Promise<void> {
  const manifest = await lockIdentityManifest(transaction);
  if (manifest?.phase === 'enforced' && manifest.writerAuthority !== 'current-store')
    throw new CurrentStoreFoundationError('STALE_AUTHORITY');
}
