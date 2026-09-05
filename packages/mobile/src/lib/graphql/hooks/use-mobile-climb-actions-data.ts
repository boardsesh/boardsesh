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
// Account favorites still rely on the screen-level GraphQL batches. A login-free
// profile instead reads the active board+angle set directly from its owner-stamped
// SQLite file, so the provider can drive hearts without any backend request.

import { useCallback, useMemo, useRef } from 'react';
import { randomUUID } from 'expo-crypto';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { favoritesStore } from '@boardsesh/climb-actions';
import { TOGGLE_FAVORITE, type ToggleFavoriteMutationResponse } from '@boardsesh/graphql/operations/favorites';
import {
  GET_ALL_USER_PLAYLISTS,
  ADD_CLIMB_TO_PLAYLIST,
  REMOVE_CLIMB_FROM_PLAYLIST,
  CREATE_PLAYLIST,
  type Playlist,
  type GetAllUserPlaylistsQueryResponse,
  type AddClimbToPlaylistMutationResponse,
  type RemoveClimbFromPlaylistMutationResponse,
  type CreatePlaylistMutationResponse,
} from '@boardsesh/graphql/operations/playlists';
import { getHttpClient } from '../client';
import { useAuth } from '../../../providers/auth-provider';
import { useOfflineDownloadsEnabled } from '../../../providers/feature-flags-provider';
import { useActiveBoard } from '../use-active-board';
import type { PlaylistCreateBoard } from '../../../providers/playlists-provider';
import { getDatabaseHandle } from '../../../db';
import {
  addClimbToPlaylistLocal,
  addFavoriteLocal,
  createPlaylistLocal,
  getFavoriteClimbUuidsLocal,
  getPlaylistMembershipsLocal,
  getPlaylistsLocal,
  removeClimbFromPlaylistLocal,
  removeFavoriteLocal,
} from '../../../hooks/use-offline-mutations';
import type { GraphQLFetch } from '@boardsesh/offline-sync';
import { drainMutationQueue } from '../../../offline/offline-sync-adapter';
import { useSetting } from '../../../settings';

const PLAYLISTS_QUERY_KEY = ['userPlaylists'] as const;
const LOCAL_PLAYLIST_MEMBERSHIPS_QUERY_KEY = ['localPlaylistMemberships'] as const;
const EMPTY_FAVORITE_UUIDS: string[] = [];
const EMPTY_PLAYLIST_MEMBERSHIPS = new Map<string, Set<string>>();

function graphqlFetchFromClient(): GraphQLFetch {
  return (query, variables) => getHttpClient().request(query, variables);
}

function scheduleDrain(db: NonNullable<ReturnType<typeof getDatabaseHandle>>, queryClient: QueryClient) {
  void drainMutationQueue(db, queryClient, graphqlFetchFromClient()).catch((error: unknown) => {
    if (__DEV__) {
      console.warn('[MutationQueue] drain failed after local write:', error);
    }
  });
}

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
    playlistMemberships?: Map<string, Set<string>>;
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
  const { isLoading: isAuthLoading, accessCapabilities } = useAuth();
  const canUseAccountFeatures = accessCapabilities.useAccountFeatures;
  const canUseLocalFavorites = accessCapabilities.useLocalFavorites;
  const canUseLocalPlaylists = accessCapabilities.useLocalPlaylists;
  const canUseFavorites = canUseAccountFeatures || canUseLocalFavorites;
  const [workOffline] = useSetting('workOffline');
  const accountWorkOffline = accessCapabilities.chooseLocalProfile && canUseAccountFeatures && workOffline;
  const canUseFavoritesLocally = canUseLocalFavorites || accountWorkOffline;
  const canUsePlaylistsLocally = canUseLocalPlaylists || accountWorkOffline;
  const offlineEnabled = useOfflineDownloadsEnabled();
  const { data: activeBoard } = useActiveBoard();
  const queryClient = useQueryClient();
  const localFavoritesDb = canUseFavoritesLocally ? getDatabaseHandle() : null;

  const { data: localFavoriteUuids = EMPTY_FAVORITE_UUIDS, isLoading: localFavoritesLoading } = useQuery({
    queryKey: ['localFavorites', activeBoard?.boardType, activeBoard?.angle],
    queryFn: async (): Promise<string[]> => {
      if (!localFavoritesDb) throw new Error('Local storage unavailable');
      if (!activeBoard || activeBoard.angle == null) return [];
      return getFavoriteClimbUuidsLocal(localFavoritesDb, activeBoard.boardType, activeBoard.angle);
    },
    enabled: canUseFavoritesLocally && localFavoritesDb !== null && activeBoard != null && activeBoard.angle != null,
    staleTime: Infinity,
  });
  const localFavorites = useMemo(
    () => new Set(canUseFavoritesLocally ? localFavoriteUuids : EMPTY_FAVORITE_UUIDS),
    [canUseFavoritesLocally, localFavoriteUuids],
  );

  // === Playlists ===

  const { data: playlists = [] as Playlist[], isLoading: playlistsLoading } = useQuery({
    queryKey: PLAYLISTS_QUERY_KEY,
    queryFn: async (): Promise<Playlist[]> => {
      if (canUsePlaylistsLocally) {
        const db = getDatabaseHandle();
        if (!db) throw new Error('Local storage unavailable');
        return getPlaylistsLocal(db);
      }
      const response = await getHttpClient().request<GetAllUserPlaylistsQueryResponse>(GET_ALL_USER_PLAYLISTS, {
        input: { pageSize: 200 },
      });
      return response.allUserPlaylists.playlists;
    },
    enabled: (canUseAccountFeatures || canUseLocalPlaylists) && !isAuthLoading,
    staleTime: 5 * 60 * 1000,
  });
  const { data: localPlaylistMemberships = EMPTY_PLAYLIST_MEMBERSHIPS } = useQuery({
    queryKey: LOCAL_PLAYLIST_MEMBERSHIPS_QUERY_KEY,
    queryFn: async () => {
      const db = getDatabaseHandle();
      if (!db) throw new Error('Local storage unavailable');
      return getPlaylistMembershipsLocal(db);
    },
    enabled: canUsePlaylistsLocally && !isAuthLoading,
    staleTime: Infinity,
  });

  // === Mutations ===

  // Bag of mutation deps in a single ref so the public callbacks below stay
  // referentially stable across renders (avoids cascading the entire provider
  // tree on every activeBoard refresh).
  const mutationDepsRef = useRef({
    activeBoard,
    queryClient,
    canUseAccountFeatures,
    canUseLocalFavorites,
    canUseLocalPlaylists,
    accountWorkOffline,
    canUseFavoritesLocally,
    canUsePlaylistsLocally,
    localFavoriteUuids,
    offlineEnabled,
  });
  mutationDepsRef.current = {
    activeBoard,
    queryClient,
    canUseAccountFeatures,
    canUseLocalFavorites,
    canUseLocalPlaylists,
    accountWorkOffline,
    canUseFavoritesLocally,
    canUsePlaylistsLocally,
    localFavoriteUuids,
    offlineEnabled,
  };

  const toggleFavoriteMutation = useMutation({
    mutationFn: async (climbUuid: string): Promise<{ uuid: string; favorited: boolean }> => {
      const {
        activeBoard: board,
        queryClient: client,
        canUseAccountFeatures: accountFeatures,
        canUseFavoritesLocally: localFavoritesEnabled,
        localFavoriteUuids: favoriteUuids,
        offlineEnabled: offline,
      } = mutationDepsRef.current;
      if (!board) throw new Error('Cannot toggle favorite: no active board selected.');
      // The favorite key is (userId, boardName, climbUuid, angle) on the
      // backend today. Defaulting a missing angle to 0 would silently file
      // the favorite under the wrong climb variant — better to surface the
      // problem at the call site than write bad data. Stops being relevant
      // once #2449 lands and the key collapses to (userId, climbUuid).
      if (board.angle == null) throw new Error('Cannot toggle favorite: active board has no angle.');
      const input = { boardName: board.boardType, climbUuid, angle: board.angle };
      const currentlyFavorited = localFavoritesEnabled
        ? favoriteUuids.includes(climbUuid)
        : favoritesStore.getIsFavorited(climbUuid);
      const db = getDatabaseHandle();

      if (localFavoritesEnabled) {
        if (!db) throw new Error('Local storage unavailable');
        const delivery = accountFeatures ? 'account' : 'local-only';
        if (currentlyFavorited) {
          await removeFavoriteLocal(db, input, delivery);
        } else {
          await addFavoriteLocal(db, input, delivery);
        }
        const queryKey = ['localFavorites', board.boardType, board.angle] as const;
        client.setQueryData<string[]>(queryKey, (existing = []) =>
          currentlyFavorited
            ? existing.filter((favoriteUuid) => favoriteUuid !== climbUuid)
            : [...new Set([...existing, climbUuid])],
        );
        if (delivery === 'account') scheduleDrain(db, client);
        return { uuid: climbUuid, favorited: !currentlyFavorited };
      }

      if (!accountFeatures) throw new Error('Not authenticated');

      // Local-first only with the offline flag on; otherwise the plain
      // network toggle below — pre-offline behavior.
      if (offline && db) {
        if (currentlyFavorited) {
          await removeFavoriteLocal(db, input, 'account');
        } else {
          await addFavoriteLocal(db, input, 'account');
        }
        scheduleDrain(db, client);
        return { uuid: climbUuid, favorited: !currentlyFavorited };
      }

      const response = await getHttpClient().request<ToggleFavoriteMutationResponse>(TOGGLE_FAVORITE, {
        input,
      });
      return { uuid: climbUuid, favorited: response.toggleFavorite.favorited };
    },
  });

  const addPlaylistMutation = useMutation({
    mutationFn: async (vars: { playlistId: string; climbUuid: string; angle: number }) => {
      if (mutationDepsRef.current.canUsePlaylistsLocally) {
        const db = getDatabaseHandle();
        if (!db) throw new Error('Local storage unavailable');
        const input = { playlistId: vars.playlistId, climbUuid: vars.climbUuid, angle: vars.angle };
        const delivery = mutationDepsRef.current.accountWorkOffline ? 'account' : 'local-only';
        const wasAlreadyInPlaylist = await addClimbToPlaylistLocal(db, input, delivery);
        if (delivery === 'account') scheduleDrain(db, mutationDepsRef.current.queryClient);
        return {
          addClimbToPlaylist: {
            id: `${vars.playlistId}:${vars.climbUuid}`,
            playlistId: vars.playlistId,
            climbUuid: vars.climbUuid,
            angle: vars.angle,
            position: 0,
            addedAt: new Date().toISOString(),
            wasAlreadyInPlaylist,
          },
        };
      }
      return getHttpClient().request<AddClimbToPlaylistMutationResponse>(ADD_CLIMB_TO_PLAYLIST, {
        input: { playlistId: vars.playlistId, climbUuid: vars.climbUuid, angle: vars.angle },
      });
    },
    // Gate the +1 on server truth. The picker decides "add vs remove" from a
    // membership cache that is empty or stale until its per-climb query lands,
    // so tapping a row for a climb the playlist already holds sends an add —
    // which the backend idempotently no-ops. Bumping unconditionally inflated
    // the cached count on every such tap (#4014). A pre-`wasAlreadyInPlaylist`
    // server (or a response that omits the field) yields undefined, which keeps
    // the old +1 behaviour.
    onSuccess: (response, vars) => {
      const { queryClient: client, canUsePlaylistsLocally: localPlaylistsEnabled } = mutationDepsRef.current;
      if (localPlaylistsEnabled) {
        client.setQueryData<Map<string, Set<string>>>(LOCAL_PLAYLIST_MEMBERSHIPS_QUERY_KEY, (existing) => {
          const next = new Map(existing ?? EMPTY_PLAYLIST_MEMBERSHIPS);
          const memberships = new Set(next.get(vars.climbUuid) ?? []);
          memberships.add(vars.playlistId);
          next.set(vars.climbUuid, memberships);
          return next;
        });
      } else {
        invalidatePlaylistDetail(client, vars.playlistId);
      }
      if (response.addClimbToPlaylist.wasAlreadyInPlaylist !== true) {
        bumpPlaylistClimbCount(client, vars.playlistId, 1);
      }
    },
  });

  const removePlaylistMutation = useMutation({
    mutationFn: async (vars: { playlistId: string; climbUuid: string }) => {
      if (mutationDepsRef.current.canUsePlaylistsLocally) {
        const db = getDatabaseHandle();
        if (!db) throw new Error('Local storage unavailable');
        const delivery = mutationDepsRef.current.accountWorkOffline ? 'account' : 'local-only';
        const removed = await removeClimbFromPlaylistLocal(db, vars, delivery);
        if (delivery === 'account') scheduleDrain(db, mutationDepsRef.current.queryClient);
        return { removeClimbFromPlaylist: removed };
      }
      return getHttpClient().request<RemoveClimbFromPlaylistMutationResponse>(REMOVE_CLIMB_FROM_PLAYLIST, {
        input: { playlistId: vars.playlistId, climbUuid: vars.climbUuid },
      });
    },
    // Mirror of the add gating: the resolver now returns false when nothing was
    // deleted (the climb wasn't in the playlist), so a no-op remove no longer
    // decrements the cached count.
    onSuccess: (response, vars) => {
      const { queryClient: client, canUsePlaylistsLocally: localPlaylistsEnabled } = mutationDepsRef.current;
      if (localPlaylistsEnabled) {
        client.setQueryData<Map<string, Set<string>>>(LOCAL_PLAYLIST_MEMBERSHIPS_QUERY_KEY, (existing) => {
          const next = new Map(existing ?? EMPTY_PLAYLIST_MEMBERSHIPS);
          const memberships = new Set(next.get(vars.climbUuid) ?? []);
          memberships.delete(vars.playlistId);
          if (memberships.size === 0) next.delete(vars.climbUuid);
          else next.set(vars.climbUuid, memberships);
          return next;
        });
      } else {
        invalidatePlaylistDetail(client, vars.playlistId);
      }
      if (response.removeClimbFromPlaylist === true) {
        bumpPlaylistClimbCount(client, vars.playlistId, -1);
      }
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
      if (mutationDepsRef.current.canUsePlaylistsLocally) {
        const db = getDatabaseHandle();
        if (!db) throw new Error('Local storage unavailable');
        const delivery = mutationDepsRef.current.accountWorkOffline ? 'account' : 'local-only';
        const created = await createPlaylistLocal(
          db,
          {
            boardType: board.boardType,
            layoutId: board.layoutId,
            name: vars.name,
            description: vars.description,
            color: vars.color,
            icon: vars.icon,
          },
          randomUUID(),
          delivery,
        );
        if (delivery === 'account') scheduleDrain(db, mutationDepsRef.current.queryClient);
        return created;
      }
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
    const { canUseAccountFeatures: accountFeatures, canUseFavoritesLocally: localFavoritesEnabled } =
      mutationDepsRef.current;
    if (!accountFeatures && !localFavoritesEnabled) return false;
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
    await client.invalidateQueries({ queryKey: LOCAL_PLAYLIST_MEMBERSHIPS_QUERY_KEY });
  }, []);

  return {
    favoritesProviderProps: {
      // Stable for the current SQLite query result, so FavoritesProvider does
      // not republish an identical Set on unrelated parent renders.
      favorites: localFavorites,
      toggleFavorite,
      isLoading: isAuthLoading || (canUseFavoritesLocally && localFavoritesLoading),
      isAuthenticated: canUseFavorites,
    },
    // `playlistMemberships` is deliberately not passed: PlaylistsProvider's prop
    // is optional and falls back to a module-level empty Map, which keeps its
    // `getPlaylistsForClimb` memo (and the context value hanging off it)
    // referentially stable. Handing it a fresh Map per render busted both memos
    // and re-rendered every consumer on every parent render (#4014). Real
    // per-climb memberships come from `playlistMembershipStore` plus
    // InlinePlaylistPicker's `playlistsForClimb` query, not from this hook.
    playlistsProviderProps: {
      playlists,
      ...(canUsePlaylistsLocally ? { playlistMemberships: localPlaylistMemberships } : {}),
      addToPlaylist,
      removeFromPlaylist,
      createPlaylist,
      isLoading: playlistsLoading,
      isAuthenticated: canUseAccountFeatures || canUseLocalPlaylists,
      refreshPlaylists,
    },
  };
}
