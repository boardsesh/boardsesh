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

// Known-secret key markers. Genuine SecureStore secrets (auth tokens, refresh
// tokens, credentials) must never reach this plaintext-IndexedDB shim — the
// native writers that hold them have `.web.ts` forks that keep them in memory.
// This denylist turns that convention into an enforced guard: a new native code
// path that writes a real secret through SecureStore trips here on web instead
// of silently persisting cleartext. It deliberately omits `session` and `auth`
// (legitimate non-secret preference/session-id stores use those words).
const SECRET_KEY_MARKERS = ['token', 'password', 'secret', 'credential', 'jwe', 'apikey', 'api_key', 'privatekey'];

function isDev(): boolean {
  // `__DEV__` is the mobile repo convention (Metro/RN define it); the typeof
  // guard keeps this safe under vitest, where the global is not injected.
  return typeof __DEV__ !== 'undefined' && __DEV__;
}

function guardNonSecretKey(key: string): void {
  const normalizedKey = key.toLowerCase();
  if (!SECRET_KEY_MARKERS.some((marker) => normalizedKey.includes(marker))) return;
  const message =
    `SecureStore web shim received a key that looks like secret material ("${key}"). ` +
    'The browser shim persists plaintext to IndexedDB — route secrets through a memory-only ' +
    '`.web.ts` fork instead (see auth-store.web.ts).';
  // Always surface it; fail loudly in development so the drift is caught before
  // it ships, but stay non-fatal in production so an unexpected key can never
  // brick the app. Kept dependency-free (no Sentry import) so the web bundle
  // and this shim's tests stay lightweight.
  console.error(message);
  if (isDev()) throw new Error(message);
}

function storageKey(key: string): string {
  return `${KEY_PREFIX}${key}`;
}

export function isAvailableAsync(): Promise<boolean> {
  return Promise.resolve(typeof indexedDB !== 'undefined');
}

export function getItemAsync(key: string, _options?: SecureStoreOptions): Promise<string | null> {
  return AsyncStorage.getItem(storageKey(key));
}

export async function setItemAsync(key: string, value: string, _options?: SecureStoreOptions): Promise<void> {
  // `async` so a rejected guard surfaces as a promise rejection (matching the
  // native `setItemAsync` contract) rather than a synchronous throw.
  guardNonSecretKey(key);
  await AsyncStorage.setItem(storageKey(key), value);
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
  guardNonSecretKey(key);
  if (isDev()) {
    console.error(
      `[secure-store web-shim] SecureStore.setItem('${key}') is a no-op on web (IndexedDB is async). ` +
        `Use setItemAsync instead — this write was dropped.`,
    );
  }
}

export function deleteItem(key: string, _options?: SecureStoreOptions): void {
  if (isDev()) {
    console.error(
      `[secure-store web-shim] SecureStore.deleteItem('${key}') is a no-op on web (IndexedDB is async). ` +
        `Use deleteItemAsync instead — this delete was dropped.`,
    );
  }
}
