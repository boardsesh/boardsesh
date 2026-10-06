import * as SecureStore from 'expo-secure-store';
import type { PartyProfile, PartyProfileStorage } from '@boardsesh/party-profile';
import { SECURE_STORE_WRITE_OPTIONS } from './secure-store-options';

// Deliberately NOT migrated to the v2 keychain namespace (#4103), which is why
// this file still writes through SECURE_STORE_WRITE_OPTIONS rather than
// secure-store-io. A locked-device read here already fails safe: the read
// throws and the catch returns null, with no Sentry event, so this key is not
// part of the background-read failures #4103 fixes. The id is the party-session
// peer identity only. PostHog no longer uses it as an analytics id (see
// packages/shared/analytics/src/reconcile-identity.ts). See
// preference-secure-keys.ts.
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
    await SecureStore.setItemAsync(PARTY_PROFILE_KEY, JSON.stringify(profile), SECURE_STORE_WRITE_OPTIONS);
  },
};
