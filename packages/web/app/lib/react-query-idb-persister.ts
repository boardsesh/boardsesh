import type { PersistedClient, Persister } from '@tanstack/react-query-persist-client';

import { createIndexedDBStore } from './idb-helper';

const DB_NAME = 'boardsesh-react-query';
const STORE_NAME = 'cache';
const CLIENT_KEY = 'client';

// 24h: bound IDB blob age and align query gcTime to the same horizon.
// Shared with anywhere that needs to size cache lifetimes around the
// persister window — see use-profile-data.ts and query-client-provider.tsx.
export const PERSIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const getDB = createIndexedDBStore(DB_NAME, STORE_NAME);

export function createIdbPersister(): Persister {
  let privacyGeneration = 0;
  return {
    persistClient: async (client: PersistedClient) => {
      const writeGeneration = privacyGeneration;
      const db = await getDB();
      if (!db || writeGeneration !== privacyGeneration) return;
      try {
        await db.put(STORE_NAME, client, CLIENT_KEY);
      } catch (error) {
        console.error('Failed to persist react-query cache to IndexedDB:', error);
      }
    },
    restoreClient: async () => {
      const db = await getDB();
      if (!db) return undefined;
      try {
        const restored = (await db.get(STORE_NAME, CLIENT_KEY)) as PersistedClient | undefined;
        return restored;
      } catch (error) {
        console.error('Failed to restore react-query cache from IndexedDB:', error);
        return undefined;
      }
    },
    removeClient: async () => {
      privacyGeneration += 1;
      const db = await getDB();
      if (!db) return;
      try {
        await db.delete(STORE_NAME, CLIENT_KEY);
      } catch (error) {
        console.error('Failed to remove react-query cache from IndexedDB:', error);
      }
    },
  };
}
