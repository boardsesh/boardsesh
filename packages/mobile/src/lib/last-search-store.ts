import { readSecureValue, writeSecureValue } from './secure-store-io';
import {
  SORT_OPTIONS,
  STATUS_FILTER_VALUES,
  hasActiveClimbFilters,
  hasActiveBoardFilters,
  normalizeRetiredFilters,
  DEFAULT_CLIMB_BOARD_FILTER_STATE,
  type BoardSearchConfig,
  type ClimbBoardFilterState,
} from '@boardsesh/climb-filters';
import type { ClimbFilters } from './climb-filter-types';
import { AUTH_GATED_FIELDS } from './recent-filter-store';
import { boardGeometryKey, withoutGeometryFilters } from './climb-filter-session-reducer';

export type LastSearch = {
  filters: ClimbFilters;
  boardFilters: ClimbBoardFilterState;
  searchText: string;
  /**
   * The board (`boardGeometryKey`: board, layout, size and hold sets; angle
   * left out) the climb name and the hold and zone picks were made on. Those
   * only make sense on that board; every other filter follows the climber to
   * any board and angle.
   */
  boardKey: string;
  updatedAt: number;
};

// One search follows the climber across boards and angles. The key and its
// JSON-map shape are kept from when each board config had its own entry
// (`boardConfigKey -> LastSearch`): the key is pinned in the keychain
// migration list (preference-secure-keys.ts), and an older bundle reading the
// new map just finds no entry for its board. Writes now leave one entry under
// LATEST_ENTRY; reads take the newest valid entry, so a map an older bundle
// wrote still restores the climber's last search.
export const LAST_SEARCH_KEY = 'boardsesh_last_search_by_board';
const LATEST_ENTRY = 'latest';

type StoredLastSearch = Omit<LastSearch, 'boardKey'> & { boardKey?: unknown };

/**
 * Stable key from a resolved board config
 * (`boardName|layoutId|sizeId|setIds|angle`). Scopes per-screen UI sessions
 * (playlist and setter filter sheets) to one board config.
 */
export function boardConfigKey(board: BoardSearchConfig): string {
  return `${boardGeometryKey(board)}|${board.angle}`;
}

// Entries written by older bundles are keyed by boardConfigKey and carry no
// boardKey; their map key minus the trailing `|angle` is the board.
function boardKeyFromLegacyMapKey(mapKey: string): string {
  const lastSeparator = mapKey.lastIndexOf('|');
  return lastSeparator === -1 ? mapKey : mapKey.slice(0, lastSeparator);
}

function isValidLastSearch(entry: unknown): entry is StoredLastSearch {
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
// `hasActiveClimbFilters` treats `undefined !== 'any'` as a change),
// `boardFilters` (older entries predate per-board board filters) and
// `boardKey` (older entries were keyed by board config instead).
function normalizeEntry(entry: StoredLastSearch, mapKey: string): LastSearch {
  const boardKey = typeof entry.boardKey === 'string' ? entry.boardKey : boardKeyFromLegacyMapKey(mapKey);
  let next: LastSearch = { ...entry, boardKey };
  if (next.filters.status == null) {
    next = { ...next, filters: { ...next.filters, status: 'any' } };
  }
  // Retire legacy status='established' → 'any' (keeping minAscents) so restored
  // state never carries a status the UI can't show / clear.
  next = { ...next, filters: normalizeRetiredFilters(next.filters) };
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

async function readNewestEntry(): Promise<LastSearch | null> {
  try {
    const value = await readSecureValue(LAST_SEARCH_KEY);
    if (!value) return null;
    const parsed: unknown = JSON.parse(value);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    let newest: LastSearch | null = null;
    for (const [mapKey, entry] of Object.entries(parsed)) {
      if (!isValidLastSearch(entry)) continue;
      if (newest === null || entry.updatedAt > newest.updatedAt) newest = normalizeEntry(entry, mapKey);
    }
    return newest;
  } catch {
    return null;
  }
}

/**
 * Returns the climber's last search as it applies on `board`, or `null` if
 * nothing is saved. The filters come back whatever board or angle they were
 * set on. The climb name and the hold and zone picks come back only on the
 * board they were set on, at any angle; on any other board they are cleared. Pass `isAuthenticated = false` to strip
 * auth-gated filters so a search saved while signed in doesn't silently no-op
 * on the backend for a signed-out user.
 */
export async function getLastSearch(
  board: BoardSearchConfig,
  options?: { isAuthenticated?: boolean },
): Promise<LastSearch | null> {
  const entry = await readNewestEntry();
  if (entry == null) return null;
  const sameBoard = entry.boardKey === boardGeometryKey(board);
  return {
    ...entry,
    filters: options?.isAuthenticated === false ? stripAuthGatedFields(entry.filters) : entry.filters,
    searchText: sameBoard ? entry.searchText : '',
    boardFilters: sameBoard ? entry.boardFilters : withoutGeometryFilters(entry.boardFilters),
  };
}

/**
 * Persists the current search, replacing whatever was saved before (on any
 * board). When the search is back at the clean default (no active filters AND
 * empty name) the saved search is cleared, so a climber who clears their
 * search and returns later gets the clean default instead of a resurrected
 * stale search.
 */
export async function saveLastSearch(
  board: BoardSearchConfig,
  filters: ClimbFilters,
  searchText: string,
  boardFilters: ClimbBoardFilterState = DEFAULT_CLIMB_BOARD_FILTER_STATE,
): Promise<void> {
  try {
    if (!hasActiveClimbFilters(filters) && !hasActiveBoardFilters(boardFilters) && searchText.trim() === '') {
      const value = await readSecureValue(LAST_SEARCH_KEY);
      if (value != null && value !== '{}') await writeSecureValue(LAST_SEARCH_KEY, '{}');
      return;
    }
    const entry: LastSearch = {
      filters,
      boardFilters,
      searchText,
      boardKey: boardGeometryKey(board),
      updatedAt: Date.now(),
    };
    await writeSecureValue(LAST_SEARCH_KEY, JSON.stringify({ [LATEST_ENTRY]: entry }));
  } catch {
    // Storage failure is non-critical.
  }
}
