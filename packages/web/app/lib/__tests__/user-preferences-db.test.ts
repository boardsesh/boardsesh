import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  getPreference,
  setPreference,
  removePreference,
  getLastUsedGrade,
  setLastUsedGrade,
} from '../user-preferences-db';
import { DEFAULT_LOGBOOK_PREFERENCES } from '../logbook-preferences';

const DB_NAME = 'boardsesh-user-preferences';
const STORE_NAME = 'preferences';
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
  // Clear the store contents using a separate short-lived connection
  const db = await openDB(DB_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    },
  });
  await db.clear(STORE_NAME);
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
    it('getPreference should return null on db failure', async () => {
      vi.resetModules();
      vi.doMock('idb', () => ({
        openDB: () => Promise.reject(new Error('IndexedDB unavailable')),
      }));
      const mod = await import('../user-preferences-db');

      const result = await mod.getPreference<string>('anyKey');
      expect(result).toBeNull();

      vi.doUnmock('idb');
    });

    it('setPreference should not throw on db failure', async () => {
      vi.resetModules();
      vi.doMock('idb', () => ({
        openDB: () => Promise.reject(new Error('IndexedDB unavailable')),
      }));
      const mod = await import('../user-preferences-db');

      await expect(mod.setPreference('key', 'val')).resolves.toBeUndefined();

      vi.doUnmock('idb');
    });

    it('removePreference should not throw on db failure', async () => {
      vi.resetModules();
      vi.doMock('idb', () => ({
        openDB: () => Promise.reject(new Error('IndexedDB unavailable')),
      }));
      const mod = await import('../user-preferences-db');

      await expect(mod.removePreference('key')).resolves.toBeUndefined();

      vi.doUnmock('idb');
    });
  });
});
