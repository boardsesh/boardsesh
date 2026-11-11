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

// Legacy namespace: the default keychain service ("app"). Items written here
// before #3602 shipped carry kSecAttrAccessibleWhenUnlocked and CANNOT be
// upgraded in place — expo-secure-store's iOS set() only reaches SecItemAdd for an
// item that doesn't exist yet; an existing item takes the errSecDuplicateItem
// branch into update(), whose update dictionary is kSecValueData ONLY
// (SecureStoreModule.swift:127-144). Accessibility is left untouched, and JS
// cannot read kSecAttrAccessible back to notice. Delete-then-add is no better:
// deleteValueWithKeyAsync discards all three SecItemDelete statuses and never
// throws, so a failed delete silently degrades the re-add into that same no-op
// update, and the read-back sees the right value either way. See issue #4103.
export const SECURE_STORE_WRITE_OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible };

// v2 namespace: a keychain service we have never used, so every write into it is a
// guaranteed-fresh SecItemAdd that applies kSecAttrAccessible at
// SecureStoreModule.swift:98. Copying a value here is what actually resets
// accessibility, and the presence of a v2 item IS the durable per-key record that
// the key has migrated — nothing to keep in sync, and it stays true after a
// restore onto a new device (AFTER_FIRST_UNLOCK items travel in encrypted
// backups, so a version marker would arrive claiming work that never happened).
export const V2_KEYCHAIN_SERVICE = 'boardsesh.v2';

// iOS ONLY. On Android keychainService selects both the KeyStore alias and the
// SharedPreferences storage key (SecureStoreOptions.kt:12, SecureStoreModule.kt:92,
// 102, 179), so setting it would strand every existing Android value behind a name
// nothing reads. Android's KeyStore has no accessibility class to fix in the first
// place, and the web shim ignores options entirely — on both platforms these
// helpers stay byte-for-byte today's behaviour.
//
// Read from process.env.EXPO_OS, which babel-preset-expo replaces with the build
// platform (configs/expo.js:214), rather than react-native's Platform: every
// SecureStore-backed store imports this module, and a static `react-native`
// import would drag RN 0.86's Flow entry into their pure test graphs, where
// Rolldown parses it at collection time before any vi.mock applies. That trap is
// documented at packages/mobile/vite.config.ts:284-298.
export const USES_V2_NAMESPACE = process.env.EXPO_OS === 'ios';

export const SECURE_STORE_V2_OPTIONS: SecureStore.SecureStoreOptions = USES_V2_NAMESPACE
  ? { keychainAccessible, keychainService: V2_KEYCHAIN_SERVICE }
  : { keychainAccessible };
