import type { BoardName } from '@boardsesh/shared-schema';
import { openDB, type IDBPDatabase } from 'idb';

import { migrateFromLocalStorage } from './idb-helper';
import type { LogbookPreferences } from './logbook-preferences';
import type { GradeDisplayFormat } from './grade-colors';
import type { ConsentValue } from './consent';

const DB_NAME = 'boardsesh-user-preferences';
const STORE_NAME = 'preferences';
const META_STORE = 'preferences_meta';
const QUEUE_STORE = 'sync_queue';
const DB_VERSION = 2;

// Cap on the number of pending sync ops we keep around. Once a user's queue
// grows past this, we drop the oldest entry (the more recent state wins on
// the server anyway because writes are key-overwriting).
const SYNC_QUEUE_MAX_ENTRIES = 100;

const BROADCAST_CHANNEL_NAME = 'boardsesh:user-preferences';

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
  consent: ConsentValue;
};

export type PreferenceMetaEntry = {
  key: string;
  updatedAt: number;
};

export type SyncQueueEntry =
  | { op: 'set'; key: string; value: unknown; queuedAt: number; attempts?: number }
  | { op: 'delete'; key: string; queuedAt: number; attempts?: number };

export type PreferenceBroadcastMessage = { type: 'set'; key: string; value: unknown } | { type: 'remove'; key: string };

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

let dbPromise: Promise<IDBPDatabase> | null = null;
let orphanCleanupPromise: Promise<void> | null = null;

const getDB = async (): Promise<IDBPDatabase | null> => {
  if (typeof window === 'undefined' || !window.indexedDB) {
    return null;
  }
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        // Idempotent so a fresh install at v2 and an in-place upgrade from v1
        // converge on the same shape.
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE);
        }
        if (!db.objectStoreNames.contains(QUEUE_STORE)) {
          db.createObjectStore(QUEUE_STORE, { autoIncrement: true });
        }
      },
    });
  }
  const db = await dbPromise;
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

let broadcastChannel: BroadcastChannel | null = null;
let broadcastChannelCreated = false;

// Test-only reset helper. Allows tests that mock `idb` to force a fresh
// open against the new mock. Also clears the orphan-cleanup latch and the
// BroadcastChannel singleton so the next test's `getBroadcastChannel()`
// builds a fresh channel against any swapped `globalThis.BroadcastChannel`.
export const __resetDbPromiseForTests = (): void => {
  dbPromise = null;
  orphanCleanupPromise = null;
  if (broadcastChannel) {
    try {
      broadcastChannel.close();
    } catch {
      // ignore — channel may already be torn down
    }
  }
  broadcastChannel = null;
  broadcastChannelCreated = false;
};

const getBroadcastChannel = (): BroadcastChannel | null => {
  if (broadcastChannelCreated) return broadcastChannel;
  broadcastChannelCreated = true;
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') {
    return null;
  }
  try {
    broadcastChannel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
  } catch (error) {
    console.warn('Failed to open preferences BroadcastChannel:', error);
    broadcastChannel = null;
  }
  return broadcastChannel;
};

/**
 * Subscribe to preference change events broadcast across tabs/windows
 * for the current origin. Returns an unsubscribe function.
 */
export const subscribeToPreferenceChanges = (listener: (message: PreferenceBroadcastMessage) => void): (() => void) => {
  const channel = getBroadcastChannel();
  if (!channel) return () => {};
  const handler = (event: MessageEvent<PreferenceBroadcastMessage>) => {
    if (event.data && typeof event.data === 'object' && 'type' in event.data) {
      listener(event.data);
    }
  };
  channel.addEventListener('message', handler);
  return () => {
    channel.removeEventListener('message', handler);
  };
};

const publishPreferenceChange = (message: PreferenceBroadcastMessage): void => {
  const channel = getBroadcastChannel();
  if (!channel) return;
  try {
    channel.postMessage(message);
  } catch (error) {
    console.warn('Failed to publish preference change:', error);
  }
};

const setMetaEntry = async (db: IDBPDatabase, key: string, updatedAt: number): Promise<void> => {
  const entry: PreferenceMetaEntry = { key, updatedAt };
  await db.put(META_STORE, entry, key);
};

const deleteMetaEntry = async (db: IDBPDatabase, key: string): Promise<void> => {
  await db.delete(META_STORE, key);
};

const enqueueSyncOp = async (db: IDBPDatabase, entry: SyncQueueEntry): Promise<void> => {
  const tx = db.transaction(QUEUE_STORE, 'readwrite');
  const store = tx.objectStore(QUEUE_STORE);
  await store.add(entry);

  // Bound the queue size — drop the oldest entries (lowest autoIncrement
  // keys) when over the cap. We use a direct `getAllKeys` + slice + delete
  // batch rather than a cursor iteration: `getAllKeys` returns keys in
  // insertion order, and a small slice deletion is easier to reason about
  // than the cursor.continue() loop it replaces.
  const count = await store.count();
  if (count > SYNC_QUEUE_MAX_ENTRIES) {
    const overflow = count - SYNC_QUEUE_MAX_ENTRIES;
    const orderedKeys = await store.getAllKeys();
    const oldest = orderedKeys.slice(0, overflow);
    for (const key of oldest) {
      await store.delete(key);
    }
  }
  await tx.done;
};

// The sync engine registers its SYNCABLE_KEYS set at module-load time via
// {@link registerSyncableKeys}. We keep the registration out of this file
// (and have the sync engine import this one rather than the other way
// around) so there's no circular dependency.
let syncableKeyMatcher: ((key: string) => boolean) | null = null;

export const registerSyncableKeys = (matcher: (key: string) => boolean): void => {
  syncableKeyMatcher = matcher;
};

const isSyncableKey = (key: string): boolean => {
  if (!syncableKeyMatcher) return false;
  return syncableKeyMatcher(key);
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
        await setMetaEntry(db, key, Date.now());
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
 * Sync-engine entry point for writing a preference whose key is only known
 * at runtime (e.g. when reconciling local-only keys against the server in
 * `pullInitial`). Same behavior as {@link setPreference} — the only reason
 * for the split is that `setPreference`'s conditional `value` type does
 * not unify with `unknown` at a string-keyed call site without forcing a
 * `as never` cast. Type-correct call sites should prefer `setPreference`.
 */
export const setPreferenceUntyped = (key: string, value: unknown): Promise<void> => {
  return setPreference(key as keyof UserPreferenceKeyMap, value as never);
};

/**
 * Save a preference value to IndexedDB. Updates the meta store, broadcasts
 * the change to other tabs, and enqueues the op for upstream sync when the
 * key is in the SYNCABLE_KEYS set.
 */
export const setPreference = async <K extends string>(
  key: K,
  value: K extends keyof UserPreferenceKeyMap ? UserPreferenceKeyMap[K] : unknown,
): Promise<void> => {
  try {
    const db = await getDB();
    if (!db) return;
    const updatedAt = Date.now();
    await db.put(STORE_NAME, value, key);
    await setMetaEntry(db, key, updatedAt);
    publishPreferenceChange({ type: 'set', key, value });
    if (isSyncableKey(key)) {
      await enqueueSyncOp(db, { op: 'set', key, value, queuedAt: updatedAt });
    }
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
    await deleteMetaEntry(db, key);
    publishPreferenceChange({ type: 'remove', key });
    if (isSyncableKey(key)) {
      await enqueueSyncOp(db, { op: 'delete', key, queuedAt: Date.now() });
    }
  } catch (error) {
    console.error('Failed to remove preference:', error);
  }
};

/**
 * Silent variant of {@link setPreference} used by the sync engine when
 * pulling state down from the server. Writes the value + meta with the
 * provided server timestamp, broadcasts to other tabs so hooks update,
 * and intentionally skips the sync queue so we don't echo back a write
 * we just received.
 */
export const setPreferenceFromServer = async (key: string, value: unknown, serverUpdatedAt: number): Promise<void> => {
  try {
    const db = await getDB();
    if (!db) return;
    await db.put(STORE_NAME, value, key);
    await setMetaEntry(db, key, serverUpdatedAt);
    publishPreferenceChange({ type: 'set', key, value });
  } catch (error) {
    console.error('Failed to apply server preference:', error);
  }
};

/**
 * Silent variant of {@link removePreference} used when the sync engine
 * observes that a preference is missing on the server. Deletes the local
 * row and meta entry, broadcasts to other tabs, and intentionally skips
 * the sync queue — otherwise we'd echo the delete back up and undo
 * whatever device originally removed it.
 */
export const removePreferenceFromServer = async (key: string): Promise<void> => {
  try {
    const db = await getDB();
    if (!db) return;
    await db.delete(STORE_NAME, key);
    await deleteMetaEntry(db, key);
    publishPreferenceChange({ type: 'remove', key });
  } catch (error) {
    console.error('Failed to apply server preference deletion:', error);
  }
};

/**
 * IDB key under which we stash the timestamp of the most recent successful
 * `pullInitial` round-trip. Lives in the meta store next to per-key
 * timestamps; the leading double-underscore + colon namespace keeps it
 * separate from real preference keys (which are constrained to
 * `^[a-zA-Z][a-zA-Z0-9:_-]{0,63}$` by the backend regex — they can never
 * start with `_`).
 */
const LAST_PULLED_AT_META_KEY = '__sync:lastPulledAt';

/**
 * Read the timestamp (ms) of the last successful pull from the backend.
 * Returns 0 when this device has never pulled — callers should treat 0 as
 * "any local pref absent from the server is brand-new, push it up".
 */
export const getLastSyncPulledAt = async (): Promise<number> => {
  try {
    const db = await getDB();
    if (!db) return 0;
    const entry = (await db.get(META_STORE, LAST_PULLED_AT_META_KEY)) as PreferenceMetaEntry | undefined;
    if (!entry || typeof entry.updatedAt !== 'number') return 0;
    return entry.updatedAt;
  } catch (error) {
    console.error('Failed to read lastPulledAt:', error);
    return 0;
  }
};

export const setLastSyncPulledAt = async (timestamp: number): Promise<void> => {
  try {
    const db = await getDB();
    if (!db) return;
    await db.put(META_STORE, { key: LAST_PULLED_AT_META_KEY, updatedAt: timestamp }, LAST_PULLED_AT_META_KEY);
  } catch (error) {
    console.error('Failed to write lastPulledAt:', error);
  }
};

/**
 * Read meta updatedAt for a key. Returns null when there's no local entry,
 * which the sync engine treats as "the server wins".
 */
export const getPreferenceMeta = async (key: string): Promise<PreferenceMetaEntry | null> => {
  try {
    const db = await getDB();
    if (!db) return null;
    const entry = (await db.get(META_STORE, key)) as PreferenceMetaEntry | undefined;
    return entry ?? null;
  } catch (error) {
    console.error('Failed to read preference meta:', error);
    return null;
  }
};

/**
 * Read every locally-stored syncable preference along with its meta
 * timestamp. Used by the sync engine to decide which orphaned local
 * entries need to be pushed up to the server.
 */
export const getAllSyncablePreferences = async (): Promise<
  Array<{ key: string; value: unknown; updatedAt: number }>
> => {
  try {
    const db = await getDB();
    if (!db) return [];

    // Preference keys are always strings — every call site goes through
    // setPreference<K extends string> — so it's safe to coerce here.
    const [rawKeys, rawMetaKeys] = await Promise.all([db.getAllKeys(STORE_NAME), db.getAllKeys(META_STORE)]);
    const keys = rawKeys.filter((candidate): candidate is string => typeof candidate === 'string');
    const metaKeys = rawMetaKeys.filter((candidate): candidate is string => typeof candidate === 'string');

    // Fetch every meta entry in parallel rather than awaiting each in turn —
    // a serial loop here was O(n) round-trips through the IDB request queue.
    const metaEntries = await Promise.all(
      metaKeys.map(async (metaKey) => {
        const metaEntry = (await db.get(META_STORE, metaKey)) as PreferenceMetaEntry | undefined;
        return [metaKey, metaEntry] as const;
      }),
    );
    const metaByKey = new Map<string, number>();
    for (const [metaKey, metaEntry] of metaEntries) {
      if (metaEntry) metaByKey.set(metaKey, metaEntry.updatedAt);
    }

    // Same story for the syncable preference values themselves.
    const syncableKeys = keys.filter(isSyncableKey);
    const valueEntries = await Promise.all(
      syncableKeys.map(async (key) => {
        const value = await db.get(STORE_NAME, key);
        return [key, value] as const;
      }),
    );

    const out: Array<{ key: string; value: unknown; updatedAt: number }> = [];
    for (const [key, value] of valueEntries) {
      if (value === undefined) continue;
      out.push({
        key,
        value,
        updatedAt: metaByKey.get(key) ?? 0,
      });
    }
    return out;
  } catch (error) {
    console.error('Failed to enumerate syncable preferences:', error);
    return [];
  }
};

/**
 * Snapshot of the pending sync queue, oldest-first. Each returned entry
 * carries the IDB primary key so callers can delete it after a successful
 * upstream write.
 */
export type SyncQueueSnapshotEntry = SyncQueueEntry & { id: IDBValidKey };

export const getSyncQueueSnapshot = async (): Promise<SyncQueueSnapshotEntry[]> => {
  try {
    const db = await getDB();
    if (!db) return [];
    const keys = await db.getAllKeys(QUEUE_STORE);
    const values = (await db.getAll(QUEUE_STORE)) as SyncQueueEntry[];
    const result: SyncQueueSnapshotEntry[] = [];
    for (let index = 0; index < keys.length; index += 1) {
      const entry = values[index];
      if (entry) {
        result.push({ ...entry, id: keys[index] });
      }
    }
    return result;
  } catch (error) {
    console.error('Failed to read sync queue:', error);
    return [];
  }
};

export const deleteSyncQueueEntry = async (id: IDBValidKey): Promise<void> => {
  try {
    const db = await getDB();
    if (!db) return;
    await db.delete(QUEUE_STORE, id);
  } catch (error) {
    console.error('Failed to delete sync queue entry:', error);
  }
};

/**
 * Persist an updated attempts counter on a queue entry without changing
 * the auto-increment key (so FIFO ordering is preserved). Used by the
 * sync engine to skip past entries that just failed, without losing
 * them — they retry on the next flush.
 */
export const updateSyncQueueEntryAttempts = async (id: IDBValidKey, attempts: number): Promise<void> => {
  try {
    const db = await getDB();
    if (!db) return;
    const tx = db.transaction(QUEUE_STORE, 'readwrite');
    const store = tx.objectStore(QUEUE_STORE);
    const existing = (await store.get(id)) as SyncQueueEntry | undefined;
    if (!existing) {
      await tx.done;
      return;
    }
    await store.put({ ...existing, attempts }, id);
    await tx.done;
  } catch (error) {
    console.error('Failed to update sync queue entry attempts:', error);
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
