import { climbFitsPlaylistBoard } from '@boardsesh/board-config';
import type { Playlist } from '@boardsesh/graphql/operations/playlists';

/**
 * Sort playlists alphabetically by name (case- and accent-insensitive). Pure so
 * list surfaces can share the same ordering without mutating their inputs.
 */
export function sortPlaylistsByName(playlists: Playlist[]): Playlist[] {
  return [...playlists].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/**
 * Keep only the playlists a climb on `boardName`/`layoutId` may actually be
 * added to.
 *
 * The predicate is `climbFitsPlaylistBoard` from `@boardsesh/board-config` — the
 * same function `addClimbToPlaylist` guards the write with, so the picker can
 * never offer a target the server rejects (#4015). `layoutId` is nullable on
 * `Playlist` by design: a playlist is scoped to a board and only *optionally* to
 * a layout, which is how Aurora- and Kilter-synced circuits arrive. Those are
 * legitimate targets on every layout of their board, and the Discover "My
 * playlists" list already shows them.
 */
export function filterPlaylistsByBoard(playlists: Playlist[], boardName: string, layoutId: number): Playlist[] {
  return playlists.filter((playlist) =>
    climbFitsPlaylistBoard(
      { boardType: boardName, layoutId },
      { boardType: playlist.boardType, layoutId: playlist.layoutId ?? null },
    ),
  );
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
