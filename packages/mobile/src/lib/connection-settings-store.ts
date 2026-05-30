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
