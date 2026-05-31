// Active-board preference, persisted in **unsecure** AsyncStorage (via
// preference-store) rather than the encrypted SecureStore. The active board is
// a non-secret UI preference — which board the user is currently looking at —
// set from the boards picker and read until they switch. AsyncStorage avoids
// SecureStore's small per-value limit and the keychain round-trip on every read.
//
// Supersedes the SecureStore-backed `board-store.ts` (kept until the remaining
// `useDefaultBoard()` readers migrate — see GitHub issue #2418). A new key is
// used so the two don't collide during the transition.

import { getPreference, setPreference, removePreference } from './preference-store';

export type ActiveBoardConfig = {
  boardUuid: string;
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};

const ACTIVE_BOARD_KEY = 'boardsesh_active_board_v2';

export function getActiveBoard(): Promise<ActiveBoardConfig | null> {
  return getPreference<ActiveBoardConfig>(ACTIVE_BOARD_KEY);
}

export function setActiveBoard(config: ActiveBoardConfig): Promise<void> {
  return setPreference(ACTIVE_BOARD_KEY, config);
}

export function clearActiveBoard(): Promise<void> {
  return removePreference(ACTIVE_BOARD_KEY);
}
