// PlaylistsProvider — mirrors web's
// `packages/web/app/components/climb-actions/playlists-batch-context.tsx`.
// Pure context wiring; the React Query data hook (analog of web's
// `useClimbActionsData`) is a follow-up. Today the provider accepts
// optional data + mutation props and defaults to empty/no-op so it can sit
// in the tree without consumers.

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { Playlist } from '@boardsesh/graphql/operations/playlists';

export type { Playlist } from '@boardsesh/graphql/operations/playlists';

type PlaylistsContextValue = {
  playlists: Playlist[];
  getPlaylistsForClimb: (climbUuid: string) => Set<string>;
  addToPlaylist: (playlistId: string, climbUuid: string, angle: number) => Promise<void>;
  removeFromPlaylist: (playlistId: string, climbUuid: string) => Promise<void>;
  createPlaylist: (name: string, description?: string, color?: string, icon?: string) => Promise<Playlist>;
  isLoading: boolean;
  isAuthenticated: boolean;
  refreshPlaylists: () => Promise<void>;
};

const PlaylistsContext = createContext<PlaylistsContextValue | undefined>(undefined);

const EMPTY_PLAYLISTS: Playlist[] = [];
const EMPTY_MEMBERSHIPS: Map<string, Set<string>> = new Map();
const EMPTY_SET = new Set<string>();

// Default mutation implementations throw with an actionable message so a
// screen that calls them before the data hook lands gets a fix-it diagnostic
// rather than a silent no-op or a vague crash. The error is surfaced
// twice — once as a console.error in __DEV__ (so it shows up in the Metro
// log even if the call site swallows the throw), once as the thrown Error
// itself.
const notWired = (method: string) => async (): Promise<never> => {
  const message = `[PlaylistsProvider] ${method}() called but PlaylistsProvider was mounted with default props. Wire a mobile equivalent of useClimbActionsData and pass its result in before invoking mutations.`;
  if (__DEV__) console.error(message);
  throw new Error(message);
};

type PlaylistsProviderProps = {
  playlists?: Playlist[];
  playlistMemberships?: Map<string, Set<string>>;
  addToPlaylist?: (playlistId: string, climbUuid: string, angle: number) => Promise<void>;
  removeFromPlaylist?: (playlistId: string, climbUuid: string) => Promise<void>;
  createPlaylist?: (name: string, description?: string, color?: string, icon?: string) => Promise<Playlist>;
  isLoading?: boolean;
  isAuthenticated?: boolean;
  refreshPlaylists?: () => Promise<void>;
  children: ReactNode;
};

export function PlaylistsProvider({
  playlists = EMPTY_PLAYLISTS,
  playlistMemberships = EMPTY_MEMBERSHIPS,
  addToPlaylist = notWired('addToPlaylist'),
  removeFromPlaylist = notWired('removeFromPlaylist'),
  createPlaylist = notWired('createPlaylist'),
  // Default `true` (not `false`) so a consumer reading `isLoading` to gate a
  // spinner doesn't mistake "data hook not wired yet" for "user has no
  // playlists". The combination of `playlists=[]` + `isLoading=true` is the
  // accurate state until a real data hook lands and overrides both. Pairs
  // with the `notWired()` mutation defaults — both signal "this is the
  // unwired baseline" rather than masquerading as real data.
  isLoading = true,
  isAuthenticated = false,
  refreshPlaylists = notWired('refreshPlaylists'),
  children,
}: PlaylistsProviderProps) {
  const getPlaylistsForClimb = useMemo(
    () => (climbUuid: string) => playlistMemberships.get(climbUuid) ?? EMPTY_SET,
    [playlistMemberships],
  );

  const value = useMemo<PlaylistsContextValue>(
    () => ({
      playlists,
      getPlaylistsForClimb,
      addToPlaylist,
      removeFromPlaylist,
      createPlaylist,
      isLoading,
      isAuthenticated,
      refreshPlaylists,
    }),
    [
      playlists,
      getPlaylistsForClimb,
      addToPlaylist,
      removeFromPlaylist,
      createPlaylist,
      isLoading,
      isAuthenticated,
      refreshPlaylists,
    ],
  );

  return <PlaylistsContext.Provider value={value}>{children}</PlaylistsContext.Provider>;
}

export function usePlaylistsContext(): PlaylistsContextValue {
  const ctx = useContext(PlaylistsContext);
  if (!ctx) throw new Error('usePlaylistsContext must be used within a PlaylistsProvider');
  return ctx;
}
