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
  'queueControlBar:collapsed': boolean;
  'queueControlBar:createCollapsed': boolean;
  tickBarExpanded: boolean;
  'shakeToReport:dismissed': boolean;
  esp32Connections: Esp32Connection[];
};

// Map of IDB preference keys to their legacy localStorage keys for one-time migration
const LEGACY_LOCALSTORAGE_KEYS: Record<string, string> = {
  climbListViewMode: 'climbListViewMode',
  'boardsesh:partyMode': 'boardsesh:partyMode',
};

const getDB = createIndexedDBStore('boardsesh-user-preferences', STORE_NAME);

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
