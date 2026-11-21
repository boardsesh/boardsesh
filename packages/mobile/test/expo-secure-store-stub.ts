// Vitest stub for `expo-secure-store`.
//
// The real package loads expo's runtime (expo/build/winter), which does not
// resolve under vitest's node environment, so any suite that transitively
// imports a SecureStore-backed module would fail to load before a single test
// runs. auth.ts and auth-interceptor.ts reach it through device-token-store.ts
// (#7656) even in suites that mock auth-store itself.
//
// This stub is an in-memory key-value map that ignores options (one namespace).
// Suites that assert keychain behaviour — namespaces, accessibility, failures —
// register their own `vi.mock('expo-secure-store', ...)`, which takes precedence
// over this alias.
//
// Wired via the `expo-secure-store` alias in packages/mobile/vite.config.ts.

const store = new Map<string, string>();

export const AFTER_FIRST_UNLOCK = 'AFTER_FIRST_UNLOCK';

export type SecureStoreOptions = { keychainService?: string; keychainAccessible?: string };

export async function getItemAsync(key: string, _options?: SecureStoreOptions): Promise<string | null> {
  return store.get(key) ?? null;
}

export async function setItemAsync(key: string, value: string, _options?: SecureStoreOptions): Promise<void> {
  store.set(key, value);
}

export async function deleteItemAsync(key: string, _options?: SecureStoreOptions): Promise<void> {
  store.delete(key);
}

export function getItem(key: string, _options?: SecureStoreOptions): string | null {
  return store.get(key) ?? null;
}

export function setItem(key: string, value: string, _options?: SecureStoreOptions): void {
  store.set(key, value);
}

export function deleteItem(key: string, _options?: SecureStoreOptions): void {
  store.delete(key);
}
