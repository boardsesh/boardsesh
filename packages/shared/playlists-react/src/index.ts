// @boardsesh/playlists-react — renderer-agnostic playlist data-fetching and
// activation hooks shared by web and mobile. Static re-exports only (no
// dynamic import()) so Metro can bundle it.

// Dependency-injection context.
export { PlaylistsAdapterProvider, usePlaylistsAdapter } from './adapter';
export type { ExecutePlaylistsGraphQL, PlaylistsAdapter } from './adapter';

// Recents storage abstraction.
export { noopRecentsAdapter } from './recents-adapter';
export type { RecentPlaylistEntry, RecentsStorageAdapter } from './recents-adapter';

// Hooks.
export { useDiscoverPlaylists } from './use-discover-playlists';
export type { UseDiscoverPlaylistsOptions, UseDiscoverPlaylistsResult } from './use-discover-playlists';

export { useUserPlaylists } from './use-user-playlists';
export type { UseUserPlaylistsOptions, UseUserPlaylistsResult } from './use-user-playlists';

export { usePinnedPlaylists } from './use-pinned-playlists';
export type { UsePinnedPlaylistsOptions, UsePinnedPlaylistsResult, PinnedSource } from './use-pinned-playlists';

export { useSmartPlaylistCounts } from './use-smart-playlist-counts';
export type { UseSmartPlaylistCountsOptions } from './use-smart-playlist-counts';

export { useSmartPlaylist } from './use-smart-playlist';
export type { UseSmartPlaylistOptions, UseSmartPlaylistResult } from './use-smart-playlist';

export { usePlaylistClimbs } from './use-playlist-climbs';
export type {
  UsePlaylistClimbsOptions,
  UsePlaylistClimbsResult,
  PlaylistClimbsBoardInput,
} from './use-playlist-climbs';

export { usePlaylistClimbActivation } from './use-playlist-climb-activation';
export type {
  UsePlaylistClimbActivationOptions,
  PlaylistActivationQueueApi,
  PlaylistActivationBoardTarget,
  FetchActivationClimbsArgs,
} from './use-playlist-climb-activation';

// Mutation callbacks (create / update / delete / pin / unpin / follow / unfollow).
export { usePlaylistMutations } from './use-playlist-mutations';
export type { UsePlaylistMutationsOptions, UsePlaylistMutationsResult } from './use-playlist-mutations';

// Item-level mutation callbacks (reorder / remove climb).
export { usePlaylistItemMutations } from './use-playlist-item-mutations';
export type { UsePlaylistItemMutationsOptions, UsePlaylistItemMutationsResult } from './use-playlist-item-mutations';

// Suggestion-refresh helper (also reachable via the
// ./fetch-playlist-suggestion-climbs subpath).
export {
  fetchPlaylistSuggestionClimbs,
  isAbortError,
  PLAYLIST_SUGGESTION_REFRESH_PAGE_SIZE,
} from './fetch-playlist-suggestion-climbs';
