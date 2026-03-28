'use client';

import React, { useMemo } from 'react';
import { createTypedContext } from '@/app/lib/create-typed-context';
import type { Playlist } from '@/app/lib/graphql/operations/playlists';

// Re-export Playlist type for convenience
export type { Playlist } from '@/app/lib/graphql/operations/playlists';

interface PlaylistsContextValue {
  playlists: Playlist[];
  getPlaylistsForClimb: (climbUuid: string) => Set<string>;
  addToPlaylist: (playlistId: string, climbUuid: string, angle: number) => Promise<void>;
  removeFromPlaylist: (playlistId: string, climbUuid: string) => Promise<void>;
  createPlaylist: (
    name: string,
    description?: string,
    color?: string,
    icon?: string
  ) => Promise<Playlist>;
  isLoading: boolean;
  isAuthenticated: boolean;
  refreshPlaylists: () => Promise<void>;
}

const [PlaylistsCtx, usePlaylistsContext] = createTypedContext<PlaylistsContextValue>('Playlists');

export const PlaylistsContext = PlaylistsCtx;
export { usePlaylistsContext };

interface PlaylistsProviderProps {
  playlists: Playlist[];
  playlistMemberships: Map<string, Set<string>>;
  addToPlaylist: (playlistId: string, climbUuid: string, angle: number) => Promise<void>;
  removeFromPlaylist: (playlistId: string, climbUuid: string) => Promise<void>;
  createPlaylist: (
    name: string,
    description?: string,
    color?: string,
    icon?: string
  ) => Promise<Playlist>;
  isLoading: boolean;
  error: Error | null;
  isAuthenticated: boolean;
  refreshPlaylists: () => Promise<void>;
  children: React.ReactNode;
}

export function PlaylistsProvider({
  playlists,
  playlistMemberships,
  addToPlaylist,
  removeFromPlaylist,
  createPlaylist,
  isLoading,
  isAuthenticated,
  refreshPlaylists,
  children,
}: PlaylistsProviderProps) {
  const getPlaylistsForClimb = useMemo(
    () => (climbUuid: string) => {
      return playlistMemberships.get(climbUuid) || new Set<string>();
    },
    [playlistMemberships]
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
    ]
  );

  return <PlaylistsContext.Provider value={value}>{children}</PlaylistsContext.Provider>;
}
