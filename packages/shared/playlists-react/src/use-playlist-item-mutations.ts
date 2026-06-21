import { useCallback, useMemo } from 'react';
import {
  REORDER_PLAYLIST_CLIMB,
  REMOVE_CLIMB_FROM_PLAYLIST,
  type ReorderPlaylistClimbInput,
  type ReorderPlaylistClimbMutationResponse,
  type ReorderPlaylistClimbMutationVariables,
  type RemoveClimbFromPlaylistInput,
  type RemoveClimbFromPlaylistMutationResponse,
  type RemoveClimbFromPlaylistMutationVariables,
} from '@boardsesh/graphql/operations/playlists';
import { usePlaylistsAdapter, type ExecutePlaylistsGraphQL } from './adapter';

export type UsePlaylistItemMutationsOptions = {
  /** Override the adapter's `executeGraphQL` (used in tests). */
  executeGraphQL?: ExecutePlaylistsGraphQL;
};

export type UsePlaylistItemMutationsResult = {
  /** Move a climb to a new 0-based index in the playlist's ordered list. */
  reorderPlaylistClimb: (input: ReorderPlaylistClimbInput) => Promise<boolean>;
  /** Remove a climb from the playlist. */
  removeClimbFromPlaylist: (input: RemoveClimbFromPlaylistInput) => Promise<boolean>;
};

/**
 * Renderer-agnostic item-level playlist mutations (reorder / remove) shared by
 * web and mobile. Mirrors `use-playlist-mutations.ts`: each method forwards the
 * matching GraphQL document through the adapter's `executeGraphQL` and returns
 * the unwrapped payload. Owns NO optimistic state, toasts, or cache
 * invalidation — those stay platform/screen concerns.
 */
export function usePlaylistItemMutations(options?: UsePlaylistItemMutationsOptions): UsePlaylistItemMutationsResult {
  const adapter = usePlaylistsAdapter();
  const executeGraphQL = options?.executeGraphQL ?? adapter.executeGraphQL;

  const reorderPlaylistClimb = useCallback(
    async (input: ReorderPlaylistClimbInput): Promise<boolean> => {
      const response = await executeGraphQL<
        ReorderPlaylistClimbMutationResponse,
        ReorderPlaylistClimbMutationVariables
      >(REORDER_PLAYLIST_CLIMB, { input });
      return response.reorderPlaylistClimb;
    },
    [executeGraphQL],
  );

  const removeClimbFromPlaylist = useCallback(
    async (input: RemoveClimbFromPlaylistInput): Promise<boolean> => {
      const response = await executeGraphQL<
        RemoveClimbFromPlaylistMutationResponse,
        RemoveClimbFromPlaylistMutationVariables
      >(REMOVE_CLIMB_FROM_PLAYLIST, { input });
      return response.removeClimbFromPlaylist;
    },
    [executeGraphQL],
  );

  return useMemo(
    () => ({ reorderPlaylistClimb, removeClimbFromPlaylist }),
    [reorderPlaylistClimb, removeClimbFromPlaylist],
  );
}
