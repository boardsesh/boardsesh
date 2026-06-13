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
// successfully and be cast to the wrong type. `useActiveBoard()` hydrates old
// v2 boards that predate `UserBoard.id` by UUID before board-id-dependent
// ticking uses them.

import type { UserBoard } from '@boardsesh/shared-schema';
import { getPreference, setPreference, removePreference } from './preference-store';

const ACTIVE_BOARD_KEY = 'boardsesh_active_board_v2';

export function getStoredActiveBoard(): Promise<UserBoard | null> {
  return getPreference<UserBoard>(ACTIVE_BOARD_KEY);
}

export function setStoredActiveBoard(board: UserBoard): Promise<void> {
  return setPreference(ACTIVE_BOARD_KEY, board);
}

export function clearStoredActiveBoard(): Promise<void> {
  return removePreference(ACTIVE_BOARD_KEY);
}
