import * as SecureStore from 'expo-secure-store';
import type { BoardSearchConfig } from '@boardsesh/climb-filters';
import { boardConfigKey } from './last-search-store';

/**
 * Climbs-list view mode. `list` is the single-column FlashList (the default and
 * the only layout the app shipped with); `grid` is the two-up card layout. Held
 * per board config so a climber who prefers the grid on their home board keeps
 * the single-column scan on a denser comp board, mirroring the per-board memory
 * of {@link getLastSearch}.
 */
export type ClimbViewMode = 'list' | 'grid';

export const DEFAULT_CLIMB_VIEW_MODE: ClimbViewMode = 'list';

// One secure-store key holds a JSON map of boardConfigKey -> ClimbViewMode.
// Capped to bound growth when a user hops across many board configs.
const VIEW_MODE_KEY = 'boardsesh_climbs_view_mode_by_board';
const MAX_BOARDS = 20;

type ViewModeMap = Record<string, ClimbViewMode>;

function isClimbViewMode(value: unknown): value is ClimbViewMode {
  return value === 'list' || value === 'grid';
}

async function readMap(): Promise<ViewModeMap> {
  try {
    const value = await SecureStore.getItemAsync(VIEW_MODE_KEY);
    if (!value) return {};
    const parsed: unknown = JSON.parse(value);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: ViewModeMap = {};
    for (const [key, mode] of Object.entries(parsed)) {
      if (isClimbViewMode(mode)) result[key] = mode;
    }
    return result;
  } catch {
    return {};
  }
}

// Bound the map: keep the most recently inserted boards. Insertion order is the
// natural recency proxy here (we re-insert a board's key on every save), so we
// keep the last MAX_BOARDS keys.
function capMap(map: ViewModeMap): ViewModeMap {
  const keys = Object.keys(map);
  if (keys.length <= MAX_BOARDS) return map;
  const keep = keys.slice(keys.length - MAX_BOARDS);
  const capped: ViewModeMap = {};
  for (const key of keep) {
    capped[key] = map[key];
  }
  return capped;
}

/**
 * The saved view mode for this board, or {@link DEFAULT_CLIMB_VIEW_MODE} when the
 * board has never had a non-default mode chosen (defaults to list).
 */
export async function getViewMode(board: BoardSearchConfig): Promise<ClimbViewMode> {
  const map = await readMap();
  return map[boardConfigKey(board)] ?? DEFAULT_CLIMB_VIEW_MODE;
}

/**
 * Persists the view mode for this board. Saving the default `list` *deletes* any
 * stored entry so the map only carries boards the user explicitly put on grid.
 */
export async function saveViewMode(board: BoardSearchConfig, mode: ClimbViewMode): Promise<void> {
  try {
    const key = boardConfigKey(board);
    const map = await readMap();
    if (mode === DEFAULT_CLIMB_VIEW_MODE) {
      if (!(key in map)) return;
      delete map[key];
      await SecureStore.setItemAsync(VIEW_MODE_KEY, JSON.stringify(map));
      return;
    }
    // Re-insert so this board moves to the end (most-recent) for capMap.
    delete map[key];
    map[key] = mode;
    await SecureStore.setItemAsync(VIEW_MODE_KEY, JSON.stringify(capMap(map)));
  } catch {
    // Storage failure is non-critical — the session keeps the in-memory choice.
  }
}
