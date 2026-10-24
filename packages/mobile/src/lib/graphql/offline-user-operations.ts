import type { SQLiteDatabase } from 'expo-sqlite';
import { canServeLocalUserData } from '@boardsesh/offline-sync';
import { GET_TICKS, type GetTicksQueryVariables, type GetTicksQueryResponse } from '@boardsesh/graphql/operations';
import {
  GET_FAVORITES,
  type FavoritesQueryVariables,
  type FavoritesQueryResponse,
} from '@boardsesh/graphql/operations/favorites';
import {
  GET_ALL_USER_PLAYLISTS,
  GET_USER_PLAYLISTS,
  GET_PLAYLIST,
  GET_PLAYLIST_CLIMBS,
  GET_PLAYLISTS_FOR_CLIMB,
  GET_PLAYLISTS_FOR_CLIMBS,
  GET_PLAYLIST_SETTERS,
  type GetAllUserPlaylistsQueryVariables,
  type GetAllUserPlaylistsQueryResponse,
  type GetUserPlaylistsQueryVariables,
  type GetUserPlaylistsQueryResponse,
  type GetPlaylistQueryVariables,
  type GetPlaylistQueryResponse,
  type GetPlaylistClimbsQueryVariables,
  type GetPlaylistClimbsQueryResponse,
  type GetPlaylistsForClimbQueryVariables,
  type GetPlaylistsForClimbQueryResponse,
  type GetPlaylistsForClimbsQueryVariables,
  type GetPlaylistsForClimbsQueryResponse,
  type PlaylistSettersInput,
  type GetPlaylistSettersQueryResponse,
} from '@boardsesh/graphql/operations/playlists';
import { getTicksLocal } from '../../db/queries/get-ticks-local';
import { getFavoriteStatusLocal } from '../../db/queries/get-favorite-status-local';
import {
  getAllUserPlaylistsLocal,
  getUserPlaylistsLocal,
  getPlaylistLocal,
  getPlaylistClimbsLocal,
  getPlaylistsForClimbLocal,
  getPlaylistsForClimbsLocal,
  getPlaylistSettersLocal,
  getPlaylistReadUnavailableReason,
} from '../../db/queries/get-playlists-local';
import type { OfflineOperation } from './offline-request';
import type { OfflineUserReadFamily } from './offline-user-read-recovery';

async function viewerId(): Promise<string | null> {
  const { readLocalUserId } = await import('../local-user-id');
  return (await readLocalUserId()) ?? null;
}

type Register = <TVariables, TResponse>(operation: OfflineOperation<TVariables, TResponse>) => void;

/** User tables sync per account, independently of any catalogue download. */
export function registerOfflineUserOperations(register: Register): void {
  function add<TVariables, TResponse>(
    document: string,
    family: OfflineUserReadFamily,
    boardNameOf: (variables: TVariables) => string,
    resolve: (db: SQLiteDatabase, variables: TVariables, owner: string) => Promise<TResponse | null>,
    unavailableReason?: OfflineOperation<TVariables, TResponse>['unavailableReason'],
  ) {
    register<TVariables, TResponse>({
      document,
      localFirstWhileOnline: false,
      userDataFamily: family,
      surface: family,
      boardNameOf,
      canServeLocal: async (db) => canServeLocalUserData(db, await viewerId()),
      resolveLocal: async (db, variables) => {
        const owner = await viewerId();
        return owner ? resolve(db, variables, owner) : null;
      },
      unavailableReason: unavailableReason ?? (async () => 'user_data_unavailable'),
      // No fallback: a declined read must never be cached as a real empty result.
    });
  }

  add<GetTicksQueryVariables, GetTicksQueryResponse>(
    GET_TICKS,
    'logbook',
    ({ input }) => input.boardType,
    (db, { input }, owner) => getTicksLocal(db, input, owner),
  );
  add<FavoritesQueryVariables, FavoritesQueryResponse>(
    GET_FAVORITES,
    'favorites',
    ({ boardName }) => boardName,
    (db, { climbUuids }, owner) => getFavoriteStatusLocal(db, climbUuids, owner),
  );
  add<GetAllUserPlaylistsQueryVariables, GetAllUserPlaylistsQueryResponse>(
    GET_ALL_USER_PLAYLISTS,
    'playlists',
    ({ input }) => input.boardType ?? 'all',
    (db, { input }, owner) => getAllUserPlaylistsLocal(db, input, owner),
  );
  add<GetUserPlaylistsQueryVariables, GetUserPlaylistsQueryResponse>(
    GET_USER_PLAYLISTS,
    'playlists',
    ({ input }) => input.boardType,
    (db, { input }, owner) => getUserPlaylistsLocal(db, input, owner),
  );
  add<GetPlaylistQueryVariables, GetPlaylistQueryResponse>(
    GET_PLAYLIST,
    'playlists',
    () => 'all',
    (db, { playlistId }, owner) => getPlaylistLocal(db, playlistId, owner),
  );
  add<GetPlaylistClimbsQueryVariables, GetPlaylistClimbsQueryResponse>(
    GET_PLAYLIST_CLIMBS,
    'playlists',
    ({ input }) => input.boardName ?? 'all',
    (db, { input }, owner) => getPlaylistClimbsLocal(db, input, owner),
    async (db, { input }) => {
      const owner = await viewerId();
      return owner
        ? ((await getPlaylistReadUnavailableReason(db, input, owner)) ?? 'user_data_unavailable')
        : 'user_data_unavailable';
    },
  );
  add<GetPlaylistsForClimbQueryVariables, GetPlaylistsForClimbQueryResponse>(
    GET_PLAYLISTS_FOR_CLIMB,
    'playlists',
    ({ input }) => input.boardType,
    (db, { input }, owner) => getPlaylistsForClimbLocal(db, input, owner),
  );
  add<GetPlaylistsForClimbsQueryVariables, GetPlaylistsForClimbsQueryResponse>(
    GET_PLAYLISTS_FOR_CLIMBS,
    'playlists',
    ({ input }) => input.boardType,
    (db, { input }, owner) => getPlaylistsForClimbsLocal(db, input, owner),
  );
  add<{ input: PlaylistSettersInput }, GetPlaylistSettersQueryResponse>(
    GET_PLAYLIST_SETTERS,
    'playlists',
    ({ input }) => input.boardName ?? 'all',
    (db, { input }, owner) => getPlaylistSettersLocal(db, input, owner),
  );
}
