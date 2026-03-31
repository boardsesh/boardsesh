import { createIndexedDBStore, migrateFromLocalStorage } from './idb-helper';

const STORE_NAME = 'preferences';

// Map of IDB preference keys to their legacy localStorage keys for one-time migration
const LEGACY_LOCALSTORAGE_KEYS: Record<string, string> = {
  climbListViewMode: 'climbListViewMode',
  'boardsesh:partyMode': 'boardsesh:partyMode',
};

const getDB = createIndexedDBStore('boardsesh-user-preferences', STORE_NAME);

/**
 * Check if an error is a DOMException AbortError (code 20).
 * These are benign on iOS Safari when the page navigates or backgrounds,
 * causing in-flight IndexedDB transactions to abort.
 */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Get a preference value from IndexedDB.
 */
export const getPreference = async <T>(key: string): Promise<T | null> => {
  try {
    const db = await getDB();
    if (!db) return null;

    // Use explicit transaction so we await tx.done, preventing unhandled
    // rejections from the idb library's internal transaction promise.
    const tx = db.transaction(STORE_NAME, 'readonly');
    const value = await tx.store.get(key);
    await tx.done;

    if (value !== undefined) return value as T;

    // Attempt one-time migration from localStorage
    const legacyKey = LEGACY_LOCALSTORAGE_KEYS[key];
    if (legacyKey) {
      let migrated = false;
      let migratedValue: T | null = null;
      await migrateFromLocalStorage<T>(legacyKey, async (val) => {
        const writeTx = db.transaction(STORE_NAME, 'readwrite');
        writeTx.store.put(val, key);
        await writeTx.done;
        migratedValue = val;
        migrated = true;
      });
      if (migrated) return migratedValue;
    }

    return null;
  } catch (error) {
    if (!isAbortError(error)) {
      console.error('Failed to get preference:', error);
    }
    return null;
  }
};

/**
 * Save a preference value to IndexedDB.
 */
export const setPreference = async <T>(key: string, value: T): Promise<void> => {
  try {
    const db = await getDB();
    if (!db) return;
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.store.put(value, key);
    await tx.done;
  } catch (error) {
    if (!isAbortError(error)) {
      console.error('Failed to save preference:', error);
    }
  }
};

/**
 * Remove a preference from IndexedDB.
 */
export const removePreference = async (key: string): Promise<void> => {
  try {
    const db = await getDB();
    if (!db) return;
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.store.delete(key);
    await tx.done;
  } catch (error) {
    if (!isAbortError(error)) {
      console.error('Failed to remove preference:', error);
    }
  }
};

/**
 * Get the "always tick in app" preference.
 */
export const getAlwaysTickInApp = async (): Promise<boolean> => {
  const value = await getPreference<boolean>('alwaysTickInApp');
  return value === true;
};

/**
 * Set the "always tick in app" preference.
 */
export const setAlwaysTickInApp = async (enabled: boolean): Promise<void> => {
  await setPreference('alwaysTickInApp', enabled);
};
