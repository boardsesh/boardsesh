// The active board — which board the user is currently looking at — persisted
// in **unsecure** AsyncStorage (via preference-store) rather than the encrypted
// SecureStore. It's a non-secret UI preference: the board picked from the
// boards tab, read until the user switches. AsyncStorage avoids SecureStore's
// small per-value limit and the keychain round-trip on every read, and unlike a
// React Query cache it survives a cold start — so the user's chosen board no
// longer reverts to the server default when the app relaunches.
//
// Replaces the SecureStore-backed `board-store.ts`. The full `UserBoard` is
// stored (not a remapped subset) so every reader that previously consumed
// `useDefaultBoard()` keeps the exact same shape after switching to
// `useActiveBoard()`.
//
// Schema migration note: `getPreference` silently returns null when JSON.parse
// fails, but a stale value whose shape no longer matches `UserBoard` will parse
// successfully and be cast to the wrong type. If `UserBoard` gains required
// fields in a future migration, bump `ACTIVE_BOARD_KEY` so stale values are
// ignored rather than misread.

import type { UserBoard } from '@boardsesh/shared-schema';
import { LOCAL_ACCESS_MODE } from '@boardsesh/party-profile';
import { getPreference, setPreference, removePreference } from './preference-store';
import type { UserStorageOwner } from './user-storage-owner';
import { readPersistedAccessMode } from './access-mode-store';

const ACCOUNT_ACTIVE_BOARD_KEY = 'boardsesh_active_board_v2';
const LOCAL_ACTIVE_BOARD_KEY = 'boardsesh_local_active_board_v1';

export type ActiveBoardStorageNamespace = 'account' | 'local';

/** Capture this at read/write intent time, before an async queue can yield. */
export function captureActiveBoardStorageNamespace(): ActiveBoardStorageNamespace {
  return readPersistedAccessMode() === LOCAL_ACCESS_MODE ? 'local' : 'account';
}

function activeBoardKey(namespace: ActiveBoardStorageNamespace): string {
  return namespace === 'local' ? LOCAL_ACTIVE_BOARD_KEY : ACCOUNT_ACTIVE_BOARD_KEY;
}

export function getStoredActiveBoard(
  _owner?: UserStorageOwner | null,
  namespace = captureActiveBoardStorageNamespace(),
): Promise<UserBoard | null> {
  return getPreference<UserBoard>(activeBoardKey(namespace));
}

export function setStoredActiveBoard(
  board: UserBoard,
  _owner?: UserStorageOwner | null,
  namespace = captureActiveBoardStorageNamespace(),
): Promise<void> {
  return setPreference(activeBoardKey(namespace), board);
}

export function clearStoredActiveBoard(
  _owner?: UserStorageOwner | null,
  namespace = captureActiveBoardStorageNamespace(),
): Promise<void> {
  return removePreference(activeBoardKey(namespace));
}
