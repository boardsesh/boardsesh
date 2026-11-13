import type { CurrentStoreTransaction } from '../current-store/foundation-context';
import { recordCheckedSecurityMutation } from '../current-store/security-mutation-core';
import { recordSecurityMutation } from '../current-store/security-mutations';
import { advanceCanonicalIdentityGeneration, mirrorAuthorityToCurrentStore } from './reverse-identity';
import { revalidateIdentityAuthority, type IdentityAuthorityReceipt } from './router';

/** Keep the selected identity store and its rollback copy at the cutoff generation. */
export async function recordIdentitySecurityMutation(
  transaction: CurrentStoreTransaction,
  options: Parameters<typeof recordCheckedSecurityMutation>[1] & {
    readonly kind: Exclude<Parameters<typeof recordCheckedSecurityMutation>[1]['kind'], 'account-deletion'>;
  },
  receipt: IdentityAuthorityReceipt,
) {
  await revalidateIdentityAuthority(transaction, receipt);
  if (receipt.authority === 'current-store') return recordSecurityMutation(transaction, options);
  const result = await recordCheckedSecurityMutation(transaction, options);
  await advanceCanonicalIdentityGeneration(transaction, options.userId, result.identityGenerationReceipt);
  await mirrorAuthorityToCurrentStore(transaction, options.userId);
  await revalidateIdentityAuthority(transaction, receipt);
  return result;
}
