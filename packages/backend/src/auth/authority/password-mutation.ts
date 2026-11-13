import type { CurrentStoreTransaction } from '../current-store/foundation-context';
import { recordCheckedSecurityMutation } from '../current-store/security-mutation-core';
import type { IdentityAuthorityReceipt } from './router';
import { recordIdentitySecurityMutation } from './security-mutation';

/** Primary credential write has succeeded in this exact caller transaction. */
export async function recordIdentityPasswordMutation(
  transaction: CurrentStoreTransaction,
  options: Parameters<typeof recordCheckedSecurityMutation>[1] & {
    readonly kind: 'password-set' | 'password-change' | 'password-reset';
  },
  receipt: IdentityAuthorityReceipt,
) {
  return recordIdentitySecurityMutation(transaction, options, receipt);
}
