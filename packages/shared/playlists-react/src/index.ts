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

export { useCommunityPlaylists } from './use-community-playlists';
export type { UseCommunityPlaylistsOptions, UseCommunityPlaylistsResult } from './use-community-playlists';

// Community Playlists browse filters: the filter-state type and its pure
// mapping onto `discoverPlaylists` input.
export {
  buildCommunityPlaylistsInput,
  clearCommunityPlaylistFilters,
  effectiveCommunityCreatorScope,
  hasActiveCommunityPlaylistFilters,
  COMMUNITY_PLAYLIST_MAX_CLIMBS,
  COMMUNITY_PLAYLIST_SEARCH_MAX_LENGTH,
  COMMUNITY_PLAYLIST_SIZE_BANDS,
  DEFAULT_COMMUNITY_PLAYLIST_FILTERS,
} from './community-playlist-filters';
export type {
  CommunityPlaylistCreatorScope,
  CommunityPlaylistFilters,
  CommunityPlaylistSize,
  CommunityPlaylistSort,
  CommunityPlaylistsContext,
  CommunityPlaylistsInput,
} from './community-playlist-filters';

export { useUserPlaylists } from './use-user-playlists';
export type { UseUserPlaylistsOptions, UseUserPlaylistsResult } from './use-user-playlists';

export { usePinnedPlaylists } from './use-pinned-playlists';
export type { UsePinnedPlaylistsOptions, UsePinnedPlaylistsResult, PinnedSource } from './use-pinned-playlists';

export { SMART_PLAYLIST_COUNTS_QUERY_KEY, useSmartPlaylistCounts } from './use-smart-playlist-counts';
export type { UseSmartPlaylistCountsOptions } from './use-smart-playlist-counts';

export { useSmartPlaylist, smartPlaylistQueryKey, smartPlaylistGeometryKey } from './use-smart-playlist';
export type {
  UseSmartPlaylistOptions,
  UseSmartPlaylistResult,
  SmartPlaylistActiveBoardInput,
  SmartPlaylistQueryKeyParts,
} from './use-smart-playlist';

export {
  usePlaylistSetters,
  playlistSettersInput,
  playlistSettersQueryKey,
  PLAYLIST_SETTERS_ANSWER_LIMIT,
} from './use-playlist-setters';
export type { PlaylistSetterSource, UsePlaylistSettersOptions, UsePlaylistSettersResult } from './use-playlist-setters';

export {
  usePlaylistClimbs,
  keepPreviousViewResults,
  playlistClimbsQueryKey,
  playlistClimbsQueryKeyFor,
  playlistClimbsGeometryKey,
  playlistClimbsAngleKey,
} from './use-playlist-climbs';
export type {
  PlaylistClimbsQueryKeyParts,
  UsePlaylistClimbsOptions,
  UsePlaylistClimbsResult,
  PlaylistClimbsBoardInput,
  PlaylistClimbsView,
  ViewQueryKeyLayout,
} from './use-playlist-climbs';

export { usePlaylistClimbActivation } from './use-playlist-climb-activation';
export type {
  UsePlaylistClimbActivationOptions,
  PlaylistActivationQueueApi,
  PlaylistActivationBoardTarget,
  FetchActivationClimbsArgs,
  ActivationTrackLoad,
} from './use-playlist-climb-activation';

// Mutation callbacks (create / update / delete / pin / unpin / follow / unfollow).
export { usePlaylistMutations } from './use-playlist-mutations';
export type { UsePlaylistMutationsOptions, UsePlaylistMutationsResult } from './use-playlist-mutations';

// Item-level mutation callbacks (reorder / remove climb).
export { usePlaylistItemMutations } from './use-playlist-item-mutations';
export type { UsePlaylistItemMutationsOptions, UsePlaylistItemMutationsResult } from './use-playlist-item-mutations';

// Paged playlist drain + the suggestion-refresh helper built on it (also
// reachable via the ./fetch-playlist-suggestion-climbs subpath).
export {
  drainPlaylistPages,
  fetchPlaylistSuggestionClimbs,
  fetchPlaylistTrackPage,
  isAbortError,
  MAX_PLAYLIST_QUEUE_REPLACE_PAGES,
  PLAYLIST_SUGGESTION_REFRESH_PAGE_SIZE,
} from './fetch-playlist-suggestion-climbs';
export type {
  DrainPlaylistPagesArgs,
  PlaylistDrainResult,
  PlaylistDrainStopReason,
} from './fetch-playlist-suggestion-climbs';
