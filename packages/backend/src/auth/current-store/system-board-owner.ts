import type { DbInstance } from '@boardsesh/db/client';
import { transactionSettings } from './command-context';
import { captureExpectedAuthority, type ExpectedCurrentStoreAuthority } from './foundation-context';
import { ensureReservedSystemIdentity } from './system-identities';

/**
 * Owns only the fixed board identity and its normalized reservation. This does
 * not fence legacy writers or prevent other issuers authenticating a system UID.
 * No profile, credential, verification, session or security generation is created.
 */
export async function ensureReservedSystemBoardOwner(
  database: DbInstance,
  authorityInput: ExpectedCurrentStoreAuthority,
): Promise<void> {
  const authority = captureExpectedAuthority(authorityInput);
  await database.transaction(async (transaction) => {
    await transactionSettings(transaction);
    await ensureReservedSystemIdentity(transaction, authority, 'board-owner');
  });
}
