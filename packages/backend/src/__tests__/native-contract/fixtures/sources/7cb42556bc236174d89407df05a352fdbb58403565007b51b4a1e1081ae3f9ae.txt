import * as SecureStore from 'expo-secure-store';

// Shared write options for every SecureStore.setItemAsync / setItem call in the
// app. AFTER_FIRST_UNLOCK lets background reads (token refresh, Live Activity, WS
// reconnect, background fetch) succeed once the device has been unlocked at least
// once since boot, instead of the WHEN_UNLOCKED default that rejects with
// "User interaction is not allowed" on a locked device. keychainAccessible is a
// write-time option, so reads inherit whatever the item was written with — every
// writer must pass this for a read to stay accessible in the background.
// See issue #3602 / Sentry BOARDSESH-7P.
//
// The `in` guard keeps the constant read from throwing under a test double that
// mocks expo-secure-store without re-exporting AFTER_FIRST_UNLOCK (Vitest factory
// mocks throw on undefined exports). In that case the option resolves to
// undefined, which the mock's setItemAsync ignores; the real native module always
// exports it.
const keychainAccessible = 'AFTER_FIRST_UNLOCK' in SecureStore ? SecureStore.AFTER_FIRST_UNLOCK : undefined;

export const SECURE_STORE_WRITE_OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible };
