import type { IDBPDatabase } from 'idb';
import type { PersistedClient, Persister } from '@tanstack/react-query-persist-client';

import { createIndexedDBStore } from './idb-helper';

const USER_DB_NAME = 'boardsesh-react-query';
const SHARED_DB_NAME = 'boardsesh-react-query-shared';
const STORE_NAME = 'cache';
const CLIENT_KEY = 'client';

// 24h: bound IDB blob age and align query gcTime to the same horizon.
// Shared with anywhere that needs to size cache lifetimes around the
// persister window — see use-profile-data.ts and query-client-provider.tsx.
export const PERSIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const getUserDB = createIndexedDBStore(USER_DB_NAME, STORE_NAME);
const getSharedDB = createIndexedDBStore(SHARED_DB_NAME, STORE_NAME);

function createPersister(getDB: () => Promise<IDBPDatabase | null>, label: string): Persister {
  return {
    persistClient: async (client: PersistedClient) => {
      const db = await getDB();
      if (!db) return;
      try {
        await db.put(STORE_NAME, client, CLIENT_KEY);
      } catch (error) {
        console.error(`Failed to persist react-query ${label} cache to IndexedDB:`, error);
      }
    },
    restoreClient: async () => {
      const db = await getDB();
      if (!db) return undefined;
      try {
        const restored = (await db.get(STORE_NAME, CLIENT_KEY)) as PersistedClient | undefined;
        return restored;
      } catch (error) {
        console.error(`Failed to restore react-query ${label} cache from IndexedDB:`, error);
        return undefined;
      }
    },
    removeClient: async () => {
      const db = await getDB();
      if (!db) return;
      try {
        await db.delete(STORE_NAME, CLIENT_KEY);
      } catch (error) {
        console.error(`Failed to remove react-query ${label} cache from IndexedDB:`, error);
      }
    },
  };
}

export function createIdbPersister(): Persister {
  return createPersister(getUserDB, 'user');
}

export function createSharedIdbPersister(): Persister {
  return createPersister(getSharedDB, 'shared');
}
