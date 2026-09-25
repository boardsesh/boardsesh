import * as SecureStore from 'expo-secure-store';
import { randomUUID } from 'expo-crypto';
import type { PartyProfile, PartyProfileStorage } from '@boardsesh/party-profile';
import { SECURE_STORE_WRITE_OPTIONS } from './secure-store-options';

// Deliberately NOT migrated to the v2 keychain namespace (#4103), which is why
// this file still writes through SECURE_STORE_WRITE_OPTIONS rather than
// secure-store-io. A locked-device read here already fails safe: getItem throws,
// the catch returns null, and PostHog falls back to its own anonymous id — no
// Sentry event and no user-visible effect, so this key is not part of the
// background-read failures #4103 fixes. Migrating it would only restore
// analytics linkage on locked background launches, which does not justify
// touching the identity key inside a change to credential storage. See
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

// Synchronous get-or-create, backed by expo-secure-store's JSI sync API rather
// than the async one above. Exists solely for analytics-bootstrap.ts, which
// resolves the party-profile UUID at module-eval time so posthog-client.ts can
// bootstrap the PostHog SDK's anonymous id with it before the SDK's
// app-lifecycle autocapture fires — see analytics-bootstrap.ts for why that
// ordering matters. Reads and writes the same key as partyProfileStorage, so
// the two never disagree: this runs once at bundle-eval time, strictly before
// PartyProfileProvider's async effect can fire, so there's no write race
// between them. Never throws — a locked keychain or unavailable JSI just
// yields `null`, and the caller falls back to today's behavior (PostHog's own
// anonymous id).
export function getOrCreatePartyProfileIdSync(generateId: () => string = randomUUID): string | null {
  try {
    const raw = SecureStore.getItem(PARTY_PROFILE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { id?: unknown };
      if (typeof parsed.id === 'string' && parsed.id.length > 0) return parsed.id;
    }
    const created: PartyProfile = { id: generateId() };
    SecureStore.setItem(PARTY_PROFILE_KEY, JSON.stringify(created), SECURE_STORE_WRITE_OPTIONS);
    return created.id;
  } catch (error) {
    // Dev-only: this failing means the PostHog bootstrap silently falls back to
    // an unlinked anonymous id (see analytics-bootstrap.ts) with no other
    // symptom — worth a breadcrumb if the install-funnel fix looks ineffective.
    if (__DEV__) console.warn('[analytics] failed to resolve party-profile id synchronously', error);
    return null;
  }
}
