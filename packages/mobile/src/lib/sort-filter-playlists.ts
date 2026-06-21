import type { Playlist } from '@boardsesh/graphql/operations/playlists';

/**
 * Sort playlists alphabetically by name (case- and accent-insensitive). Pure so
 * list surfaces can share the same ordering without mutating their inputs.
 */
export function sortPlaylistsByName(playlists: Playlist[]): Playlist[] {
  return [...playlists].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
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
