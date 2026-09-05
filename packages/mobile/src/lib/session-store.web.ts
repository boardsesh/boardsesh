import * as SecureStore from 'expo-secure-store';
import { SECURE_STORE_WRITE_OPTIONS } from './secure-store-options';
import { CREATED_SESSION_ID_KEY, SESSION_ID_KEY } from './session-store-keys';
import { userScopedStorageKey } from './user-storage-owner.web';
import type { UserStorageOwner } from './user-storage-owner';

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

/**
 * Id of the session THIS DEVICE started (as opposed to joined) — web
 * counterpart of session-store.ts's getStoredCreatedSessionId/set/clear. See
 * that file for the full rationale (device provenance, why losing it is
 * harmless). Scoped per signed-in user like the active-session keys above,
 * via the current owner set by setCurrentUserStorageOwner.
 */
export async function getStoredCreatedSessionId(): Promise<string | null> {
  const storageKey = userScopedStorageKey(CREATED_SESSION_ID_KEY);
  if (!storageKey) return null;
  try {
    return await SecureStore.getItemAsync(storageKey);
  } catch {
    return null;
  }
}

export function setStoredCreatedSessionId(sessionId: string): Promise<void> {
  const storageKey = userScopedStorageKey(CREATED_SESSION_ID_KEY);
  if (!storageKey) return Promise.resolve();
  return SecureStore.setItemAsync(storageKey, sessionId, SECURE_STORE_WRITE_OPTIONS);
}

export function clearStoredCreatedSessionId(): Promise<void> {
  const storageKey = userScopedStorageKey(CREATED_SESSION_ID_KEY);
  if (!storageKey) return Promise.resolve();
  return SecureStore.deleteItemAsync(storageKey);
}
