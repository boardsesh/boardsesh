import { useCallback, useMemo } from 'react';
import {
  CREATE_PLAYLIST,
  UPDATE_PLAYLIST,
  DELETE_PLAYLIST,
  PIN_PLAYLIST,
  UNPIN_PLAYLIST,
  FOLLOW_PLAYLIST,
  UNFOLLOW_PLAYLIST,
  type CreatePlaylistInput,
  type CreatePlaylistMutationResponse,
  type CreatePlaylistMutationVariables,
  type UpdatePlaylistInput,
  type UpdatePlaylistMutationResponse,
  type UpdatePlaylistMutationVariables,
  type DeletePlaylistMutationResponse,
  type DeletePlaylistMutationVariables,
  type PinPlaylistMutationResponse,
  type PinPlaylistMutationVariables,
  type UnpinPlaylistMutationResponse,
  type UnpinPlaylistMutationVariables,
  type FollowPlaylistMutationResponse,
  type FollowPlaylistMutationVariables,
  type UnfollowPlaylistMutationResponse,
  type UnfollowPlaylistMutationVariables,
  type Playlist,
} from '@boardsesh/graphql/operations/playlists';
import { usePlaylistsAdapter, type ExecutePlaylistsGraphQL } from './adapter';

export type UsePlaylistMutationsOptions = {
  /** Override the adapter's `executeGraphQL` (used in tests). */
  executeGraphQL?: ExecutePlaylistsGraphQL;
};

export type UsePlaylistMutationsResult = {
  createPlaylist: (input: CreatePlaylistInput) => Promise<Playlist>;
  updatePlaylist: (input: UpdatePlaylistInput) => Promise<Playlist>;
  deletePlaylist: (playlistId: string) => Promise<boolean>;
  pinPlaylist: (playlistUuid: string) => Promise<boolean>;
  unpinPlaylist: (playlistUuid: string) => Promise<boolean>;
  followPlaylist: (playlistUuid: string) => Promise<boolean>;
  unfollowPlaylist: (playlistUuid: string) => Promise<boolean>;
};

/**
 * Renderer-agnostic playlist mutation callbacks shared by web and mobile.
 *
 * Mirrors the read hooks' house style: each method forwards the matching
 * GraphQL document through the adapter's `executeGraphQL` and returns the
 * unwrapped payload. It deliberately owns NO optimistic state, toasts, or
 * cache invalidation — those stay platform/screen concerns (web keeps its
 * component-local optimism; mobile flips its react-query `['playlist', uuid]`
 * cache and re-runs the read hooks' `refetch()`).
 */
export function usePlaylistMutations(options?: UsePlaylistMutationsOptions): UsePlaylistMutationsResult {
  const adapter = usePlaylistsAdapter();
  const executeGraphQL = options?.executeGraphQL ?? adapter.executeGraphQL;
  const localLibrary = options?.executeGraphQL ? undefined : adapter.localLibrary;

  const createPlaylist = useCallback(
    async (input: CreatePlaylistInput): Promise<Playlist> => {
      if (localLibrary) return localLibrary.create(input);
      const response = await executeGraphQL<CreatePlaylistMutationResponse, CreatePlaylistMutationVariables>(
        CREATE_PLAYLIST,
        { input },
      );
      return response.createPlaylist;
    },
    [executeGraphQL, localLibrary],
  );

  const updatePlaylist = useCallback(
    async (input: UpdatePlaylistInput): Promise<Playlist> => {
      if (localLibrary) return localLibrary.update(input);
      const response = await executeGraphQL<UpdatePlaylistMutationResponse, UpdatePlaylistMutationVariables>(
        UPDATE_PLAYLIST,
        { input },
      );
      return response.updatePlaylist;
    },
    [executeGraphQL, localLibrary],
  );

  const deletePlaylist = useCallback(
    async (playlistId: string): Promise<boolean> => {
      if (localLibrary) return localLibrary.delete(playlistId);
      const response = await executeGraphQL<DeletePlaylistMutationResponse, DeletePlaylistMutationVariables>(
        DELETE_PLAYLIST,
        { playlistId },
      );
      return response.deletePlaylist;
    },
    [executeGraphQL, localLibrary],
  );

  const pinPlaylist = useCallback(
    async (playlistUuid: string): Promise<boolean> => {
      const response = await executeGraphQL<PinPlaylistMutationResponse, PinPlaylistMutationVariables>(PIN_PLAYLIST, {
        input: { playlistUuid },
      });
      return response.pinPlaylist;
    },
    [executeGraphQL],
  );

  const unpinPlaylist = useCallback(
    async (playlistUuid: string): Promise<boolean> => {
      const response = await executeGraphQL<UnpinPlaylistMutationResponse, UnpinPlaylistMutationVariables>(
        UNPIN_PLAYLIST,
        { input: { playlistUuid } },
      );
      return response.unpinPlaylist;
    },
    [executeGraphQL],
  );

  const followPlaylist = useCallback(
    async (playlistUuid: string): Promise<boolean> => {
      const response = await executeGraphQL<FollowPlaylistMutationResponse, FollowPlaylistMutationVariables>(
        FOLLOW_PLAYLIST,
        { input: { playlistUuid } },
      );
      return response.followPlaylist;
    },
    [executeGraphQL],
  );

  const unfollowPlaylist = useCallback(
    async (playlistUuid: string): Promise<boolean> => {
      const response = await executeGraphQL<UnfollowPlaylistMutationResponse, UnfollowPlaylistMutationVariables>(
        UNFOLLOW_PLAYLIST,
        { input: { playlistUuid } },
      );
      return response.unfollowPlaylist;
    },
    [executeGraphQL],
  );

  return useMemo(
    () => ({
      createPlaylist,
      updatePlaylist,
      deletePlaylist,
      pinPlaylist,
      unpinPlaylist,
      followPlaylist,
      unfollowPlaylist,
    }),
    [createPlaylist, updatePlaylist, deletePlaylist, pinPlaylist, unpinPlaylist, followPlaylist, unfollowPlaylist],
  );
}
