// Alignment debt: web stores `partyMode` in IndexedDB (non-sensitive UI
// preference). Mobile uses SecureStore here only because mobile hasn't yet
// introduced a non-secret KV mechanism (no AsyncStorage / MMKV / file-backed
// preference helper today). Encryption overhead on a single 6-character
// string is negligible, but conceptually this belongs in a "preferences"
// store, not a "secrets" store. When mobile adopts a non-secret KV — likely
// `@react-native-async-storage/async-storage`, which would require a new
// preview build — migrate this key plus the other non-secret stores
// (`metro-target-store.ts`, board config preferences) together rather than
// piecemeal.

import * as SecureStore from 'expo-secure-store';

const PARTY_MODE_KEY = 'boardsesh_party_mode';

export type StoredPartyMode = 'direct' | 'backend';

function isPartyMode(value: string | null): value is StoredPartyMode {
  return value === 'direct' || value === 'backend';
}

export async function getStoredPartyMode(): Promise<StoredPartyMode | null> {
  try {
    const value = await SecureStore.getItemAsync(PARTY_MODE_KEY);
    return isPartyMode(value) ? value : null;
  } catch {
    return null;
  }
}

export async function setStoredPartyMode(mode: StoredPartyMode): Promise<void> {
  await SecureStore.setItemAsync(PARTY_MODE_KEY, mode);
}
