// Mobile's data hook for FavoritesProvider + PlaylistsProvider — the analog of
// web's `useClimbActionsData`. Returns provider-shaped props the layout passes
// straight in.
//
// Playlist mutations bind to the user's currently *active* board via
// `useActiveBoard` (boardType + layoutId). Playlists genuinely belong to a
// board + layout, so this is correct — the moment the user switches boards
// from the boards tab the cache invalidates and subsequent mutations land
// against the new board.
//
// `toggleFavorite` is also wired against the active board today only because
// the current GraphQL schema requires `boardName` + `angle` on the input.
// Tracked in #2449 as a backend cleanup — favorites should be keyed by climb
// UUID alone. Once #2449 lands, drop those args from the mutation.
//
// Favorites Set is left empty: the current `GET_FAVORITES` query takes a
// `climbUuids` list (web batches it as the user scrolls a climb list), and
// mobile has no equivalent batched fetcher today. When a mobile screen needs
// per-climb favorited state, fetch with `GET_FAVORITES` for the visible
// UUIDs and write the result into `favoritesStore` directly so subscribers
// re-render — the toggle path here doesn't touch that store.

import { useCallback, useRef } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { TOGGLE_FAVORITE, type ToggleFavoriteMutationResponse } from '@boardsesh/graphql/operations/favorites';
import {
  GET_ALL_USER_PLAYLISTS,
  ADD_CLIMB_TO_PLAYLIST,
  REMOVE_CLIMB_FROM_PLAYLIST,
  CREATE_PLAYLIST,
  type Playlist,
  type GetAllUserPlaylistsQueryResponse,
  type AddClimbToPlaylistMutationResponse,
  type CreatePlaylistMutationResponse,
} from '@boardsesh/graphql/operations/playlists';
import { getHttpClient } from '../client';
import { useAuth } from '../../../providers/auth-provider';
import { useActiveBoard } from '../use-active-board';
import type { PlaylistCreateBoard } from '../../../providers/playlists-provider';

const PLAYLISTS_QUERY_KEY = ['userPlaylists'] as const;

// The play-drawer's Add-to-Playlist sheet adds/removes by playlist uuid (the
// backend resolvers match playlists.uuid), so `playlistId` here is the uuid the
// detail screen keys its caches by: the climb list lives under
// ['playlistClimbs', uuid, ...] (use-playlist-climbs.ts) and the metadata/hero
// count under ['playlist', uuid] ([playlist_uuid].tsx). Invalidating those
// prefixes refreshes an open detail screen after a membership change.
function invalidatePlaylistDetail(queryClient: QueryClient, playlistUuid: string): void {
  void queryClient.invalidateQueries({ queryKey: ['playlistClimbs', playlistUuid] });
  void queryClient.invalidateQueries({ queryKey: ['playlist', playlistUuid] });
}

// Optimistically nudge the picker's count subtitle (sourced from the cached
// ['userPlaylists'] list) so it reflects the add/remove immediately rather than
// waiting out the 5-minute staleTime. Mirrors web's optimistic +1/-1. Match on
// uuid OR id so the bump lands regardless of which identifier the call site
// passed.
function bumpPlaylistClimbCount(queryClient: QueryClient, playlistUuid: string, delta: number): void {
  queryClient.setQueryData<Playlist[]>(PLAYLISTS_QUERY_KEY, (prev) =>
    prev?.map((playlist) =>
      playlist.uuid === playlistUuid || playlist.id === playlistUuid
        ? { ...playlist, climbCount: Math.max(0, playlist.climbCount + delta) }
        : playlist,
    ),
  );
}

type MobileClimbActionsData = {
  favoritesProviderProps: {
    favorites: Set<string>;
    toggleFavorite: (uuid: string) => Promise<boolean>;
    isLoading: boolean;
    isAuthenticated: boolean;
  };
  playlistsProviderProps: {
    playlists: Playlist[];
    playlistMemberships: Map<string, Set<string>>;
    addToPlaylist: (playlistId: string, climbUuid: string, angle: number) => Promise<void>;
    removeFromPlaylist: (playlistId: string, climbUuid: string) => Promise<void>;
    createPlaylist: (
      name: string,
      description?: string,
      color?: string,
      icon?: string,
      board?: PlaylistCreateBoard,
    ) => Promise<Playlist>;
    isLoading: boolean;
    isAuthenticated: boolean;
    refreshPlaylists: () => Promise<void>;
  };
};

export function useMobileClimbActionsData(): MobileClimbActionsData {
  const { isAuthenticated, isLoading: isAuthLoading } = useAuth();
  const { data: activeBoard } = useActiveBoard();
  const queryClient = useQueryClient();

  // === Playlists ===

  const { data: playlists = [] as Playlist[], isLoading: playlistsLoading } = useQuery({
    queryKey: PLAYLISTS_QUERY_KEY,
    queryFn: async (): Promise<Playlist[]> => {
      const response = await getHttpClient().request<GetAllUserPlaylistsQueryResponse>(GET_ALL_USER_PLAYLISTS, {
        input: { pageSize: 200 },
      });
      return response.allUserPlaylists.playlists;
    },
    enabled: isAuthenticated && !isAuthLoading,
    staleTime: 5 * 60 * 1000,
  });

  // === Mutations ===

  // Bag of mutation deps in a single ref so the public callbacks below stay
  // referentially stable across renders (avoids cascading the entire provider
  // tree on every activeBoard refresh).
  const mutationDepsRef = useRef({
    activeBoard,
    queryClient,
    isAuthenticated,
  });
  mutationDepsRef.current = { activeBoard, queryClient, isAuthenticated };

  const toggleFavoriteMutation = useMutation({
    mutationFn: async (climbUuid: string): Promise<{ uuid: string; favorited: boolean }> => {
      const { activeBoard: board } = mutationDepsRef.current;
      if (!board) throw new Error('Cannot toggle favorite: no active board selected.');
      // The favorite key is (userId, boardName, climbUuid, angle) on the
      // backend today. Defaulting a missing angle to 0 would silently file
      // the favorite under the wrong climb variant — better to surface the
      // problem at the call site than write bad data. Stops being relevant
      // once #2449 lands and the key collapses to (userId, climbUuid).
      if (board.angle == null) throw new Error('Cannot toggle favorite: active board has no angle.');
      const response = await getHttpClient().request<ToggleFavoriteMutationResponse>(TOGGLE_FAVORITE, {
        input: { boardName: board.boardType, climbUuid, angle: board.angle },
      });
      return { uuid: climbUuid, favorited: response.toggleFavorite.favorited };
    },
  });

  const addPlaylistMutation = useMutation({
    mutationFn: async (vars: { playlistId: string; climbUuid: string; angle: number }) => {
      return getHttpClient().request<AddClimbToPlaylistMutationResponse>(ADD_CLIMB_TO_PLAYLIST, {
        input: { playlistId: vars.playlistId, climbUuid: vars.climbUuid, angle: vars.angle },
      });
    },
    onSuccess: (_response, vars) => {
      invalidatePlaylistDetail(mutationDepsRef.current.queryClient, vars.playlistId);
      bumpPlaylistClimbCount(mutationDepsRef.current.queryClient, vars.playlistId, 1);
    },
  });

  const removePlaylistMutation = useMutation({
    mutationFn: async (vars: { playlistId: string; climbUuid: string }) => {
      return getHttpClient().request(REMOVE_CLIMB_FROM_PLAYLIST, {
        input: { playlistId: vars.playlistId, climbUuid: vars.climbUuid },
      });
    },
    onSuccess: (_response, vars) => {
      invalidatePlaylistDetail(mutationDepsRef.current.queryClient, vars.playlistId);
      bumpPlaylistClimbCount(mutationDepsRef.current.queryClient, vars.playlistId, -1);
    },
  });

  const createPlaylistMutation = useMutation({
    mutationFn: async (vars: {
      name: string;
      description?: string;
      color?: string;
      icon?: string;
      board?: PlaylistCreateBoard;
    }) => {
      const board = vars.board ?? mutationDepsRef.current.activeBoard;
      if (!board) throw new Error('Cannot create playlist: no active board selected.');
      // CreatePlaylistInput types layoutId as Int! — sending undefined would
      // round-trip a 400 from the server. Throw locally so the call site sees
      // the actual constraint rather than a generic GraphQL error.
      if (board.layoutId == null) throw new Error('Cannot create playlist: active board has no layoutId.');
      const response = await getHttpClient().request<CreatePlaylistMutationResponse>(CREATE_PLAYLIST, {
        input: {
          boardType: board.boardType,
          layoutId: board.layoutId,
          name: vars.name,
          description: vars.description,
          color: vars.color,
          icon: vars.icon,
        },
      });
      return response.createPlaylist;
    },
  });

  // Keep mutateAsync refs so the callbacks below are stable. useMutation
  // returns a new wrapper object each render even when mutateAsync is
  // identity-stable; reading through a ref avoids cascading the provider.
  const toggleFavMutateRef = useRef(toggleFavoriteMutation.mutateAsync);
  toggleFavMutateRef.current = toggleFavoriteMutation.mutateAsync;
  const addPlaylistMutateRef = useRef(addPlaylistMutation.mutateAsync);
  addPlaylistMutateRef.current = addPlaylistMutation.mutateAsync;
  const removePlaylistMutateRef = useRef(removePlaylistMutation.mutateAsync);
  removePlaylistMutateRef.current = removePlaylistMutation.mutateAsync;
  const createPlaylistMutateRef = useRef(createPlaylistMutation.mutateAsync);
  createPlaylistMutateRef.current = createPlaylistMutation.mutateAsync;

  const toggleFavorite = useCallback(async (climbUuid: string): Promise<boolean> => {
    if (!mutationDepsRef.current.isAuthenticated) return false;
    const result = await toggleFavMutateRef.current(climbUuid);
    return result.favorited;
  }, []);

  const addToPlaylist = useCallback(async (playlistId: string, climbUuid: string, angle: number) => {
    await addPlaylistMutateRef.current({ playlistId, climbUuid, angle });
  }, []);

  const removeFromPlaylist = useCallback(async (playlistId: string, climbUuid: string) => {
    await removePlaylistMutateRef.current({ playlistId, climbUuid });
  }, []);

  const createPlaylist = useCallback(
    async (
      name: string,
      description?: string,
      color?: string,
      icon?: string,
      board?: PlaylistCreateBoard,
    ): Promise<Playlist> => {
      const created = await createPlaylistMutateRef.current({ name, description, color, icon, board });
      const { queryClient: client } = mutationDepsRef.current;
      // The picker query can still be in flight when a user creates from the
      // sheet. Cancel it after create succeeds but before the optimistic prepend
      // so a failed create does not disturb the only in-flight picker load, while
      // an older page response still cannot overwrite the created playlist.
      await client.cancelQueries({ queryKey: PLAYLISTS_QUERY_KEY });
      // Optimistically prepend to the cached list so the picker shows the new
      // playlist immediately, without waiting for a refetch round-trip.
      client.setQueryData<Playlist[]>(PLAYLISTS_QUERY_KEY, (prev) => {
        const withoutCreated =
          prev?.filter((playlist) => playlist.uuid !== created.uuid && playlist.id !== created.id) ?? [];
        return [created, ...withoutCreated];
      });
      return created;
    },
    [],
  );

  const refreshPlaylists = useCallback(async () => {
    const { queryClient: client } = mutationDepsRef.current;
    await client.invalidateQueries({ queryKey: PLAYLISTS_QUERY_KEY });
  }, []);

  return {
    favoritesProviderProps: {
      // Fresh empty Set per render rather than a module-scoped constant —
      // a future provider that calls `.add()`/`.delete()` on its own copy
      // can't accidentally mutate a shared singleton this way. Allocating an
      // empty Set is essentially free; the mobile UI doesn't yet read this
      // anyway, so even the trigger-effect cost is moot.
      favorites: new Set<string>(),
      toggleFavorite,
      isLoading: isAuthLoading,
      isAuthenticated,
    },
    playlistsProviderProps: {
      playlists,
      playlistMemberships: new Map<string, Set<string>>(),
      addToPlaylist,
      removeFromPlaylist,
      createPlaylist,
      isLoading: playlistsLoading,
      isAuthenticated,
      refreshPlaylists,
    },
  };
}
