/* oxlint-disable no-restricted-globals -- tests cover one-time localStorage migration */
import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { getRecentSearches, addRecentSearch, getFilterKey, type RecentSearch } from '../recent-searches-storage';

const DB_NAME = 'boardsesh-recent-searches';
const STORE_NAME = 'searches';

beforeEach(async () => {
  localStorage.clear();
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

describe('recent-searches-storage', () => {
  describe('getRecentSearches', () => {
    it('should return empty array when no searches exist', async () => {
      const result = await getRecentSearches();
      expect(result).toEqual([]);
    });
  });

  describe('addRecentSearch', () => {
    it('should add a search and retrieve it', async () => {
      await addRecentSearch('Test search', { minGrade: 10 });
      const results = await getRecentSearches();
      expect(results).toHaveLength(1);
      expect(results[0].label).toBe('Test search');
      expect(results[0].filters).toEqual({ minGrade: 10 });
    });

    it('should add new searches to the front', async () => {
      await addRecentSearch('First', { minGrade: 5 });
      await addRecentSearch('Second', { minGrade: 10 });
      const results = await getRecentSearches();
      expect(results).toHaveLength(2);
      expect(results[0].label).toBe('Second');
      expect(results[1].label).toBe('First');
    });

    it('should deduplicate searches with the same filters', async () => {
      await addRecentSearch('Search A', { minGrade: 10 });
      await addRecentSearch('Search B', { minGrade: 10 });
      const results = await getRecentSearches();
      expect(results).toHaveLength(1);
      expect(results[0].label).toBe('Search B');
    });

    it('should cap at 10 items', async () => {
      for (let i = 0; i < 12; i++) {
        await addRecentSearch(`Search ${i}`, { minGrade: i });
      }
      const results = await getRecentSearches();
      expect(results).toHaveLength(10);
      expect(results[0].label).toBe('Search 11');
    });
  });

  describe('getFilterKey', () => {
    it('should exclude page and pageSize from the key', () => {
      const key1 = getFilterKey({ minGrade: 10, page: 1, pageSize: 20 });
      const key2 = getFilterKey({ minGrade: 10, page: 5, pageSize: 50 });
      expect(key1).toBe(key2);
    });

    it('should produce different keys for different filters', () => {
      const key1 = getFilterKey({ minGrade: 10 });
      const key2 = getFilterKey({ minGrade: 20 });
      expect(key1).not.toBe(key2);
    });
  });

  describe('sanitization of corrupt persisted entries', () => {
    it('should replace undefined numeric fields with defaults on read', async () => {
      // Seed IndexedDB with the exact corrupt shape that crashed iOS Safari:
      // numeric filter fields stored as `undefined`. (Object.assign keeps the
      // property present-with-undefined-value, which is what JSON parsing of
      // older entries produced when the form wrote `|| undefined`.)
      const corruptEntry: RecentSearch = {
        id: 'corrupt-1',
        label: 'Corrupt search',
        filters: {
          minGrade: undefined,
          maxGrade: undefined,
          minAscents: undefined,
          minRating: undefined,
          gradeAccuracy: undefined,
          name: 'climb',
        } as Partial<import('@/app/lib/types').SearchRequestPagination>,
        timestamp: Date.now(),
      };
      const db = await openDB(DB_NAME, 1);
      await db.put(STORE_NAME, [corruptEntry], 'recent');
      db.close();

      const results = await getRecentSearches();
      expect(results).toHaveLength(1);
      expect(results[0].filters.minGrade).toBe(0);
      expect(results[0].filters.maxGrade).toBe(0);
      expect(results[0].filters.minAscents).toBe(0);
      expect(results[0].filters.minRating).toBe(0);
      expect(results[0].filters.gradeAccuracy).toBe(0);
      expect(results[0].filters.name).toBe('climb');
    });

    it('should write the sanitized version back to IndexedDB', async () => {
      const corruptEntry: RecentSearch = {
        id: 'corrupt-1',
        label: 'Corrupt search',
        filters: { minGrade: undefined, maxGrade: 5 } as Partial<import('@/app/lib/types').SearchRequestPagination>,
        timestamp: Date.now(),
      };
      const db = await openDB(DB_NAME, 1);
      await db.put(STORE_NAME, [corruptEntry], 'recent');
      db.close();

      // First read sanitizes and writes back.
      await getRecentSearches();

      // Read directly from IndexedDB to confirm the corrupt undefined is gone.
      const db2 = await openDB(DB_NAME, 1);
      const stored = (await db2.get(STORE_NAME, 'recent')) as RecentSearch[];
      db2.close();
      expect(stored[0].filters.minGrade).toBe(0);
      expect(stored[0].filters.maxGrade).toBe(5);
    });

    it('should sanitize undefined numeric fields on write', async () => {
      await addRecentSearch('From form', {
        minAscents: undefined,
        minGrade: 7,
      } as Partial<import('@/app/lib/types').SearchRequestPagination>);

      const results = await getRecentSearches();
      expect(results).toHaveLength(1);
      expect(results[0].filters.minAscents).toBe(0);
      expect(results[0].filters.minGrade).toBe(7);
    });

    it('should default legacy zone searches to all-holds mode', async () => {
      const legacyZoneEntry: RecentSearch = {
        id: 'legacy-zone',
        label: 'Legacy zone search',
        filters: {
          zoneBox: { edgeLeft: 1, edgeRight: 2, edgeBottom: 3, edgeTop: 4 },
        },
        timestamp: Date.now(),
      };
      const db = await openDB(DB_NAME, 1);
      await db.put(STORE_NAME, [legacyZoneEntry], 'recent');
      db.close();

      const results = await getRecentSearches();
      expect(results[0].filters.zoneMode).toBe('allHolds');

      const db2 = await openDB(DB_NAME, 1);
      const stored = (await db2.get(STORE_NAME, 'recent')) as RecentSearch[];
      db2.close();
      expect(stored[0].filters.zoneMode).toBe('allHolds');
    });
  });

  describe('localStorage migration', () => {
    it('should migrate recent searches from localStorage on first read', async () => {
      const legacyData: RecentSearch[] = [
        {
          id: 'legacy-1',
          label: 'Old search',
          filters: { minGrade: 5 },
          timestamp: Date.now() - 1000,
        },
      ];
      localStorage.setItem('boardsesh_recent_searches', JSON.stringify(legacyData));

      const results = await getRecentSearches();
      expect(results).toHaveLength(1);
      expect(results[0].label).toBe('Old search');
      expect(results[0].id).toBe('legacy-1');

      // localStorage key should be cleaned up
      expect(localStorage.getItem('boardsesh_recent_searches')).toBeNull();
    });

    it('should not re-migrate if IndexedDB already has data', async () => {
      // Add something to IndexedDB first
      await addRecentSearch('New search', { minGrade: 10 });

      // Set legacy data in localStorage
      const legacyData: RecentSearch[] = [
        {
          id: 'legacy-1',
          label: 'Old search',
          filters: { minGrade: 5 },
          timestamp: Date.now() - 1000,
        },
      ];
      localStorage.setItem('boardsesh_recent_searches', JSON.stringify(legacyData));

      const results = await getRecentSearches();
      expect(results).toHaveLength(1);
      expect(results[0].label).toBe('New search');

      // localStorage should remain since migration was skipped
      expect(localStorage.getItem('boardsesh_recent_searches')).not.toBeNull();
    });

    it('should persist migrated data for subsequent reads', async () => {
      const legacyData: RecentSearch[] = [
        {
          id: 'legacy-1',
          label: 'Old search',
          filters: { minGrade: 5 },
          timestamp: Date.now(),
        },
      ];
      localStorage.setItem('boardsesh_recent_searches', JSON.stringify(legacyData));

      // First read triggers migration
      await getRecentSearches();

      // Second read should return from IndexedDB
      const results = await getRecentSearches();
      expect(results).toHaveLength(1);
      expect(results[0].label).toBe('Old search');
    });
  });

  describe('error handling', () => {
    it('getRecentSearches should return empty array on db failure', async () => {
      vi.resetModules();
      vi.doMock('idb', () => ({
        openDB: () => Promise.reject(new Error('IndexedDB unavailable')),
      }));
      const mod = await import('../recent-searches-storage');

      const result = await mod.getRecentSearches();
      expect(result).toEqual([]);

      vi.doUnmock('idb');
    });

    it('addRecentSearch should not throw on db failure', async () => {
      vi.resetModules();
      vi.doMock('idb', () => ({
        openDB: () => Promise.reject(new Error('IndexedDB unavailable')),
      }));
      const mod = await import('../recent-searches-storage');

      await expect(mod.addRecentSearch('test', { minGrade: 5 })).resolves.toBeUndefined();

      vi.doUnmock('idb');
    });
  });

  describe('legacy holdsFilter migration', () => {
    // Pre-#1841 entries persisted holds as { state, color, displayColor }.
    // The new shape is { TYPE: 'include' | 'exclude' }. Legacy entries must
    // round-trip into the new shape on read so the search input passes Zod
    // validation when a stale recent-search pill is tapped.
    async function seedLegacy(filters: object) {
      const db = await openDB(DB_NAME, 1, {
        upgrade(db) {
          if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
        },
      });
      const entry: RecentSearch = { id: 'x', label: 'legacy', filters, timestamp: 1 };
      await db.put(STORE_NAME, [entry], 'recent');
      db.close();
    }

    it('migrates legacy single-state hold entries to {TYPE: include}', async () => {
      await seedLegacy({
        holdsFilter: {
          142: { state: 'STARTING', color: '#abc', displayColor: '#abc' },
          205: { state: 'HAND', color: '#def', displayColor: '#def' },
        },
      });

      const results = await getRecentSearches();
      expect(results[0].filters.holdsFilter).toEqual({
        142: { STARTING: 'include' },
        205: { HAND: 'include' },
      });
    });

    it('migrates legacy NOT to {ANY: exclude} and ANY to {ANY: include}', async () => {
      await seedLegacy({
        holdsFilter: {
          10: { state: 'NOT', color: '#000', displayColor: '#000' },
          11: { state: 'ANY', color: '#fff', displayColor: '#fff' },
        },
      });

      const results = await getRecentSearches();
      expect(results[0].filters.holdsFilter).toEqual({
        10: { ANY: 'exclude' },
        11: { ANY: 'include' },
      });
    });

    it('passes through new-shape entries unchanged', async () => {
      const newShape = { 142: { STARTING: 'include', FOOT: 'exclude' } };
      await seedLegacy({ holdsFilter: newShape });

      const results = await getRecentSearches();
      expect(results[0].filters.holdsFilter).toEqual(newShape);
    });

    it('drops legacy entries with unrecognized state', async () => {
      await seedLegacy({
        holdsFilter: {
          1: { state: 'GIBBERISH', color: '#000', displayColor: '#000' },
          2: { state: 'STARTING', color: '#abc', displayColor: '#abc' },
        },
      });

      const results = await getRecentSearches();
      expect(results[0].filters.holdsFilter).toEqual({ 2: { STARTING: 'include' } });
    });

    it('drops empty {} entries instead of treating them as new-shape', async () => {
      // Vacuous-truth bug guard: `[].every(fn)` is true, so an empty entry
      // could slip through the new-shape check without this explicit length>0
      // guard in `migrateLegacyHoldsFilter`.
      await seedLegacy({ holdsFilter: { 1: {}, 2: { ANY: 'include' } } });

      const results = await getRecentSearches();
      expect(results[0].filters.holdsFilter).toEqual({ 2: { ANY: 'include' } });
    });
  });
});
