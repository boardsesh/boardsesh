import type { UserBoard } from '@boardsesh/shared-schema';
import { getPreference, removePreference, setPreference } from './preference-store';
import { userScopedStorageKey } from './user-storage-owner.web';
import type { UserStorageOwner } from './user-storage-owner';

const ACTIVE_BOARD_KEY = 'boardsesh_active_board_v2';

export function getStoredActiveBoard(owner?: UserStorageOwner | null): Promise<UserBoard | null> {
  const storageKey = userScopedStorageKey(ACTIVE_BOARD_KEY, owner);
  return storageKey ? getPreference<UserBoard>(storageKey) : Promise.resolve(null);
}

export function setStoredActiveBoard(board: UserBoard, owner?: UserStorageOwner | null): Promise<void> {
  const storageKey = userScopedStorageKey(ACTIVE_BOARD_KEY, owner);
  return storageKey ? setPreference(storageKey, board) : Promise.resolve();
}

export function clearStoredActiveBoard(owner?: UserStorageOwner | null): Promise<void> {
  const storageKey = userScopedStorageKey(ACTIVE_BOARD_KEY, owner);
  return storageKey ? removePreference(storageKey) : Promise.resolve();
}
