import AsyncStorage from '@react-native-async-storage/async-storage';
import type { PartyProfile, PartyProfileStorage } from '@boardsesh/party-profile';

const PARTY_PROFILE_KEY = 'boardsesh_party_profile';

export const partyProfileStorage: PartyProfileStorage = {
  async get(): Promise<PartyProfile | null> {
    try {
      const raw = await AsyncStorage.getItem(PARTY_PROFILE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { id?: unknown };
      return typeof parsed.id === 'string' && parsed.id.length > 0 ? { id: parsed.id } : null;
    } catch {
      return null;
    }
  },
  async set(profile: PartyProfile): Promise<void> {
    await AsyncStorage.setItem(PARTY_PROFILE_KEY, JSON.stringify(profile));
  },
};

// IndexedDB has no synchronous API. The web analytics bootstrap defers identity
// reconciliation to PartyProfileProvider's async load instead.
export function getOrCreatePartyProfileIdSync(): null {
  return null;
}
