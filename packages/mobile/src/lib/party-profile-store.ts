import * as SecureStore from 'expo-secure-store';
import type { PartyProfile, PartyProfileStorage } from '@boardsesh/party-profile';

const PARTY_PROFILE_KEY = 'boardsesh_party_profile';

export const partyProfileStorage: PartyProfileStorage = {
  async get(): Promise<PartyProfile | null> {
    try {
      const raw = await SecureStore.getItemAsync(PARTY_PROFILE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { id?: unknown };
      if (typeof parsed.id !== 'string' || parsed.id.length === 0) return null;
      return { id: parsed.id };
    } catch {
      return null;
    }
  },
  async set(profile: PartyProfile): Promise<void> {
    await SecureStore.setItemAsync(PARTY_PROFILE_KEY, JSON.stringify(profile));
  },
};
