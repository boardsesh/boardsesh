'use client';

import { useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  GET_FAVORITES,
  TOGGLE_FAVORITE,
  type FavoritesQueryResponse,
  type ToggleFavoriteMutationResponse,
} from '@boardsesh/graphql/operations/favorites';
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
} from '@boardsesh/graphql/operations/playlists';
import { useIncrementalQuery } from '@/app/hooks/use-incremental-query';

type UseClimbActionsDataOptions = {
  boardName: string;
  layoutId: number;
  angle: number;
  climbUuids: string[];
};

// Merge helpers (stable references to avoid re-creating on every render)
const mergeSetFn = (acc: Set<string>, fetched: Set<string>): Set<string> => new Set([...acc, ...fetched]);

// Shallow merge (overwrites per-key) is safe here because the incremental fetch
// pattern guarantees no key overlap between accumulated and fetched batches —
// each UUID is only fetched once and never re-fetched unless the cache is reset.
const mergeMapFn = (acc: Map<string, Set<string>>, fetched: Map<string, Set<string>>): Map<string, Set<string>> =>
  new Map([...acc, ...fetched]);

// Size-only comparison is intentional: merge always grows (union/append),
// so a size change reliably signals new data without expensive deep equality.
const hasSetSizeChanged = (prev: Set<string>, next: Set<string>): boolean => prev.size !== next.size;

const hasMapSizeChanged = (prev: Map<string, Set<string>>, next: Map<string, Set<string>>): boolean =>
  prev.size !== next.size;

const EMPTY_SET = new Set<string>();
const EMPTY_MAP = new Map<string, Set<string>>();

type AddPlaylistVars = { playlistId: string; climbUuid: string; climbAngle: number };
type RemovePlaylistVars = { playlistId: string; climbUuid: string };
// onError reverses only its own optimistic write (gated on `membershipChanged`)
// rather than restoring a snapshot, so a concurrent mutation's optimistic state
// is preserved if its onMutate ran between this mutation's onMutate and onError.
type PlaylistMutationContext = { membershipChanged: boolean };

export function useClimbActionsData({ boardName, layoutId, angle: _angle, climbUuids }: UseClimbActionsDataOptions) {
  const { t } = useTranslation('climbs');
  const { token, isAuthenticated, isLoading: isAuthLoading } = useWsAuthToken();
  const { showMessage } = useSnackbar();
  const queryClient = useQueryClient();

  // === Favorites (incremental) ===

  const favAccKey = useMemo(() => ['favorites', 'accumulated'] as const, []);
  const favFetchKeyPrefix = useMemo(() => ['favorites', 'fetch'] as const, []);

  const favFetchChunk = useCallback(
    async (uuids: string[]): Promise<Set<string>> => {
      const client = createGraphQLHttpClient(token);
      try {
        const result = await client.request<FavoritesQueryResponse>(GET_FAVORITES, {
          climbUuids: uuids,
        });
        return new Set(result.favorites);
      } catch (error) {
        console.error(`[GraphQL] Favorites query error for ${uuids.length} uuids:`, error);
        throw error;
      }
    },
    [token],
  );

  const {
    data: favorites,
    isLoading: isLoadingFavorites,
    cancelFetches: cancelFavFetches,
  } = useIncrementalQuery<Set<string>>(climbUuids, {
    accumulatedKey: favAccKey,
    fetchKeyPrefix: favFetchKeyPrefix,
    enabled: isAuthenticated && !isAuthLoading && !!boardName,
    fetchChunk: favFetchChunk,
    merge: mergeSetFn,
    initialValue: EMPTY_SET,
    hasChanged: hasSetSizeChanged,
  });

  // Toggle favorite mutation — targets the accumulated cache key
  const toggleFavoriteMutation = useMutation({
    mutationKey: ['toggleFavorite'],
    mutationFn: async (climbUuid: string): Promise<{ uuid: string; favorited: boolean }> => {
      const client = createGraphQLHttpClient(token);
      const result = await client.request<ToggleFavoriteMutationResponse>(TOGGLE_FAVORITE, {
        input: { climbUuid },
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
      showMessage(t('actions.favorite.toast.updateFailed'), 'error');
    },
  });

  // Ref for mutation — avoids recreating toggleFavorite on every render.
  // useMutation returns a new object each render (status, data, error change),
  // but mutateAsync is functionally stable. Using a ref prevents the cascade:
  // mutation object changes → toggleFavorite changes → FavoritesContext changes → all consumers re-render.
  const toggleFavMutateRef = useRef(toggleFavoriteMutation.mutateAsync);
  toggleFavMutateRef.current = toggleFavoriteMutation.mutateAsync;
  const isAuthenticatedRef = useRef(isAuthenticated);
  isAuthenticatedRef.current = isAuthenticated;

  const toggleFavorite = useCallback(async (climbUuid: string): Promise<boolean> => {
    if (!isAuthenticatedRef.current) return false;
    const result = await toggleFavMutateRef.current(climbUuid);
    return result.favorited;
  }, []);

  // === Playlists ===

  // Fetch user's playlists (all boards) — not incremental, just a simple query
  const playlistsQueryKey = useMemo(() => ['userPlaylists', token] as const, [token]);

  const { data: playlists = [], isLoading: playlistsLoading } = useQuery({
    queryKey: playlistsQueryKey,
    queryFn: async (): Promise<Playlist[]> => {
      const client = createGraphQLHttpClient(token);
      // Climb-action picker shows the user's full playlist library; ask for a
      // single large page rather than streaming. 200 covers any realistic user.
      const response = await client.request<GetAllUserPlaylistsQueryResponse>(GET_ALL_USER_PLAYLISTS, {
        input: { pageSize: 200 },
      });
      return response.allUserPlaylists.playlists;
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
        const response = await client.request<GetPlaylistsForClimbsQueryResponse>(GET_PLAYLISTS_FOR_CLIMBS, {
          input: { boardType: boardName, layoutId, climbUuids: uuids },
        });
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

  const { data: membershipsData, cancelFetches: cancelMemFetches } = useIncrementalQuery<Map<string, Set<string>>>(
    climbUuids,
    {
      accumulatedKey: memAccKey,
      fetchKeyPrefix: memFetchKeyPrefix,
      // MoonBoard doesn't support playlists (no playlist API in Aurora for MoonBoard)
      enabled: isAuthenticated && !isAuthLoading && !!boardName && layoutId > 0 && boardName !== 'moonboard',
      fetchChunk: memFetchChunk,
      merge: mergeMapFn,
      initialValue: EMPTY_MAP,
      hasChanged: hasMapSizeChanged,
    },
  );

  // Playlist mutations — update the accumulated membership cache
  // Ref holding latest values so playlist callbacks can be stable (same pattern as toggleFavorite above)
  const playlistRef = useRef({
    token,
    cancelMemFetches,
    queryClient,
    memAccKey,
    playlistsQueryKey,
    boardName,
    layoutId,
  });
  playlistRef.current = {
    token,
    cancelMemFetches,
    queryClient,
    memAccKey,
    playlistsQueryKey,
    boardName,
    layoutId,
  };

  // Optimistic updates run inside onMutate so the second of two rapid taps
  // sees the cache state from the first — the count delta is gated on whether
  // membership actually transitioned, so redundant requests are no-ops on the count.
  const addPlaylistMutation = useMutation<unknown, Error, AddPlaylistVars, PlaylistMutationContext>({
    mutationKey: ['addToPlaylist'],
    mutationFn: async ({ playlistId, climbUuid, climbAngle }) => {
      const { token: latestToken } = playlistRef.current;
      if (!latestToken) throw new Error('Not authenticated');
      const client = createGraphQLHttpClient(latestToken);
      return client.request<AddClimbToPlaylistMutationResponse>(ADD_CLIMB_TO_PLAYLIST, {
        input: { playlistId, climbUuid, angle: climbAngle },
      });
    },
    onMutate: async ({ playlistId, climbUuid }) => {
      const {
        cancelMemFetches: latestCancelMemFetches,
        queryClient: latestQueryClient,
        memAccKey: latestMemAccKey,
        playlistsQueryKey: latestPlaylistsQueryKey,
      } = playlistRef.current;
      await latestCancelMemFetches();
      const prevMem = latestQueryClient.getQueryData<Map<string, Set<string>>>(latestMemAccKey);
      const currentSet = prevMem?.get(climbUuid) ?? EMPTY_SET;
      const alreadyMember = currentSet.has(playlistId);
      if (!alreadyMember) {
        const updatedMem = new Map(prevMem ?? new Map());
        const nextSet = new Set(currentSet);
        nextSet.add(playlistId);
        updatedMem.set(climbUuid, nextSet);
        latestQueryClient.setQueryData(latestMemAccKey, updatedMem);
        latestQueryClient.setQueryData<Playlist[]>(latestPlaylistsQueryKey, (prev) =>
          prev?.map((p) => (p.uuid === playlistId ? { ...p, climbCount: p.climbCount + 1 } : p)),
        );
      }
      return { membershipChanged: !alreadyMember };
    },
    onError: (_err, { playlistId, climbUuid }, context) => {
      if (!context?.membershipChanged) return;
      // Reverse only the specific optimistic write made in onMutate, so a concurrent
      // mutation's optimistic state (which may have run between our onMutate and onError)
      // is preserved. Restoring a full snapshot would clobber it.
      const {
        queryClient: latestQueryClient,
        memAccKey: latestMemAccKey,
        playlistsQueryKey: latestPlaylistsQueryKey,
      } = playlistRef.current;
      latestQueryClient.setQueryData<Map<string, Set<string>>>(latestMemAccKey, (current) => {
        if (!current) return current;
        const climbSet = current.get(climbUuid);
        if (!climbSet?.has(playlistId)) return current;
        const updated = new Map(current);
        const nextSet = new Set(climbSet);
        nextSet.delete(playlistId);
        updated.set(climbUuid, nextSet);
        return updated;
      });
      latestQueryClient.setQueryData<Playlist[]>(latestPlaylistsQueryKey, (current) =>
        current?.map((p) => (p.uuid === playlistId ? { ...p, climbCount: Math.max(0, p.climbCount - 1) } : p)),
      );
    },
  });

  const removePlaylistMutation = useMutation<unknown, Error, RemovePlaylistVars, PlaylistMutationContext>({
    mutationKey: ['removeFromPlaylist'],
    mutationFn: async ({ playlistId, climbUuid }) => {
      const { token: latestToken } = playlistRef.current;
      if (!latestToken) throw new Error('Not authenticated');
      const client = createGraphQLHttpClient(latestToken);
      return client.request<RemoveClimbFromPlaylistMutationResponse>(REMOVE_CLIMB_FROM_PLAYLIST, {
        input: { playlistId, climbUuid },
      });
    },
    onMutate: async ({ playlistId, climbUuid }) => {
      const {
        cancelMemFetches: latestCancelMemFetches,
        queryClient: latestQueryClient,
        memAccKey: latestMemAccKey,
        playlistsQueryKey: latestPlaylistsQueryKey,
      } = playlistRef.current;
      await latestCancelMemFetches();
      const prevMem = latestQueryClient.getQueryData<Map<string, Set<string>>>(latestMemAccKey);
      const currentSet = prevMem?.get(climbUuid);
      const wasMember = currentSet?.has(playlistId) ?? false;
      if (wasMember) {
        const updatedMem = new Map(prevMem ?? new Map());
        const nextSet = new Set(currentSet);
        nextSet.delete(playlistId);
        updatedMem.set(climbUuid, nextSet);
        latestQueryClient.setQueryData(latestMemAccKey, updatedMem);
        latestQueryClient.setQueryData<Playlist[]>(latestPlaylistsQueryKey, (prev) =>
          prev?.map((p) => (p.uuid === playlistId ? { ...p, climbCount: Math.max(0, p.climbCount - 1) } : p)),
        );
      }
      return { membershipChanged: wasMember };
    },
    onError: (_err, { playlistId, climbUuid }, context) => {
      if (!context?.membershipChanged) return;
      const {
        queryClient: latestQueryClient,
        memAccKey: latestMemAccKey,
        playlistsQueryKey: latestPlaylistsQueryKey,
      } = playlistRef.current;
      latestQueryClient.setQueryData<Map<string, Set<string>>>(latestMemAccKey, (current) => {
        if (!current) return current;
        const climbSet = current.get(climbUuid) ?? EMPTY_SET;
        if (climbSet.has(playlistId)) return current;
        const updated = new Map(current);
        const nextSet = new Set(climbSet);
        nextSet.add(playlistId);
        updated.set(climbUuid, nextSet);
        return updated;
      });
      latestQueryClient.setQueryData<Playlist[]>(latestPlaylistsQueryKey, (current) =>
        current?.map((p) => (p.uuid === playlistId ? { ...p, climbCount: p.climbCount + 1 } : p)),
      );
    },
  });

  const addPlaylistMutateRef = useRef(addPlaylistMutation.mutateAsync);
  addPlaylistMutateRef.current = addPlaylistMutation.mutateAsync;
  const removePlaylistMutateRef = useRef(removePlaylistMutation.mutateAsync);
  removePlaylistMutateRef.current = removePlaylistMutation.mutateAsync;

  const addToPlaylist = useCallback(async (playlistId: string, climbUuid: string, climbAngle: number) => {
    await addPlaylistMutateRef.current({ playlistId, climbUuid, climbAngle });
  }, []);

  const removeFromPlaylist = useCallback(async (playlistId: string, climbUuid: string) => {
    await removePlaylistMutateRef.current({ playlistId, climbUuid });
  }, []);

  const createPlaylist = useCallback(
    async (name: string, description?: string, color?: string, icon?: string): Promise<Playlist> => {
      const r = playlistRef.current;
      if (!r.token) throw new Error('Not authenticated');
      const client = createGraphQLHttpClient(r.token);
      const response = await client.request<CreatePlaylistMutationResponse>(CREATE_PLAYLIST, {
        input: { boardType: r.boardName, layoutId: r.layoutId, name, description, color, icon },
      });
      r.queryClient.setQueryData<Playlist[]>(r.playlistsQueryKey, (prev) =>
        prev ? [response.createPlaylist, ...prev] : [response.createPlaylist],
      );
      return response.createPlaylist;
    },
    [],
  );

  const refreshPlaylists = useCallback(async () => {
    const r = playlistRef.current;
    await r.queryClient.invalidateQueries({ queryKey: r.playlistsQueryKey });
  }, []);

  return {
    favoritesProviderProps: {
      favorites,
      toggleFavorite,
      isLoading: isLoadingFavorites,
      isAuthenticated,
    },
    playlistsProviderProps: {
      playlists,
      playlistMemberships: membershipsData,
      addToPlaylist,
      removeFromPlaylist,
      createPlaylist,
      isLoading: playlistsLoading,
      isAuthenticated,
      refreshPlaylists,
    },
  };
}
