import { createIndexedDBStore } from './idb-helper';
import { isNativeApp } from './ble/capacitor-utils';

export type FeedbackStatus = 'pending' | 'dismissed' | 'submitted';

const STORE_NAME = 'feedback-prompt';
const getDB = createIndexedDBStore('boardsesh-feedback-prompt', STORE_NAME);

const KEY_BLUETOOTH_SENDS = 'bluetoothSends';
const KEY_SEARCHES = 'searches';
const KEY_STATUS = 'status';

const TRIGGER_THRESHOLD = 5;

async function getCount(key: string): Promise<number> {
  try {
    const db = await getDB();
    if (!db) return 0;
    const value = await db.get(STORE_NAME, key);
    return typeof value === 'number' ? value : 0;
  } catch (error) {
    console.error(`Failed to read feedback counter "${key}":`, error);
    return 0;
  }
}

// Non-atomic get→put. Two near-simultaneous increments can collide and lose
// one tick; at a 5-count threshold the worst case is one extra BLE send / search
// before the prompt shows, which is not worth a transaction wrapper.
async function incrementCount(key: string): Promise<number> {
  try {
    const db = await getDB();
    if (!db) return 0;
    const current = await db.get(STORE_NAME, key);
    const next = (typeof current === 'number' ? current : 0) + 1;
    await db.put(STORE_NAME, next, key);
    return next;
  } catch (error) {
    console.error(`Failed to increment feedback counter "${key}":`, error);
    return 0;
  }
}

export async function incrementBluetoothSends(): Promise<number> {
  return incrementCount(KEY_BLUETOOTH_SENDS);
}

export async function incrementSearches(): Promise<number> {
  return incrementCount(KEY_SEARCHES);
}

export async function getFeedbackStatus(): Promise<FeedbackStatus> {
  try {
    const db = await getDB();
    if (!db) return 'pending';
    const value = await db.get(STORE_NAME, KEY_STATUS);
    return value === 'dismissed' || value === 'submitted' ? value : 'pending';
  } catch (error) {
    console.error('Failed to read feedback status:', error);
    return 'pending';
  }
}

export async function setFeedbackStatus(status: FeedbackStatus): Promise<void> {
  try {
    const db = await getDB();
    if (!db) return;
    await db.put(STORE_NAME, status, KEY_STATUS);
  } catch (error) {
    console.error('Failed to write feedback status:', error);
  }
}

// Auto-prompt only surfaces inside the native app, where a 5-star rating
// actually translates to a store review. On web we rely on the manual
// "Send feedback" entry in the user drawer.
export async function shouldShowPrompt(): Promise<boolean> {
  if (!isNativeApp()) return false;
  const status = await getFeedbackStatus();
  if (status !== 'pending') return false;
  const [bluetoothSends, searches] = await Promise.all([getCount(KEY_BLUETOOTH_SENDS), getCount(KEY_SEARCHES)]);
  return bluetoothSends >= TRIGGER_THRESHOLD || searches >= TRIGGER_THRESHOLD;
}

export const FEEDBACK_PROMPT_EVENT = 'boardsesh:show-feedback-prompt';

export async function maybeFireFeedbackPromptEvent(): Promise<void> {
  if (typeof window === 'undefined') return;
  if (await shouldShowPrompt()) {
    window.dispatchEvent(new CustomEvent(FEEDBACK_PROMPT_EVENT));
  }
}
