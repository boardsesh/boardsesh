import * as SecureStore from 'expo-secure-store';
import { SECURE_STORE_WRITE_OPTIONS } from './secure-store-options';
import { userScopedStorageKey } from './user-storage-owner.web';
import type { UserStorageOwner } from './user-storage-owner';

const SESSION_ID_KEY = 'boardsesh_active_session_id';

export async function getStoredSessionId(owner?: UserStorageOwner | null): Promise<string | null> {
  const storageKey = userScopedStorageKey(SESSION_ID_KEY, owner);
  if (!storageKey) return null;
  try {
    return await SecureStore.getItemAsync(storageKey);
  } catch {
    return null;
  }
}

export function setStoredSessionId(sessionId: string, owner?: UserStorageOwner | null): Promise<void> {
  const storageKey = userScopedStorageKey(SESSION_ID_KEY, owner);
  if (!storageKey) return Promise.resolve();
  return SecureStore.setItemAsync(storageKey, sessionId, SECURE_STORE_WRITE_OPTIONS);
}

export function clearStoredSessionId(owner?: UserStorageOwner | null): Promise<void> {
  const storageKey = userScopedStorageKey(SESSION_ID_KEY, owner);
  if (!storageKey) return Promise.resolve();
  return SecureStore.deleteItemAsync(storageKey);
}
