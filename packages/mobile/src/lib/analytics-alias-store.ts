import AsyncStorage from '@react-native-async-storage/async-storage';
import type { AliasDedupeStore } from '@boardsesh/analytics';

const STORAGE_KEY = 'boardsesh:posthog-aliases';
const MAX_STORED_ALIAS_PAIRS = 64;

type AsyncKeyValueStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

function pairKey(profileId: string, userId: string): string {
  return `${profileId}->${userId}`;
}

// The shared reconcileAnalyticsIdentity expects a SYNCHRONOUS AliasDedupeStore
// (web backs it with localStorage). AsyncStorage is async, so this keeps an
// in-memory Set as the synchronous source of truth and only hydrates / persists
// it in the background — best-effort, exactly like web's localStorage store. A
// missed hydrate at worst re-sends one $create_alias, which PostHog tolerates.
export function createAsyncAliasStore(storage: AsyncKeyValueStorage): {
  store: AliasDedupeStore;
  hydrate: () => Promise<void>;
} {
  const recordedPairs = new Set<string>();
  let hydrated = false;

  async function hydrate(): Promise<void> {
    if (hydrated) return;
    hydrated = true;
    try {
      const raw = await storage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      for (const value of parsed) {
        if (typeof value === 'string') recordedPairs.add(value);
      }
    } catch {
      // Corrupt / unavailable storage — start from an empty mirror.
    }
  }

  function persist(): void {
    void storage.setItem(STORAGE_KEY, JSON.stringify([...recordedPairs])).catch(() => {
      // Best-effort: the in-memory mirror still dedupes for this app session.
    });
  }

  const store: AliasDedupeStore = {
    hasRecordedAlias(profileId, userId) {
      return recordedPairs.has(pairKey(profileId, userId));
    },
    recordAlias(profileId, userId) {
      const key = pairKey(profileId, userId);
      if (recordedPairs.has(key)) return;
      recordedPairs.add(key);
      // Bound the set so a device that churns through many identities can't grow
      // it unbounded; evict oldest (insertion order).
      while (recordedPairs.size > MAX_STORED_ALIAS_PAIRS) {
        const oldest = recordedPairs.values().next().value;
        if (oldest === undefined) break;
        recordedPairs.delete(oldest);
      }
      persist();
    },
  };

  return { store, hydrate };
}

// App singleton backed by AsyncStorage. Hydration starts at import so the dedupe
// set is populated before the user signs in (usually well after launch).
const aliasStoreSingleton = createAsyncAliasStore({
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
});

export const aliasDedupeStore = aliasStoreSingleton.store;
export const hydrateAliasStore = aliasStoreSingleton.hydrate;

void hydrateAliasStore();
