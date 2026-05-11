import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  getPreference,
  setPreference,
  removePreference,
  getShakeToReportDismissed,
  setShakeToReportDismissed,
  getLastUsedGrade,
  setLastUsedGrade,
} from '../user-preferences-db';
import { DEFAULT_LOGBOOK_PREFERENCES } from '../logbook-preferences';

const DB_NAME = 'boardsesh-user-preferences';
const STORE_NAME = 'preferences';
const META_STORE = 'preferences_meta';
const QUEUE_STORE = 'sync_queue';
const DB_VERSION = 2;
const createStorageShim = () => {
  const store = new Map<string, string>();

  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  };
};

const storage = createStorageShim();

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: storage,
});

beforeEach(async () => {
  storage.clear();
  // Clear the store contents using a separate short-lived connection at
  // the same version the module under test uses.
  const db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
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
  await db.clear(STORE_NAME);
  await db.clear(META_STORE);
  await db.clear(QUEUE_STORE);
  db.close();
});

describe('user-preferences-db', () => {
  describe('setPreference / getPreference', () => {
    it('should store and retrieve a string preference', async () => {
      await setPreference('testKey', 'testValue');
      const result = await getPreference<string>('testKey');
      expect(result).toBe('testValue');
    });

    it('should store and retrieve an object preference', async () => {
      const obj = { foo: 'bar', num: 42 };
      await setPreference('objKey', obj);
      const result = await getPreference<typeof obj>('objKey');
      expect(result).toEqual(obj);
    });

    it('should store and retrieve logbookPreferences', async () => {
      await setPreference('logbookPreferences', DEFAULT_LOGBOOK_PREFERENCES);
      const result = await getPreference('logbookPreferences');
      expect(result).toEqual(DEFAULT_LOGBOOK_PREFERENCES);
    });

    it('should return null for a non-existent key', async () => {
      const result = await getPreference<string>('nonexistent');
      expect(result).toBeNull();
    });

    it('should overwrite an existing preference', async () => {
      await setPreference('key', 'first');
      await setPreference('key', 'second');
      const result = await getPreference<string>('key');
      expect(result).toBe('second');
    });
  });

  describe('removePreference', () => {
    it('should remove an existing preference', async () => {
      await setPreference('toRemove', 'value');
      await removePreference('toRemove');
      const result = await getPreference<string>('toRemove');
      expect(result).toBeNull();
    });

    it('should not throw when removing a non-existent key', async () => {
      await expect(removePreference('nonexistent')).resolves.toBeUndefined();
    });
  });

  describe('localStorage migration', () => {
    it('should migrate climbListViewMode from localStorage on first read', async () => {
      storage.setItem('climbListViewMode', 'grid');

      const result = await getPreference<string>('climbListViewMode');
      expect(result).toBe('grid');

      // localStorage key should be cleaned up
      expect(storage.getItem('climbListViewMode')).toBeNull();
    });

    it('should migrate boardsesh:partyMode from localStorage on first read', async () => {
      storage.setItem('boardsesh:partyMode', 'backend');

      const result = await getPreference<string>('boardsesh:partyMode');
      expect(result).toBe('backend');

      expect(storage.getItem('boardsesh:partyMode')).toBeNull();
    });

    it('should not re-migrate if IndexedDB already has the value', async () => {
      // Pre-populate IndexedDB
      await setPreference('climbListViewMode', 'list');

      // Set a different value in localStorage (simulating stale data)
      storage.setItem('climbListViewMode', 'grid');

      const result = await getPreference<string>('climbListViewMode');
      expect(result).toBe('list');

      // localStorage should remain untouched since migration was skipped
      expect(storage.getItem('climbListViewMode')).toBe('grid');
    });

    it('should return null when neither IndexedDB nor localStorage has the value', async () => {
      const result = await getPreference<string>('climbListViewMode');
      expect(result).toBeNull();
    });

    it('should not attempt migration for keys without a legacy mapping', async () => {
      storage.setItem('someOtherKey', 'value');

      const result = await getPreference<string>('someOtherKey');
      expect(result).toBeNull();

      // localStorage should be untouched
      expect(storage.getItem('someOtherKey')).toBe('value');
    });

    it('should parse JSON values during migration', async () => {
      storage.setItem('climbListViewMode', JSON.stringify({ mode: 'grid' }));

      const result = await getPreference<{ mode: string }>('climbListViewMode');
      expect(result).toEqual({ mode: 'grid' });

      expect(storage.getItem('climbListViewMode')).toBeNull();
    });

    it('should persist migrated value so subsequent reads come from IndexedDB', async () => {
      storage.setItem('climbListViewMode', 'grid');

      // First read triggers migration
      await getPreference<string>('climbListViewMode');

      // Second read should return from IndexedDB (localStorage is already cleared)
      const result = await getPreference<string>('climbListViewMode');
      expect(result).toBe('grid');
    });
  });

  describe('shakeToReport:dismissed', () => {
    it('defaults to false when the preference has never been set', async () => {
      await expect(getShakeToReportDismissed()).resolves.toBe(false);
    });

    it('round-trips true through IndexedDB', async () => {
      await setShakeToReportDismissed(true);
      await expect(getShakeToReportDismissed()).resolves.toBe(true);
    });

    it('can be cleared by writing false', async () => {
      await setShakeToReportDismissed(true);
      await setShakeToReportDismissed(false);
      await expect(getShakeToReportDismissed()).resolves.toBe(false);
    });

    it('coerces non-true stored values to false (defensive)', async () => {
      // Simulate a legacy or corrupted value that isn't strictly boolean true.
      await setPreference('shakeToReport:dismissed', 'yes' as unknown as boolean);
      await expect(getShakeToReportDismissed()).resolves.toBe(false);
    });
  });

  describe('lastUsedGrade', () => {
    it('returns undefined when the preference has never been set', async () => {
      await expect(getLastUsedGrade()).resolves.toBeUndefined();
    });

    it('round-trips a difficulty_id through IndexedDB', async () => {
      await setLastUsedGrade(22);
      await expect(getLastUsedGrade()).resolves.toBe(22);
    });

    it('overwrites the previous value', async () => {
      await setLastUsedGrade(15);
      await setLastUsedGrade(28);
      await expect(getLastUsedGrade()).resolves.toBe(28);
    });

    it('returns undefined when a non-numeric value is stored (defensive)', async () => {
      // Simulate corruption — getLastUsedGrade only trusts number values.
      await setPreference('lastUsedGrade', 'not-a-number' as unknown as number);
      await expect(getLastUsedGrade()).resolves.toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('getPreference should return null and log error on db failure', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Corrupt the store by writing a value, then force an error by
      // closing the underlying connection and operating on a closed db
      const db = await openDB(DB_NAME, DB_VERSION);
      db.close();

      // Re-import with a broken openDB to test error path
      vi.resetModules();
      vi.doMock('idb', () => ({
        openDB: () => Promise.reject(new Error('IndexedDB unavailable')),
      }));
      const mod = await import('../user-preferences-db');

      const result = await mod.getPreference<string>('anyKey');
      expect(result).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith('Failed to get preference:', expect.any(Error));

      errorSpy.mockRestore();
      vi.doUnmock('idb');
    });

    it('setPreference should not throw and log error on db failure', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      vi.resetModules();
      vi.doMock('idb', () => ({
        openDB: () => Promise.reject(new Error('IndexedDB unavailable')),
      }));
      const mod = await import('../user-preferences-db');

      await expect(mod.setPreference('key', 'val')).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith('Failed to save preference:', expect.any(Error));

      errorSpy.mockRestore();
      vi.doUnmock('idb');
    });

    it('removePreference should not throw and log error on db failure', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      vi.resetModules();
      vi.doMock('idb', () => ({
        openDB: () => Promise.reject(new Error('IndexedDB unavailable')),
      }));
      const mod = await import('../user-preferences-db');

      await expect(mod.removePreference('key')).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith('Failed to remove preference:', expect.any(Error));

      errorSpy.mockRestore();
      vi.doUnmock('idb');
    });
  });

  describe('meta + sync queue smoke', () => {
    // Each test imports the modules fresh so the prior `vi.resetModules` /
    // `vi.doMock` calls in the error-handling block can't leak module state.
    it('writes a meta entry when storing a preference', async () => {
      vi.resetModules();
      const mod = await import('../user-preferences-db');
      const before = Date.now();
      await mod.setPreference('libraryTab', 'logbook');
      const meta = await mod.getPreferenceMeta('libraryTab');
      expect(meta).not.toBeNull();
      expect(meta!.updatedAt).toBeGreaterThanOrEqual(before);
    });

    it('clears the meta entry when removing a preference', async () => {
      vi.resetModules();
      const mod = await import('../user-preferences-db');
      await mod.setPreference('libraryTab', 'logbook');
      await mod.removePreference('libraryTab');
      const meta = await mod.getPreferenceMeta('libraryTab');
      expect(meta).toBeNull();
    });

    it('enqueues a set op when a syncable key is written (with sync engine loaded)', async () => {
      vi.resetModules();
      // Mock the GraphQL client so importing the sync engine doesn't try to
      // hit a real backend (just the registerSyncableKeys side-effect matters).
      vi.doMock('../graphql/client', () => ({ executeGraphQL: vi.fn() }));
      // Importing the sync engine registers SYNCABLE_KEYS with the IDB layer.
      await import('../user-preferences-sync');
      const mod = await import('../user-preferences-db');
      await mod.setPreference('libraryTab', 'logbook');
      const queue = await mod.getSyncQueueSnapshot();
      expect(queue).toHaveLength(1);
      expect(queue[0].op).toBe('set');
      expect(queue[0].key).toBe('libraryTab');
      vi.doUnmock('../graphql/client');
    });

    it('does not enqueue ops for non-syncable keys', async () => {
      vi.resetModules();
      vi.doMock('../graphql/client', () => ({ executeGraphQL: vi.fn() }));
      await import('../user-preferences-sync');
      const mod = await import('../user-preferences-db');
      await mod.setPreference('esp32Connections', []);
      const queue = await mod.getSyncQueueSnapshot();
      expect(queue).toHaveLength(0);
      vi.doUnmock('../graphql/client');
    });
  });

  describe('v1 -> v2 migration', () => {
    it('preserves existing v1 preferences across the schema bump', async () => {
      vi.resetModules();
      // Fresh IDB factory to avoid any leftover state.
      const { IDBFactory } = await import('fake-indexeddb');
      (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();

      // Seed a v1 database with a single store, just like the previous schema.
      const v1Db = await openDB(DB_NAME, 1, {
        upgrade(upgradeDb) {
          if (!upgradeDb.objectStoreNames.contains(STORE_NAME)) {
            upgradeDb.createObjectStore(STORE_NAME);
          }
        },
      });
      await v1Db.put(STORE_NAME, 'logbook', 'libraryTab');
      v1Db.close();

      // Now hit the module — it should open at v2, run the upgrade, create
      // the meta + queue stores, and still see the seeded value.
      const mod = await import('../user-preferences-db');
      const value = await mod.getPreference<'logbook' | 'playlists'>('libraryTab');
      expect(value).toBe('logbook');
    });
  });
});
