import * as SecureStore from 'expo-secure-store';
import {
  SORT_OPTIONS,
  STATUS_FILTER_VALUES,
  hasActiveClimbFilters,
  hasActiveBoardFilters,
  normalizeRetiredStatus,
  DEFAULT_CLIMB_BOARD_FILTER_STATE,
  type BoardSearchConfig,
  type ClimbBoardFilterState,
} from '@boardsesh/climb-filters';
import type { ClimbFilters } from './climb-filter-types';
import { AUTH_GATED_FIELDS } from './recent-filter-store';
import { CURRENT_FILTER_SCHEMA_VERSION, normalizePersistedClimbFilters } from './filter-persistence';

export type LastSearch = {
  filters: ClimbFilters;
  boardFilters: ClimbBoardFilterState;
  searchText: string;
  updatedAt: number;
  filterSchemaVersion?: number;
};

// One secure-store key holds a JSON map of boardConfigKey -> LastSearch so we
// can remember the last applied search per board config. Capped to bound
// growth when a user hops across many board configs.
const LAST_SEARCH_KEY = 'boardsesh_last_search_by_board';
const MAX_BOARDS = 20;

type LastSearchMap = Record<string, LastSearch>;

/**
 * Stable key from a resolved board config
 * (`boardName|layoutId|sizeId|setIds|angle`). Two configs that differ in any
 * field get distinct keys, so each board restores its own last search.
 */
export function boardConfigKey(board: BoardSearchConfig): string {
  return `${board.boardName}|${board.layoutId}|${board.sizeId}|${board.setIds}|${board.angle}`;
}

function isValidLastSearch(entry: unknown): entry is LastSearch {
  if (entry == null || typeof entry !== 'object') return false;
  const candidate = entry as {
    filters?: { sortBy?: unknown; status?: unknown };
    searchText?: unknown;
    updatedAt?: unknown;
  };
  if (typeof candidate.searchText !== 'string') return false;
  if (typeof candidate.updatedAt !== 'number') return false;
  const filters = candidate.filters;
  if (filters == null) return false;
  if (typeof filters.sortBy !== 'string' || !(SORT_OPTIONS as readonly string[]).includes(filters.sortBy)) {
    return false;
  }
  // Missing status is normalized later (older app versions wrote entries before
  // the field existed); an unknown status value is dropped.
  if (filters.status != null && !(STATUS_FILTER_VALUES as readonly string[]).includes(filters.status as string)) {
    return false;
  }
  return true;
}

// Backfill defaults for fields added after older entries were written:
// `status` (else a missing status renders as "active" since
// `hasActiveClimbFilters` treats `undefined !== 'any'` as a change) and
// `boardFilters` (older entries predate per-board board filters).
function normalizeEntry(entry: LastSearch): LastSearch {
  let next = entry;
  if (next.filters.status == null) {
    next = { ...next, filters: { ...next.filters, status: 'any' } };
  }
  // Retire legacy status='established' → 'any' (keeping minAscents) so restored
  // state never carries a status the UI can't show / clear.
  next = {
    ...next,
    filterSchemaVersion: CURRENT_FILTER_SCHEMA_VERSION,
    filters: normalizePersistedClimbFilters(normalizeRetiredStatus(next.filters), next.filterSchemaVersion),
  };
  if (next.boardFilters == null || typeof next.boardFilters !== 'object' || Array.isArray(next.boardFilters)) {
    next = { ...next, boardFilters: DEFAULT_CLIMB_BOARD_FILTER_STATE };
  }
  return next;
}

function stripAuthGatedFields(filters: ClimbFilters): ClimbFilters {
  const sanitized = { ...filters };
  for (const field of AUTH_GATED_FIELDS) {
    delete sanitized[field];
  }
  return sanitized;
}

async function readMap(): Promise<LastSearchMap> {
  try {
    const value = await SecureStore.getItemAsync(LAST_SEARCH_KEY);
    if (!value) return {};
    const parsed: unknown = JSON.parse(value);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: LastSearchMap = {};
    for (const [key, entry] of Object.entries(parsed)) {
      if (isValidLastSearch(entry)) {
        result[key] = normalizeEntry(entry);
      }
    }
    return result;
  } catch {
    return {};
  }
}

// Keep the map bounded to the most-recently-updated boards.
function capMap(map: LastSearchMap): LastSearchMap {
  const keys = Object.keys(map);
  if (keys.length <= MAX_BOARDS) return map;
  const keep = keys.sort((a, b) => map[b].updatedAt - map[a].updatedAt).slice(0, MAX_BOARDS);
  const capped: LastSearchMap = {};
  for (const key of keep) {
    capped[key] = map[key];
  }
  return capped;
}

/**
 * Returns the saved last search for this board, or `null` if the board has
 * never been searched. Pass `isAuthenticated = false` to strip auth-gated
 * filters so a search saved while signed in doesn't silently no-op on the
 * backend for a signed-out user.
 */
export async function getLastSearch(
  board: BoardSearchConfig,
  options?: { isAuthenticated?: boolean },
): Promise<LastSearch | null> {
  const map = await readMap();
  const entry = map[boardConfigKey(board)];
  if (entry == null) return null;
  if (options?.isAuthenticated === false) {
    return { ...entry, filters: stripAuthGatedFields(entry.filters) };
  }
  return entry;
}

/**
 * Persists the current search for this board. When the search is back at the
 * clean default (no active filters AND empty name) any saved entry for the
 * board is *deleted* — so a climber who clears their search and returns later
 * gets the clean default instead of a resurrected stale search.
 */
export async function saveLastSearch(
  board: BoardSearchConfig,
  filters: ClimbFilters,
  searchText: string,
  boardFilters: ClimbBoardFilterState = DEFAULT_CLIMB_BOARD_FILTER_STATE,
): Promise<void> {
  try {
    const key = boardConfigKey(board);
    if (!hasActiveClimbFilters(filters) && !hasActiveBoardFilters(boardFilters) && searchText.trim() === '') {
      const map = await readMap();
      if (key in map) {
        delete map[key];
        await SecureStore.setItemAsync(LAST_SEARCH_KEY, JSON.stringify(map));
      }
      return;
    }
    const map = await readMap();
    map[key] = {
      filters,
      boardFilters,
      searchText,
      updatedAt: Date.now(),
      filterSchemaVersion: CURRENT_FILTER_SCHEMA_VERSION,
    };
    const capped = capMap(map);
    await SecureStore.setItemAsync(LAST_SEARCH_KEY, JSON.stringify(capped));
  } catch {
    // Storage failure is non-critical.
  }
}

export async function clearLastSearch(board: BoardSearchConfig): Promise<void> {
  try {
    const map = await readMap();
    const key = boardConfigKey(board);
    if (!(key in map)) return;
    delete map[key];
    await SecureStore.setItemAsync(LAST_SEARCH_KEY, JSON.stringify(map));
  } catch {
    // Storage failure is non-critical.
  }
}

export async function clearAllLastSearches(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(LAST_SEARCH_KEY);
  } catch {
    // Storage failure is non-critical.
  }
}
