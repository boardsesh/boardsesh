import AsyncStorage from './async-storage';

export type SecureStoreOptions = {
  keychainAccessible?: string;
  requireAuthentication?: boolean;
  authenticationPrompt?: string;
  keychainService?: string;
};

export const AFTER_FIRST_UNLOCK = 'AFTER_FIRST_UNLOCK';

const KEY_PREFIX = 'secure:';

function storageKey(key: string): string {
  return `${KEY_PREFIX}${key}`;
}

export function isAvailableAsync(): Promise<boolean> {
  return Promise.resolve(typeof indexedDB !== 'undefined');
}

export function getItemAsync(key: string, _options?: SecureStoreOptions): Promise<string | null> {
  return AsyncStorage.getItem(storageKey(key));
}

export function setItemAsync(key: string, value: string, _options?: SecureStoreOptions): Promise<void> {
  return AsyncStorage.setItem(storageKey(key), value);
}

export function deleteItemAsync(key: string, _options?: SecureStoreOptions): Promise<void> {
  return AsyncStorage.removeItem(storageKey(key));
}

// IndexedDB is asynchronous. Browser code that needs persistence must use the
// async API; these sync compatibility methods intentionally expose no value.
export function getItem(_key: string, _options?: SecureStoreOptions): string | null {
  return null;
}

export function setItem(_key: string, _value: string, _options?: SecureStoreOptions): void {}

export function deleteItem(_key: string, _options?: SecureStoreOptions): void {}
