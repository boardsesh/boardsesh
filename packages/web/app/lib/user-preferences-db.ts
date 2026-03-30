import { createIndexedDBStore, migrateFromLocalStorage } from './idb-helper';

const STORE_NAME = 'preferences';

// Map of IDB preference keys to their legacy localStorage keys for one-time migration
const LEGACY_LOCALSTORAGE_KEYS: Record<string, string> = {
  climbListViewMode: 'climbListViewMode',
  'boardsesh:partyMode': 'boardsesh:partyMode',
};

const getDB = createIndexedDBStore('boardsesh-user-preferences', STORE_NAME);

/**
 * Get a preference value from IndexedDB.
 */
export const getPreference = async <T>(key: string): Promise<T | null> => {
  try {
    const db = await getDB();
    if (!db) return null;
    const value = await db.get(STORE_NAME, key);
    if (value !== undefined) return value as T;

    // Attempt one-time migration from localStorage
    const legacyKey = LEGACY_LOCALSTORAGE_KEYS[key];
    if (legacyKey) {
      let migrated = false;
      let migratedValue: T | null = null;
      await migrateFromLocalStorage<T>(legacyKey, async (val) => {
        await db.put(STORE_NAME, val, key);
        migratedValue = val;
        migrated = true;
      });
      if (migrated) return migratedValue;
    }

    return null;
  } catch (error) {
    console.error('Failed to get preference:', error);
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
    await db.put(STORE_NAME, value, key);
  } catch (error) {
    console.error('Failed to save preference:', error);
  }
};

/**
 * Remove a preference from IndexedDB.
 */
export const removePreference = async (key: string): Promise<void> => {
  try {
    const db = await getDB();
    if (!db) return;
    await db.delete(STORE_NAME, key);
  } catch (error) {
    console.error('Failed to remove preference:', error);
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

export type GradeDisplayFormat = 'v-grade' | 'font';

/**
 * Get the grade display format preference.
 * Defaults to 'v-grade' if not set.
 */
export const getGradeDisplayFormat = async (): Promise<GradeDisplayFormat> => {
  const value = await getPreference<GradeDisplayFormat>('gradeDisplayFormat');
  return value === 'font' ? 'font' : 'v-grade';
};

/**
 * Set the grade display format preference.
 */
export const setGradeDisplayFormat = async (format: GradeDisplayFormat): Promise<void> => {
  await setPreference('gradeDisplayFormat', format);
};
