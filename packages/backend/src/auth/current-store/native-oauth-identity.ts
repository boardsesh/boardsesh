import {
  CurrentStoreFoundationError,
  type CurrentStoreTransaction,
  type ExpectedCurrentStoreAuthority,
} from './foundation-context';
import {
  resolveReservedCurrentStoreOAuthIdentity,
  resolveCurrentStoreOAuthDisplayName,
  type VerifiedCurrentStoreOAuthIdentity,
  type CurrentStoreOAuthForwardedName,
} from './provider-oauth-identity';

export type NativeOAuthProvider = 'apple' | 'google';
export type VerifiedNativeOAuthIdentity = Omit<VerifiedCurrentStoreOAuthIdentity, 'image'>;
export type NativeOAuthForwardedName = CurrentStoreOAuthForwardedName;
export type ReservedNativeOAuthIdentity =
  | { outcome: 'linked'; userId: string; createdAt: Date }
  | { outcome: 'created'; userId: string; createdAt: Date }
  | { outcome: 'conflict' }
  | { outcome: 'no_email' }
  | { outcome: 'deleted' };
export const resolveNativeOAuthDisplayName = resolveCurrentStoreOAuthDisplayName;

/** Preserve released native creation policy; web supplies its own explicit policy. */
export async function resolveReservedNativeOAuthIdentity(
  transaction: CurrentStoreTransaction,
  authority: ExpectedCurrentStoreAuthority,
  provider: NativeOAuthProvider,
  identity: VerifiedNativeOAuthIdentity,
  forwardedName?: NativeOAuthForwardedName,
): Promise<ReservedNativeOAuthIdentity> {
  const result = await resolveReservedCurrentStoreOAuthIdentity(
    transaction,
    authority,
    provider,
    identity,
    { emailStorage: 'normalized', emailVerification: 'provider', actorUserId: null },
    forwardedName,
  );
  if (result.outcome === 'linked' || result.outcome === 'created')
    return { outcome: result.outcome, userId: result.user.id, createdAt: new Date(result.user.createdAt.getTime()) };
  if (result.outcome === 'actor_conflict' || result.outcome === 'sensitive_link_unavailable')
    throw new CurrentStoreFoundationError('INVALID_COMMAND');
  return result;
}
