import { DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR } from '@boardsesh/shared-schema/sync-error-codes';

/**
 * What the Board Accounts card can honestly say about one linked account.
 *
 * - `expired` — the stored login stopped working; reconnecting fixes it.
 * - `notSyncing` — a `user_board_mappings` row with no `aurora_credentials` row
 *   behind it. The backend reports it as `sync_status: 'linked'` (see
 *   `getAuroraCredentialStatuses`), and the sync daemon can never claim it
 *   because there is no credential to claim — so it will stay empty until the
 *   climber links the account again.
 * - `error` — the last cycle failed for a reason we don't have specific copy for.
 * - `firstSync` — linked, healthy, but nothing has landed yet (`last_sync_at`
 *   is NULL). This is the state the card used to render as plain "Connected",
 *   which is why a climber who had just linked their accounts read an empty app
 *   as broken (#4741).
 * - `syncing` — a reconnected account waiting for another sync.
 * - `connected` — linked and synced at least once.
 */
export type BoardAccountSyncState = 'expired' | 'notSyncing' | 'error' | 'firstSync' | 'syncing' | 'connected';

export type BoardAccountSyncInput = {
  syncStatus: string;
  syncError: string | null;
  lastSyncAt: string | null;
};

/**
 * The duplicate-circuits code is a warning the card explains on its own (#3526):
 * the credential is active and syncing, only the playlist mirror is paused. It
 * must not turn the whole account red.
 */
function isRecognisedWarning(syncError: string | null): boolean {
  return syncError === DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR;
}

export function resolveBoardAccountSyncState(credential: BoardAccountSyncInput): BoardAccountSyncState {
  if (credential.syncStatus === 'expired') return 'expired';
  if (credential.syncStatus === 'linked') return 'notSyncing';
  if (
    credential.syncStatus === 'error' ||
    (credential.syncError !== null && !isRecognisedWarning(credential.syncError))
  )
    return 'error';
  if (credential.lastSyncAt === null) return 'firstSync';
  if (credential.syncStatus === 'pending') return 'syncing';
  return 'connected';
}

/** Accounts the daemon can still advance without another sign-in. */
export function hasPendingAccountSync(credentials: readonly BoardAccountSyncInput[] | undefined): boolean {
  return (credentials ?? []).some((credential) => {
    const syncState = resolveBoardAccountSyncState(credential);
    return syncState === 'firstSync' || syncState === 'syncing' || syncState === 'error';
  });
}
