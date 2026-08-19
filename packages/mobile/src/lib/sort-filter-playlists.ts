import type { Playlist } from '@boardsesh/graphql/operations/playlists';

/**
 * Sort playlists alphabetically by name (case- and accent-insensitive). Pure so
 * list surfaces can share the same ordering without mutating their inputs.
 */
export function sortPlaylistsByName(playlists: Playlist[]): Playlist[] {
  return [...playlists].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/**
 * Keep only playlists that belong to the given board+layout, using the same rule
 * the backend already applies for board-scoped playlist lists —
 * `boardType = $board AND (layout_id = $layout OR layout_id IS NULL)` in
 * `userPlaylists` / `allUserPlaylists`
 * (packages/backend/src/graphql/resolvers/playlists/queries/user-playlists.ts).
 *
 * `layoutId` is nullable on `Playlist` by design: a playlist is scoped to a
 * board and only *optionally* to a layout (see packages/db schema), which is how
 * Aurora- and Kilter-synced circuits arrive. Those are legitimate add targets on
 * every layout of their board, and the Discover "My playlists" list already
 * shows them — so a null `layoutId` matches here too, rather than silently
 * dropping a climber's circuits from the add-to-playlist picker.
 */
export function filterPlaylistsByBoard(playlists: Playlist[], boardName: string, layoutId: number): Playlist[] {
  return playlists.filter((playlist) => matchesBoard(playlist, boardName, layoutId));
}

/**
 * Whether the climber has any playlist on this board+layout, by the same rule
 * `filterPlaylistsByBoard` applies. Short-circuits and allocates nothing — for
 * callers that only need the yes/no, like the play drawer deciding whether to
 * reserve its playlist-chips slot.
 */
export function hasPlaylistForBoard(playlists: Playlist[], boardName: string, layoutId: number): boolean {
  return playlists.some((playlist) => matchesBoard(playlist, boardName, layoutId));
}

function matchesBoard(playlist: Playlist, boardName: string, layoutId: number): boolean {
  return playlist.boardType === boardName && (playlist.layoutId == null || playlist.layoutId === layoutId);
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
