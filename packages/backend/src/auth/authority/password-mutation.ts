import type { CurrentStoreTransaction } from '../current-store/foundation-context';
import { recordCheckedSecurityMutation } from '../current-store/security-mutation-core';
import { recordSecurityMutation } from '../current-store/security-mutations';
import { advanceCanonicalIdentityGeneration, mirrorAuthorityToCurrentStore } from './reverse-identity';
import { revalidateIdentityAuthority, type IdentityAuthorityReceipt } from './router';

/** Primary credential write has succeeded in this exact caller transaction. */
export async function recordIdentityPasswordMutation(
  transaction: CurrentStoreTransaction,
  options: Parameters<typeof recordCheckedSecurityMutation>[1] & {
    readonly kind: 'password-set' | 'password-change' | 'password-reset';
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
