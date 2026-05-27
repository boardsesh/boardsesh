import { type IDBPDatabase, openDB } from 'idb';
import type { HoldFilterEntry, HoldFilterType, HoldsFilter, SearchRequestPagination } from '@/app/lib/types';
import { DEFAULT_SEARCH_PARAMS } from '@/app/lib/url-utils';

export type RecentSearch = {
  id: string;
  label: string;
  filters: Partial<SearchRequestPagination>;
  timestamp: number;
};

export const RECENT_SEARCHES_CHANGED_EVENT = 'boardsesh:recent-searches-changed';
const DB_NAME = 'boardsesh-recent-searches';
const DB_VERSION = 1;
const STORE_NAME = 'searches';
const STORE_KEY = 'recent';
const MAX_ITEMS = 10;
const LEGACY_STORAGE_KEY = 'boardsesh_recent_searches';

// Numeric filter fields that the form historically wrote as `undefined` and
// that searchParamsToUrlParams used to crash on. Cleaned up on read.
const NUMERIC_FILTER_FIELDS = ['minGrade', 'maxGrade', 'minAscents', 'minRating', 'gradeAccuracy'] as const;

const LEGACY_HOLD_TYPES: ReadonlySet<HoldFilterType> = new Set(['STARTING', 'HAND', 'FINISH', 'FOOT', 'ANY']);

/**
 * Recent-search entries persisted before #1841 stored each hold as
 * `{ state, color, displayColor }`. The new HoldsFilter shape is
 * `{ holdId: { TYPE: 'include' | 'exclude' } }`. Migrate on read so old
 * entries don't blow up Zod validation when the user taps a stale pill.
 *
 * Returns `{entry, migrated}` so the caller knows whether to write the
 * cleaned shape back to IndexedDB.
 */
function migrateLegacyHoldsFilter(raw: SearchRequestPagination['holdsFilter'] | undefined): {
  holdsFilter: HoldsFilter | undefined;
  migrated: boolean;
} {
  if (!raw || typeof raw !== 'object') return { holdsFilter: raw as HoldsFilter | undefined, migrated: false };
  const sourceKeyCount = Object.keys(raw).length;
  let migrated = false;
  const out: HoldsFilter = {};
  for (const [holdIdRaw, value] of Object.entries(raw as Record<string, unknown>)) {
    const holdId = Number(holdIdRaw);
    if (!Number.isInteger(holdId) || holdId <= 0 || !value || typeof value !== 'object') continue;
    const values = Object.values(value as Record<string, unknown>);
    // `[].every()` is vacuously true, so an empty entry would pass the
    // "new shape" check and stick around as noise. Require at least one
    // include/exclude value before keeping it.
    const valuesAreNewShape = values.length > 0 && values.every((v) => v === 'include' || v === 'exclude');
    if (valuesAreNewShape) {
      out[holdId] = value as HoldFilterEntry;
      continue;
    }
    // Legacy: `{ state: 'STARTING' | 'HAND' | 'FINISH' | 'FOOT' | 'ANY' | 'NOT', color, displayColor }`.
    const legacyState = (value as { state?: unknown }).state;
    if (typeof legacyState !== 'string') continue;
    const entry: HoldFilterEntry = {};
    if (legacyState === 'NOT') {
      entry.ANY = 'exclude';
    } else if (LEGACY_HOLD_TYPES.has(legacyState as HoldFilterType)) {
      entry[legacyState as HoldFilterType] = 'include';
    } else {
      continue;
    }
    out[holdId] = entry;
    migrated = true;
  }
  // Treat dropped entries (empties / invalid IDs / unknown states) as a
  // migration too — otherwise the caller keeps the original noisy shape.
  if (Object.keys(out).length !== sourceKeyCount) migrated = true;
  return { holdsFilter: out, migrated };
}

/**
 * Replace `undefined` numeric fields with their defaults. Older entries
 * persisted by the search drawer can contain `undefined` for these fields,
 * which violates the SearchRequestPagination type and crashed serialization
 * on iOS (see Sentry issues 7434008446 / 7435688419 / 7439815956).
 *
 * Also migrates legacy `holdsFilter` shapes (pre-#1841) to the new
 * type→mode map so old recent-search pills don't blow up backend Zod.
 */
function sanitizeFilters(filters: Partial<SearchRequestPagination>): {
  filters: Partial<SearchRequestPagination>;
  changed: boolean;
} {
  let changed = false;
  const cleaned: Partial<SearchRequestPagination> = { ...filters };
  for (const field of NUMERIC_FILTER_FIELDS) {
    if (field in cleaned && cleaned[field] === undefined) {
      cleaned[field] = DEFAULT_SEARCH_PARAMS[field];
      changed = true;
    }
  }
  if (cleaned.holdsFilter) {
    const { holdsFilter, migrated } = migrateLegacyHoldsFilter(cleaned.holdsFilter);
    if (migrated) {
      cleaned.holdsFilter = holdsFilter;
      changed = true;
    }
  }
  const rawZoneMode = cleaned.zoneMode;
  if (rawZoneMode !== undefined && rawZoneMode !== 'allHolds' && rawZoneMode !== 'anyHold') {
    cleaned.zoneMode = DEFAULT_SEARCH_PARAMS.zoneMode;
    changed = true;
  }
  if (cleaned.zoneBox && cleaned.zoneMode === undefined) {
    cleaned.zoneMode = DEFAULT_SEARCH_PARAMS.zoneMode;
    changed = true;
  }
  if (!cleaned.zoneBox && cleaned.zoneMode && cleaned.zoneMode !== DEFAULT_SEARCH_PARAMS.zoneMode) {
    cleaned.zoneMode = DEFAULT_SEARCH_PARAMS.zoneMode;
    changed = true;
  }
  return { filters: cleaned, changed };
}

let dbPromise: Promise<IDBPDatabase | null> | null = null;

const initDB = async (): Promise<IDBPDatabase | null> => {
  if (typeof window === 'undefined' || !window.indexedDB) {
    return null;
  }
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      },
      terminated() {
        dbPromise = null;
      },
    }).catch(() => {
      dbPromise = null;
      return null;
    });
  }
  return dbPromise;
};

export function getFilterKey(filters: Partial<SearchRequestPagination>): string {
  // Exclude page/pageSize from comparison since they're not meaningful for deduplication
  const { page: _page, pageSize: _pageSize, ...rest } = filters as SearchRequestPagination;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

export async function getRecentSearches(): Promise<RecentSearch[]> {
  if (typeof window === 'undefined') return [];
  try {
    const db = await initDB();
    if (!db) return [];
    const data = (await db.get(STORE_NAME, STORE_KEY)) as RecentSearch[] | undefined;
    if (data) {
      let anyChanged = false;
      const cleaned = data.map((entry) => {
        const { filters, changed } = sanitizeFilters(entry.filters);
        if (changed) anyChanged = true;
        return changed ? { ...entry, filters } : entry;
      });
      // One-time write-back so the corrupt undefined values stop coming back on every read.
      if (anyChanged) {
        await db.put(STORE_NAME, cleaned, STORE_KEY);
      }
      return cleaned;
    }

    // Attempt one-time migration from localStorage
    // oxlint-disable-next-line no-restricted-globals -- one-time migration from legacy localStorage
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) {
      const parsed = (JSON.parse(legacy) as RecentSearch[]).map((entry) => ({
        ...entry,
        filters: sanitizeFilters(entry.filters).filters,
      }));
      await db.put(STORE_NAME, parsed, STORE_KEY);
      // oxlint-disable-next-line no-restricted-globals -- one-time migration cleanup
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      return parsed;
    }

    return [];
  } catch (error) {
    console.error('Failed to get recent searches:', error);
    return [];
  }
}

export async function addRecentSearch(label: string, filters: Partial<SearchRequestPagination>): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    const sanitized = sanitizeFilters(filters).filters;
    const existing = await getRecentSearches();
    const filterKey = getFilterKey(sanitized);

    // Remove duplicate if exists
    const deduplicated = existing.filter((s) => getFilterKey(s.filters) !== filterKey);

    const newEntry: RecentSearch = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      label,
      filters: sanitized,
      timestamp: Date.now(),
    };

    // Add to front, cap at MAX_ITEMS
    const updated = [newEntry, ...deduplicated].slice(0, MAX_ITEMS);
    const db = await initDB();
    if (!db) return;
    await db.put(STORE_NAME, updated, STORE_KEY);
    window.dispatchEvent(new CustomEvent(RECENT_SEARCHES_CHANGED_EVENT));
  } catch (error) {
    console.error('Failed to add recent search:', error);
  }
}
