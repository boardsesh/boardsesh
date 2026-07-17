import * as SecureStore from 'expo-secure-store';
import { SECURE_STORE_WRITE_OPTIONS } from './secure-store-options';
import type { UserStorageOwner } from './user-storage-owner';

const SESSION_ID_KEY = 'boardsesh_active_session_id';

export async function getStoredSessionId(_owner?: UserStorageOwner | null): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(SESSION_ID_KEY);
  } catch {
    return null;
  }
}

export async function setStoredSessionId(sessionId: string, _owner?: UserStorageOwner | null): Promise<void> {
  await SecureStore.setItemAsync(SESSION_ID_KEY, sessionId, SECURE_STORE_WRITE_OPTIONS);
}

export async function clearStoredSessionId(_owner?: UserStorageOwner | null): Promise<void> {
  await SecureStore.deleteItemAsync(SESSION_ID_KEY);
}
