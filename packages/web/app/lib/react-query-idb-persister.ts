import type { PersistedClient, Persister } from '@tanstack/react-query-persist-client';

import { createIndexedDBStore } from './idb-helper';
import { browserSessionGuard, type SessionGuard } from './auth/session-guard';

const DB_NAME = 'boardsesh-react-query';
const STORE_NAME = 'cache';
const CLIENT_KEY = 'client';
// A blob read before the first session read is hydrated once that read names its owner.
const LATE_RESTORE_WAIT_MS = 30_000;

// 24h: bound IDB blob age and align query gcTime to the same horizon.
// Shared with anywhere that needs to size cache lifetimes around the
// persister window — see use-profile-data.ts and query-client-provider.tsx.
export const PERSIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const getDB = createIndexedDBStore(DB_NAME, STORE_NAME);

type PersistGuard = Pick<SessionGuard, 'viewerKey' | 'isRetiring' | 'whenViewerKnown'>;
/** The blob names the account that wrote it. */
type OwnedClient = { owner: string; client: PersistedClient };

function isOwnedClient(candidate: unknown): candidate is OwnedClient {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const stored = candidate as Partial<OwnedClient>;
  return typeof stored.owner === 'string' && Array.isArray(stored.client?.clientState?.queries);
}

export type IdbPersisterOptions = {
  readonly sessionGuard?: () => PersistGuard;
  /** Hydrates a blob whose owner was confirmed only after restore returned. */
  readonly restoreLate?: (client: PersistedClient) => void;
};

export function createIdbPersister({
  sessionGuard = browserSessionGuard,
  restoreLate,
}: IdbPersisterOptions = {}): Persister {
  let privacyGeneration = 0;
  return {
    persistClient: async (client: PersistedClient) => {
      const guard = sessionGuard();
      // Nothing is written before the account is known or while the page retires.
      const owner = guard.viewerKey();
      if (owner === undefined || guard.isRetiring()) return;
      const writeGeneration = privacyGeneration;
      const db = await getDB();
      if (!db || writeGeneration !== privacyGeneration || guard.isRetiring() || guard.viewerKey() !== owner) return;
      try {
        await db.put(STORE_NAME, { owner, client } satisfies OwnedClient, CLIENT_KEY);
      } catch (error) {
        console.error('Failed to persist react-query cache to IndexedDB:', error);
      }
    },
    restoreClient: async () => {
      const db = await getDB();
      if (!db) return undefined;
      let stored: unknown;
      try {
        stored = await db.get(STORE_NAME, CLIENT_KEY);
      } catch (error) {
        console.error('Failed to restore react-query cache from IndexedDB:', error);
        return undefined;
      }
      // An untagged blob from before the guard, or an empty one, is never restored.
      if (!isOwnedClient(stored) || stored.client.clientState.queries.length === 0) return undefined;
      const owned = stored;
      const guard = sessionGuard();
      // Another account (say, after a switch made on app.boardsesh.com) never sees it.
      const viewer = guard.viewerKey();
      if (viewer !== undefined) return viewer === owned.owner ? owned.client : undefined;
      // React Query holds every query while it restores, so restore never waits
      // for the session read: the blob is hydrated when that read names its owner.
      const restoreGeneration = privacyGeneration;
      if (restoreLate)
        void guard.whenViewerKnown(LATE_RESTORE_WAIT_MS).then(() => {
          if (guard.viewerKey() === owned.owner && restoreGeneration === privacyGeneration && !guard.isRetiring())
            restoreLate(owned.client);
        });
      return undefined;
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
