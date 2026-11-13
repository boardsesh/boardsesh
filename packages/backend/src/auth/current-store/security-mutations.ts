import { mirrorIdentityIfEnabled } from '../authority/sync-identity';
import { recordCheckedSecurityMutation } from './security-mutation-core';
export type {
  CurrentSecurityMutationKind,
  CurrentRevocationDomain,
  IdentityGenerationMutationReceipt,
} from './security-mutation-core';

/** Preserve the existing policy and mirror order around the checked mutation. */
export async function recordSecurityMutation(...arguments_: Parameters<typeof recordCheckedSecurityMutation>) {
  const result = await recordCheckedSecurityMutation(...arguments_);
  if (result.event.kind !== 'account-deletion') await mirrorIdentityIfEnabled(arguments_[0], result.event.userId);
  return result;
}
