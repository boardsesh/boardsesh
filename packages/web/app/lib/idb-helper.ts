import { openDB, type IDBPDatabase } from 'idb';

type UpgradeCallback = (db: IDBPDatabase) => void;

/**
 * Creates a lazy-initialized IndexedDB store with the standard SSR guard pattern.
 * Returns a function that resolves to the database instance (or null if not available).
 */
export function createIndexedDBStore(
  dbName: string,
  storeName: string,
  version: number = 1,
  upgradeCallback?: UpgradeCallback,
): () => Promise<IDBPDatabase | null> {
  let dbPromise: Promise<IDBPDatabase | null> | null = null;

  return async (): Promise<IDBPDatabase | null> => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      return null;
    }
    if (!dbPromise) {
      dbPromise = openDB(dbName, version, {
        upgrade(db) {
          if (upgradeCallback) {
            upgradeCallback(db);
          } else if (!db.objectStoreNames.contains(storeName)) {
            db.createObjectStore(storeName);
          }
        },
        terminated() {
          // Browser deleted the database (storage pressure, user cleared data,
          // in-app browser eviction). Reset so the next call re-opens a fresh
          // connection instead of reusing the dead handle.
          dbPromise = null;
        },
      }).catch(() => {
        // openDB rejected (database already deleted, quota exceeded, etc.).
        // Reset so a subsequent call retries instead of caching the rejection.
        dbPromise = null;
        return null;
      });
    }
    return dbPromise;
  };
}

/**
 * One-time migration helper: reads a value from localStorage, writes it to IndexedDB via the
 * provided setter, then removes the localStorage key.
 *
 * @param legacyKey - The localStorage key to read from
 * @param idbSetter - An async function that persists the value into IndexedDB
 * @param parser - Optional transform applied to the raw localStorage string. Defaults to JSON.parse with a plain-string fallback.
 * @returns true if migration was performed
 */
export async function migrateFromLocalStorage<T>(
  legacyKey: string,
  idbSetter: (value: T) => Promise<void>,
  parser?: (raw: string) => T,
): Promise<boolean> {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    // oxlint-disable-next-line no-restricted-globals -- one-time migration from legacy localStorage
    const raw = localStorage.getItem(legacyKey);
    if (raw === null) {
      return false;
    }

    let parsed: T;
    if (parser) {
      parsed = parser(raw);
    } else {
      try {
        parsed = JSON.parse(raw) as T;
      } catch {
        parsed = raw as unknown as T;
      }
    }

    await idbSetter(parsed);
    // oxlint-disable-next-line no-restricted-globals -- one-time migration cleanup
    localStorage.removeItem(legacyKey);
    return true;
  } catch (error) {
    console.error(`Failed to migrate localStorage key "${legacyKey}":`, error);
    return false;
  }
}
