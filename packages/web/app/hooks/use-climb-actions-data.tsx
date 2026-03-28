'use client';

import { useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  GET_FAVORITES,
  TOGGLE_FAVORITE,
  type FavoritesQueryResponse,
  type ToggleFavoriteMutationResponse,
} from '@/app/lib/graphql/operations/favorites';
import {
  GET_ALL_USER_PLAYLISTS,
  GET_PLAYLISTS_FOR_CLIMBS,
  ADD_CLIMB_TO_PLAYLIST,
  REMOVE_CLIMB_FROM_PLAYLIST,
  CREATE_PLAYLIST,
  type GetAllUserPlaylistsQueryResponse,
  type GetPlaylistsForClimbsQueryResponse,
  type AddClimbToPlaylistMutationResponse,
  type RemoveClimbFromPlaylistMutationResponse,
  type CreatePlaylistMutationResponse,
  type Playlist,
} from '@/app/lib/graphql/operations/playlists';
import { useIncrementalQuery } from '@/app/hooks/use-incremental-query';

interface UseClimbActionsDataOptions {
  boardName: string;
  layoutId: number;
  angle: number;
  climbUuids: string[];
}

// Merge helpers (stable references to avoid re-creating on every render)
const mergeSetFn = (acc: Set<string>, fetched: Set<string>): Set<string> =>
  new Set([...acc, ...fetched]);

// Shallow merge (overwrites per-key) is safe here because the incremental fetch
// pattern guarantees no key overlap between accumulated and fetched batches —
// each UUID is only fetched once and never re-fetched unless the cache is reset.
const mergeMapFn = (
  acc: Map<string, Set<string>>,
  fetched: Map<string, Set<string>>,
): Map<string, Set<string>> => new Map([...acc, ...fetched]);

// Size-only comparison is intentional: merge always grows (union/append),
// so a size change reliably signals new data without expensive deep equality.
const hasSetSizeChanged = (prev: Set<string>, next: Set<string>): boolean =>
  prev.size !== next.size;

const hasMapSizeChanged = (
  prev: Map<string, Set<string>>,
  next: Map<string, Set<string>>,
): boolean => prev.size !== next.size;

const EMPTY_SET = new Set<string>();
const EMPTY_MAP = new Map<string, Set<string>>();

export function useClimbActionsData({
  boardName,
  layoutId,
  angle,
  climbUuids,
}: UseClimbActionsDataOptions) {
  const { token, isAuthenticated, isLoading: isAuthLoading } = useWsAuthToken();
  const { showMessage } = useSnackbar();
  const queryClient = useQueryClient();

  // === Favorites (incremental) ===

  const favAccKey = useMemo(
    () => ['favorites', boardName, angle, 'accumulated'] as const,
    [boardName, angle],
  );
  const favFetchKeyPrefix = useMemo(
    () => ['favorites', boardName, angle, 'fetch'] as const,
    [boardName, angle],
  );

  const favFetchChunk = useCallback(
    async (uuids: string[]): Promise<Set<string>> => {
      const client = createGraphQLHttpClient(token);
      try {
        const result = await client.request<FavoritesQueryResponse>(GET_FAVORITES, {
          boardName,
          climbUuids: uuids,
          angle,
        });
        return new Set(result.favorites);
      } catch (error) {
        console.error(`[GraphQL] Favorites query error for ${boardName} (${uuids.length} uuids):`, error);
        throw error;
      }
    },
    [token, boardName, angle],
  );

  const {
    data: favorites,
    isLoading: isLoadingFavorites,
    error: favoritesError,
    cancelFetches: cancelFavFetches,
  } = useIncrementalQuery<Set<string>>(
    climbUuids,
    {
      accumulatedKey: favAccKey,
      fetchKeyPrefix: favFetchKeyPrefix,
      enabled: isAuthenticated && !isAuthLoading && !!boardName,
      fetchChunk: favFetchChunk,
      merge: mergeSetFn,
      initialValue: EMPTY_SET,
      hasChanged: hasSetSizeChanged,
    },
  );

  // Toggle favorite mutation — targets the accumulated cache key
  const toggleFavoriteMutation = useMutation({
    mutationKey: ['toggleFavorite', boardName, angle],
    mutationFn: async (climbUuid: string): Promise<{ uuid: string; favorited: boolean }> => {
      const client = createGraphQLHttpClient(token);
      const result = await client.request<ToggleFavoriteMutationResponse>(TOGGLE_FAVORITE, {
        input: { boardName, climbUuid, angle },
      });
      return { uuid: climbUuid, favorited: result.toggleFavorite.favorited };
    },
    onMutate: async (climbUuid: string) => {
      // Cancel both the accumulated key AND in-flight fetch queries to prevent
      // a stale fetch response from overwriting the optimistic update.
      await cancelFavFetches();
      const previousFavorites = queryClient.getQueryData<Set<string>>(favAccKey);
      queryClient.setQueryData<Set<string>>(favAccKey, (old) => {
        const next = new Set(old);
        if (next.has(climbUuid)) {
          next.delete(climbUuid);
        } else {
          next.add(climbUuid);
        }
        return next;
      });
      return { previousFavorites };
    },
    onError: (err, climbUuid, context) => {
      console.error(`[Favorites] Error toggling favorite for climb ${climbUuid}:`, err);
      if (context?.previousFavorites) {
        queryClient.setQueryData(favAccKey, context.previousFavorites);
      }
      showMessage('Failed to update favorite. Please try again.', 'error');
    },
  });

  const toggleFavorite = useCallback(
    async (climbUuid: string): Promise<boolean> => {
      if (!isAuthenticated) return false;
      const result = await toggleFavoriteMutation.mutateAsync(climbUuid);
      return result.favorited;
    },
    [isAuthenticated, toggleFavoriteMutation],
  );

  const isFavorited = useCallback(
    (climbUuid: string): boolean => favorites.has(climbUuid),
    [favorites],
  );

  // === Playlists ===

  // Fetch user's playlists (all boards) — not incremental, just a simple query
  const playlistsQueryKey = useMemo(() => ['userPlaylists', token] as const, [token]);

  const { data: playlists = [], isLoading: playlistsLoading } = useQuery({
    queryKey: playlistsQueryKey,
    queryFn: async (): Promise<Playlist[]> => {
      const client = createGraphQLHttpClient(token);
      const response = await client.request<GetAllUserPlaylistsQueryResponse>(GET_ALL_USER_PLAYLISTS, {
        input: {},
      });
      return response.allUserPlaylists;
    },
    enabled: isAuthenticated && !!token,
    staleTime: 5 * 60 * 1000,
  });

  // === Playlist Memberships (incremental) ===

  const memAccKey = useMemo(
    () => ['playlistMemberships', boardName, layoutId, 'accumulated'] as const,
    [boardName, layoutId],
  );
  const memFetchKeyPrefix = useMemo(
    () => ['playlistMemberships', boardName, layoutId, 'fetch'] as const,
    [boardName, layoutId],
  );

  const memFetchChunk = useCallback(
    async (uuids: string[]): Promise<Map<string, Set<string>>> => {
      const client = createGraphQLHttpClient(token);
      try {
        const response = await client.request<GetPlaylistsForClimbsQueryResponse>(
          GET_PLAYLISTS_FOR_CLIMBS,
          { input: { boardType: boardName, layoutId, climbUuids: uuids } },
        );
        const memberships = new Map<string, Set<string>>();
        for (const entry of response.playlistsForClimbs) {
          memberships.set(entry.climbUuid, new Set(entry.playlistUuids));
        }
        return memberships;
      } catch (error) {
        console.error(`[GraphQL] Playlist memberships query error for ${boardName} (${uuids.length} uuids):`, error);
        throw error;
      }
    },
    [token, boardName, layoutId],
  );

  const {
    data: membershipsData,
    error: membershipsError,
    cancelFetches: cancelMemFetches,
  } = useIncrementalQuery<Map<string, Set<string>>>(
    climbUuids,
    {
      accumulatedKey: memAccKey,
      fetchKeyPrefix: memFetchKeyPrefix,
      // MoonBoard doesn't support playlists (no playlist API in Aurora for MoonBoard)
      enabled:
        isAuthenticated &&
        !isAuthLoading &&
        !!boardName &&
        layoutId > 0 &&
        boardName !== 'moonboard',
      fetchChunk: memFetchChunk,
      merge: mergeMapFn,
      initialValue: EMPTY_MAP,
      hasChanged: hasMapSizeChanged,
    },
  );

  // Playlist mutations — update the accumulated membership cache
  const addToPlaylist = useCallback(
    async (playlistId: string, climbUuid: string, climbAngle: number) => {
      if (!token) throw new Error('Not authenticated');
      const client = createGraphQLHttpClient(token);
      await client.request<AddClimbToPlaylistMutationResponse>(ADD_CLIMB_TO_PLAYLIST, {
        input: { playlistId, climbUuid, angle: climbAngle },
      });
      // Cancel in-flight fetches and update accumulated membership cache
      await cancelMemFetches();
      const prevMem = queryClient.getQueryData<Map<string, Set<string>>>(memAccKey) ?? new Map();
      const updatedMem = new Map(prevMem);
      const currentSet = new Set(updatedMem.get(climbUuid) || []);
      currentSet.add(playlistId);
      updatedMem.set(climbUuid, currentSet);
      queryClient.setQueryData(memAccKey, updatedMem);
      queryClient.setQueryData<Playlist[]>(playlistsQueryKey, (prev) =>
        prev?.map((p) => (p.uuid === playlistId ? { ...p, climbCount: p.climbCount + 1 } : p)),
      );
    },
    [token, memAccKey, playlistsQueryKey, queryClient, cancelMemFetches],
  );

  const removeFromPlaylist = useCallback(
    async (playlistId: string, climbUuid: string) => {
      if (!token) throw new Error('Not authenticated');
      const client = createGraphQLHttpClient(token);
      await client.request<RemoveClimbFromPlaylistMutationResponse>(REMOVE_CLIMB_FROM_PLAYLIST, {
        input: { playlistId, climbUuid },
      });
      // Cancel in-flight fetches and update accumulated membership cache
      await cancelMemFetches();
      const prevMem = queryClient.getQueryData<Map<string, Set<string>>>(memAccKey) ?? new Map();
      const updatedMem = new Map(prevMem);
      const currentPlaylists = updatedMem.get(climbUuid);
      if (currentPlaylists) {
        const next = new Set(currentPlaylists);
        next.delete(playlistId);
        updatedMem.set(climbUuid, next);
      }
      queryClient.setQueryData(memAccKey, updatedMem);
      queryClient.setQueryData<Playlist[]>(playlistsQueryKey, (prev) =>
        prev?.map((p) =>
          p.uuid === playlistId ? { ...p, climbCount: Math.max(0, p.climbCount - 1) } : p,
        ),
      );
    },
    [token, memAccKey, playlistsQueryKey, queryClient, cancelMemFetches],
  );

  const createPlaylist = useCallback(
    async (
      name: string,
      description?: string,
      color?: string,
      icon?: string,
    ): Promise<Playlist> => {
      if (!token) throw new Error('Not authenticated');
      const client = createGraphQLHttpClient(token);
      const response = await client.request<CreatePlaylistMutationResponse>(CREATE_PLAYLIST, {
        input: { boardType: boardName, layoutId, name, description, color, icon },
      });
      queryClient.setQueryData<Playlist[]>(playlistsQueryKey, (prev) =>
        prev ? [response.createPlaylist, ...prev] : [response.createPlaylist],
      );
      return response.createPlaylist;
    },
    [token, boardName, layoutId, playlistsQueryKey, queryClient],
  );

  const refreshPlaylists = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: playlistsQueryKey });
  }, [queryClient, playlistsQueryKey]);

  return {
    favoritesProviderProps: {
      favorites,
      isFavorited,
      toggleFavorite,
      isLoading: isLoadingFavorites,
      error: favoritesError,
      isAuthenticated,
    },
    playlistsProviderProps: {
      playlists,
      playlistMemberships: membershipsData,
      addToPlaylist,
      removeFromPlaylist,
      createPlaylist,
      isLoading: playlistsLoading,
      error: membershipsError,
      isAuthenticated,
      refreshPlaylists,
    },
  };
}
