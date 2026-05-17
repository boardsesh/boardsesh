import type { BoardName } from '@boardsesh/shared-schema';

import { createIndexedDBStore, migrateFromLocalStorage } from './idb-helper';
import type { LogbookPreferences } from './logbook-preferences';
import type { GradeDisplayFormat } from './grade-colors';

const STORE_NAME = 'preferences';

// Persisted ESP32 emulator connections for the dev-only /development page.
export type Esp32Connection = {
  id: string;
  label: string;
  ip: string;
  board: BoardName;
  serial: string;
  apiLevel: 2 | 3;
  layoutId: number;
  sizeId: number;
  setIds: number[];
  angle: number;
};

export type UserPreferenceKeyMap = {
  libraryTab: 'playlists' | 'logbook';
  logbookPreferences: LogbookPreferences;
  'swipeHint:climbListSeen': boolean;
  'swipeHint:queueBarSeen': boolean;
  'swipeHint:logbookSeen': boolean;
  /**
   * Queue-control-bar pivot Phase 3 first-run coachmark: pulses the lightbulb
   * in the Play View Drawer once, with the tooltip "Send to the wall."
   * Replaces the deleted `swipeHint:playViewSeen` peek animation (the bar's
   * role is now self-evident from its content + driver avatar).
   */
  'swipeHint:lightbulbSeen': boolean;
  tickBarExpanded: boolean;
  'shakeToReport:dismissed': boolean;
  esp32Connections: Esp32Connection[];
  lastUsedGrade: number;
  youLastTab: 'progress' | 'sessions' | 'logbook';
};

// Map of IDB preference keys to their legacy localStorage keys for one-time migration
const LEGACY_LOCALSTORAGE_KEYS: Record<string, string> = {
  climbListViewMode: 'climbListViewMode',
  'boardsesh:partyMode': 'boardsesh:partyMode',
};

// Preference keys that used to live in IndexedDB but were removed from
// UserPreferenceKeyMap. Their stored values would otherwise sit untouched
// in users' stores forever. Cleaned up once per page load on first DB
// access — `delete` is idempotent (no-op when the key isn't present).
const ORPHANED_PREFERENCE_KEYS = [
  // Removed when the queue-control-bar pivot dropped the play-view drawer
  // peek-animation hint in favour of the lightbulb coachmark (`swipeHint:lightbulbSeen`).
  'swipeHint:playViewSeen',
] as const;

const getDBRaw = createIndexedDBStore('boardsesh-user-preferences', STORE_NAME);

let orphanCleanupPromise: Promise<void> | null = null;
const getDB: typeof getDBRaw = async () => {
  const db = await getDBRaw();
  if (db && !orphanCleanupPromise) {
    orphanCleanupPromise = (async () => {
      for (const key of ORPHANED_PREFERENCE_KEYS) {
        try {
          await db.delete(STORE_NAME, key);
        } catch {
          // Idempotent cleanup — swallow per-key failures so one missing/
          // locked key can't block legitimate preference reads.
        }
      }
    })();
  }
  return db;
};

/**
 * Get a preference value from IndexedDB.
 */
export const getPreference = async <T = unknown, K extends string = string>(
  key: K,
): Promise<(K extends keyof UserPreferenceKeyMap ? UserPreferenceKeyMap[K] : T) | null> => {
  try {
    const db = await getDB();
    if (!db) return null;
    const value = await db.get(STORE_NAME, key);
    if (value !== undefined) return value as K extends keyof UserPreferenceKeyMap ? UserPreferenceKeyMap[K] : T;

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
      if (migrated) return migratedValue as K extends keyof UserPreferenceKeyMap ? UserPreferenceKeyMap[K] : T;
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
export const setPreference = async <K extends string>(
  key: K,
  value: K extends keyof UserPreferenceKeyMap ? UserPreferenceKeyMap[K] : unknown,
): Promise<void> => {
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

export type { GradeDisplayFormat } from './grade-colors';
// Re-export so existing consumers don't break.
// The canonical definition lives in grade-colors.ts.

/**
 * Get the "shake to report bug" dismissed preference.
 * When true, the shake detector stays detached for that user.
 */
export const getShakeToReportDismissed = async (): Promise<boolean> => {
  const value = await getPreference<boolean>('shakeToReport:dismissed');
  return value === true;
};

/**
 * Persist the user's decision to disable shake-to-report.
 */
export const setShakeToReportDismissed = async (dismissed: boolean): Promise<void> => {
  await setPreference('shakeToReport:dismissed', dismissed);
};

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

/**
 * Get the last grade the user picked in any grade picker (filter min/max,
 * logbook min/max, playlist target). Used to focus the picker on a familiar
 * grade when it mounts unselected.
 */
export const getLastUsedGrade = async (): Promise<number | undefined> => {
  const value = await getPreference<number>('lastUsedGrade');
  return typeof value === 'number' ? value : undefined;
};

/**
 * Remember the last grade the user picked across grade-picker call sites.
 */
export const setLastUsedGrade = async (difficultyId: number): Promise<void> => {
  await setPreference('lastUsedGrade', difficultyId);
};
