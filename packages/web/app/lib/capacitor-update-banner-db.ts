import { createIndexedDBStore } from './idb-helper';

// Snooze state for the "update your app" nudge shown inside the legacy Capacitor
// WebView. Dismissing snoozes the banner for a week; it re-nudges after that so
// users who haven't migrated keep getting reminded.
const STORE_NAME = 'capacitor-update-banner';
const getDB = createIndexedDBStore('boardsesh-capacitor-update-banner', STORE_NAME);

const KEY_SNOOZED_UNTIL = 'snoozedUntil';
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

export async function isUpdateBannerSnoozed(): Promise<boolean> {
  try {
    const db = await getDB();
    if (!db) return false;
    const snoozedUntil = await db.get(STORE_NAME, KEY_SNOOZED_UNTIL);
    return typeof snoozedUntil === 'number' && snoozedUntil > Date.now();
  } catch (error) {
    console.error('Failed to read update-banner snooze:', error);
    return false;
  }
}

export async function snoozeUpdateBanner(): Promise<void> {
  try {
    const db = await getDB();
    if (!db) return;
    await db.put(STORE_NAME, Date.now() + SNOOZE_MS, KEY_SNOOZED_UNTIL);
  } catch (error) {
    console.error('Failed to write update-banner snooze:', error);
  }
}
