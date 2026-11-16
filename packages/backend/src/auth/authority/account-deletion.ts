import {
  beginReservedAccountDeletion,
  captureAccountDeletionCommand,
  recordReservedAccountDeletion,
  type CapturedAccountDeletionCommand,
  type ReservedDeletionSubject,
} from '../current-store/account-deletion';
import {
  CurrentStoreFoundationError,
  lockIdentityManifest,
  type CurrentStoreTransaction,
} from '../current-store/foundation-context';
import { transactionSettings } from '../current-store/command-context';
import { retireDeletedSubjectEmails } from '../current-store/email-reservations';
import { bindIdentityAuthority } from './identity-authority';
import { captureIdentityAuthority, revalidateIdentityAuthority, type IdentityAuthorityReceipt } from './router';

export interface SelectedAccountDeletion {
  readonly command: CapturedAccountDeletionCommand;
  readonly receipt: IdentityAuthorityReceipt;
}

/** What the legacy deletion owes the email projection, read under the shared gate it holds to commit. */
export type LegacyDeletionProjection = 'none' | 'prepared';

/**
 * Legacy deletion stays available until activation (#7591). A prepared projection
 * is a snapshot that activation rebuilds from current users, so all a legacy
 * deletion owes it is to take this account's projected addresses along
 * ({@link releasePreparedAccountEmails}). Once a projection is enforced, only the
 * staged writer may delete: it keeps the address digest and records the cutoff.
 * The shared gate stays held to commit, so `activate` cannot land in between.
 */
export async function beginLegacyAccountDeletion(
  transaction: CurrentStoreTransaction,
): Promise<LegacyDeletionProjection> {
  const manifest = await lockIdentityManifest(transaction);
  if (!manifest) return 'none';
  if (manifest.phase === 'prepared') return 'prepared';
  throw new CurrentStoreFoundationError('STALE_AUTHORITY');
}

/**
 * Call after the users delete, so the reservation locks follow the users row as
 * in staged deletion. Leaves no digest: the address is released, as it was by a
 * legacy deletion before `prepare`, and no plaintext address of the account stays.
 */
export async function releasePreparedAccountEmails(
  transaction: CurrentStoreTransaction,
  userId: string,
): Promise<void> {
  await retireDeletedSubjectEmails(transaction, userId, { blockAddress: false });
}

/** The shared gate precedes walls; selecting the writer never locks a user early. */
export async function beginIdentityAccountDeletion(
  transaction: CurrentStoreTransaction,
  requested: CapturedAccountDeletionCommand,
): Promise<SelectedAccountDeletion> {
  const captured = captureAccountDeletionCommand(requested, requested.userId, requested.operationId);
  await transactionSettings(transaction);
  const receipt = await captureIdentityAuthority(transaction, captured);
  const command = captureAccountDeletionCommand(
    { ...captured, expectedWriterEpoch: receipt.epoch },
    captured.userId,
    captured.operationId,
  );
  await beginReservedAccountDeletion(transaction, command);
  return Object.freeze({ command, receipt });
}

/** Called after the existing wall/user/content/partner locks, at the old DELETE seam. */
export async function deleteIdentityAccount(
  transaction: CurrentStoreTransaction,
  execution: SelectedAccountDeletion,
): Promise<void> {
  const identity = bindIdentityAuthority(transaction, execution.receipt);
  if (!(await identity.deleteUser(execution.command.userId))) throw new CurrentStoreFoundationError('SUBJECT_DELETED');
  await revalidateIdentityAuthority(transaction, execution.receipt);
}

/** The tombstone and address-retirement policy stays in the deletion transaction. */
export async function recordIdentityAccountDeletion(
  transaction: CurrentStoreTransaction,
  execution: SelectedAccountDeletion,
  subject: ReservedDeletionSubject,
): Promise<void> {
  await revalidateIdentityAuthority(transaction, execution.receipt);
  await recordReservedAccountDeletion(transaction, execution.command, subject);
  await revalidateIdentityAuthority(transaction, execution.receipt);
}
