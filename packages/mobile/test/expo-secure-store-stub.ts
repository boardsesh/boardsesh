// Vitest stub for `expo-secure-store`.
//
// Same problem as the expo-file-system / expo-image / expo-haptics stubs next to
// this file: expo-secure-store's `main` points at TypeScript source, which imports
// expo-modules-core bindings whose untransformed declarations blow up in Vitest's
// module worker ("Cannot read properties of undefined (reading 'EventEmitter')")
// before the TS transform runs. Any suite that transitively reaches the
// SecureStore preferences adapter — DrawerHostProvider does, via the onboarding
// tip flags — crashes at import time without this.
//
// The store is intentionally EMPTY and inert rather than in-memory: a stub that
// remembered writes would leak keys between suites sharing a worker. Every read
// reports "absent", which is the fresh-install answer and the safe default for
// every preference in the app. Suites that need real values register their own
// `vi.mock` (which takes precedence over this alias) or mock the adapter seam,
// `src/lib/preferences/secure-store-adapter`, as the onboarding suites do.
//
// Wired via the `expo-secure-store` alias in packages/mobile/vite.config.ts.

export async function getItemAsync(): Promise<string | null> {
  return null;
}

export async function setItemAsync(): Promise<void> {}

export async function deleteItemAsync(): Promise<void> {}

export async function isAvailableAsync(): Promise<boolean> {
  return false;
}

export function getItem(): string | null {
  return null;
}

export function setItem(): void {}

export const WHEN_UNLOCKED = 'whenUnlocked';
export const AFTER_FIRST_UNLOCK = 'afterFirstUnlock';
export const ALWAYS = 'always';
export const WHEN_PASSCODE_SET_THIS_DEVICE_ONLY = 'whenPasscodeSetThisDeviceOnly';
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 'whenUnlockedThisDeviceOnly';
export const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY = 'afterFirstUnlockThisDeviceOnly';
export const ALWAYS_THIS_DEVICE_ONLY = 'alwaysThisDeviceOnly';
