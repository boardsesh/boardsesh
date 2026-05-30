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

const notImplemented = async (): Promise<never> => {
  throw new Error('PlaylistsProvider mutations not wired yet — port useClimbActionsData first.');
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
  addToPlaylist = notImplemented,
  removeFromPlaylist = notImplemented,
  createPlaylist = notImplemented,
  isLoading = false,
  isAuthenticated = false,
  refreshPlaylists = async () => undefined,
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
