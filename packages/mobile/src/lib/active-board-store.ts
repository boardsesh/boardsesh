// The active board — which board the user is currently looking at — persisted
// in **unsecure** AsyncStorage (via preference-store) rather than the encrypted
// SecureStore. It's a non-secret UI preference: the board picked from the
// boards tab, read until the user switches. AsyncStorage avoids SecureStore's
// small per-value limit and the keychain round-trip on every read, and unlike a
// React Query cache it survives a cold start — so the user's chosen board no
// longer reverts to the server default when the app relaunches.
//
// Store only neutral configuration and the reference. Authorized name, owner
// and location live in privacy-scoped memory, then refresh from the server.
// Legacy full snapshots are sanitized on read so cold starts cannot restore
// withdrawn metadata; the selected wall and angle remain usable offline.
//
// Schema migration note: `getPreference` silently returns null when JSON.parse
// fails, but a stale value whose shape no longer matches `UserBoard` will parse
// successfully and be cast to the wrong type. If `UserBoard` gains required
// fields in a future migration, bump `ACTIVE_BOARD_KEY` so stale values are
// ignored rather than misread.

import type { UserBoard } from '@boardsesh/shared-schema';
import { readActiveBoardSnapshot, writeActiveBoardSnapshot, clearActiveBoardSnapshot } from './active-board-privacy';
import type { UserStorageOwner } from './user-storage-owner';

const ACTIVE_BOARD_KEY = 'boardsesh_active_board_v2';

export function getStoredActiveBoard(_owner?: UserStorageOwner | null): Promise<UserBoard | null> {
  return readActiveBoardSnapshot(ACTIVE_BOARD_KEY);
}

export function setStoredActiveBoard(board: UserBoard, _owner?: UserStorageOwner | null): Promise<void> {
  return writeActiveBoardSnapshot(ACTIVE_BOARD_KEY, board);
}

export function clearStoredActiveBoard(_owner?: UserStorageOwner | null): Promise<void> {
  return clearActiveBoardSnapshot(ACTIVE_BOARD_KEY);
}
