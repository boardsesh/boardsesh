import type { Playlist } from '@boardsesh/graphql/operations/playlists';

/**
 * Sort playlists alphabetically by name (case- and accent-insensitive). Pure so
 * list surfaces can share the same ordering without mutating their inputs.
 */
export function sortPlaylistsByName(playlists: Playlist[]): Playlist[] {
  return [...playlists].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/**
 * Keep only playlists that belong to the given board+layout. Mirrors the
 * board+layout equality rule `canAddClimbToBoard` uses (board-config's
 * board-compatibility.ts): both fields must match exactly. `layoutId` is
 * nullable on `Playlist` for Aurora-synced circuits, whose board identity is
 * unverifiable — a null `layoutId` never matches, so those circuits are
 * correctly excluded from add-target lists rather than shown for every board.
 */
export function filterPlaylistsByBoard(playlists: Playlist[], boardName: string, layoutId: number): Playlist[] {
  return playlists.filter((playlist) => playlist.boardType === boardName && playlist.layoutId === layoutId);
}

/**
 * Sort playlists alphabetically by name, then keep only those whose name
 * contains the (trimmed, case-insensitive) query.
 */
export function sortAndFilterPlaylists(playlists: Playlist[], query: string): Playlist[] {
  const sorted = sortPlaylistsByName(playlists);
  const needle = query.trim().toLowerCase();
  if (!needle) return sorted;
  return sorted.filter((playlist) => playlist.name.toLowerCase().includes(needle));
}
