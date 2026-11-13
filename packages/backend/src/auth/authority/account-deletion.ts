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
import { bindIdentityAuthority } from './identity-authority';
import { captureIdentityAuthority, revalidateIdentityAuthority, type IdentityAuthorityReceipt } from './router';

export interface SelectedAccountDeletion {
  readonly command: CapturedAccountDeletionCommand;
  readonly receipt: IdentityAuthorityReceipt;
}

/** Once a projection exists, deletion must also retire its address reservations. */
export async function assertLegacyAccountDeletionAllowed(transaction: CurrentStoreTransaction): Promise<void> {
  if (await lockIdentityManifest(transaction)) throw new CurrentStoreFoundationError('STALE_AUTHORITY');
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
