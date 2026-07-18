import AsyncStorage from './async-storage';

// NON-SECRET VALUES ONLY. This is the browser shim for `expo-secure-store`. On
// native, SecureStore is backed by the iOS Keychain / Android Keystore; in the
// browser there is no equivalent, so this shim persists to plain IndexedDB with
// NO encryption. Anything written here is readable cleartext by any script on
// the origin. It exists purely so non-secret preference stores (last search,
// last grade) keep working on web.
//
// Never route authentication tokens or credentials through here. Web auth
// deliberately does NOT use this shim: `auth-store.web.ts` holds the session in
// the NextAuth cookie (see `auth-cookie-lock.web.ts`), never in web storage.
// Keep it that way — see the "Never persist authentication tokens in that store"
// rule in CLAUDE.md (Expo web section).

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
// The write stubs can't persist anything, so a caller reaching for the sync API
// on web is a latent bug (a write that silently vanishes). Shout about it in dev
// so it surfaces at the call site instead of as missing data later.
export function getItem(_key: string, _options?: SecureStoreOptions): string | null {
  return null;
}

export function setItem(key: string, _value: string, _options?: SecureStoreOptions): void {
  if (__DEV__) {
    console.error(
      `[secure-store web-shim] SecureStore.setItem('${key}') is a no-op on web (IndexedDB is async). ` +
        `Use setItemAsync instead — this write was dropped.`,
    );
  }
}

export function deleteItem(key: string, _options?: SecureStoreOptions): void {
  if (__DEV__) {
    console.error(
      `[secure-store web-shim] SecureStore.deleteItem('${key}') is a no-op on web (IndexedDB is async). ` +
        `Use deleteItemAsync instead — this delete was dropped.`,
    );
  }
}
