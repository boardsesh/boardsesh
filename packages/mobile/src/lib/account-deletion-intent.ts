import { getAuthToken, isAuthCredentialGenerationCurrent } from './auth-store';
import { userIdFromJwt } from './jwt-user-id';
import { getCurrentUserStorageOwner } from './user-storage-owner';
import { getVerifiedAuthResult } from './verified-auth-result';

/** Local ownership guard only; the backend authenticates the actual credential. */
export type AccountDeletionIntent = Readonly<{
  credentialGeneration: number;
  userId: string;
}>;

export type AccountDeletionResult = { deleted: false } | { deleted: true; intent: AccountDeletionIntent };

export type SignOutRequest = [method?: 'manual'] | [method: 'account_deleted', intent: AccountDeletionIntent];

export class AccountDeletionSupersededError extends Error {
  constructor() {
    super('Account credentials changed before account deletion');
    this.name = 'AccountDeletionSupersededError';
  }
}

export async function captureAccountDeletionIntent(credentialGeneration: number): Promise<AccountDeletionIntent> {
  if (!isAuthCredentialGenerationCurrent(credentialGeneration)) throw new AccountDeletionSupersededError();
  // Capture the confirmed browser/metadata owner before awaiting native storage.
  // A JWE is opaque to userIdFromJwt; the browser's settled storage owner is
  // established by AuthProvider before authenticated children mount.
  const confirmedOwner = getCurrentUserStorageOwner()?.userId ?? getVerifiedAuthResult()?.userId;
  let credentialOwner: string | undefined;
  try {
    credentialOwner = userIdFromJwt(await getAuthToken());
  } catch {
    // A transient storage read may still have a confirmed owner in this exact
    // generation. Without either owner, do not send a destructive mutation.
  }
  if (!isAuthCredentialGenerationCurrent(credentialGeneration)) throw new AccountDeletionSupersededError();
  if (credentialOwner && confirmedOwner && credentialOwner !== confirmedOwner) {
    throw new AccountDeletionSupersededError();
  }
  const userId = credentialOwner ?? confirmedOwner;
  if (!userId) throw new Error('Unable to confirm the account before deletion');
  return Object.freeze({ credentialGeneration, userId });
}

export async function isAccountDeletionIntentCurrent(intent: AccountDeletionIntent): Promise<boolean> {
  if (!isAuthCredentialGenerationCurrent(intent.credentialGeneration)) return false;
  try {
    const current = await captureAccountDeletionIntent(intent.credentialGeneration);
    return isAuthCredentialGenerationCurrent(intent.credentialGeneration) && current.userId === intent.userId;
  } catch (error) {
    if (error instanceof AccountDeletionSupersededError) return false;
    throw error;
  }
}
