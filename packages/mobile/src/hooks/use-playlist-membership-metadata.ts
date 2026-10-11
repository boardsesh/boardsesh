import { useCallback, useMemo } from 'react';
import { useQueries, type UseQueryResult } from '@tanstack/react-query';
import { GET_PLAYLIST, type GetPlaylistQueryResponse, type Playlist } from '@boardsesh/graphql/operations/playlists';
import { getHttpClient } from '../lib/graphql/client';

const EMPTY_PLAYLISTS = new Map<string, Playlist>();

type MembershipMetadataArgs = {
  playlistUuids: Iterable<string>;
  knownPlaylists: Map<string, Playlist> | undefined;
  enabled: boolean;
};

/** Resolve only missing memberships, without draining the user's playlist pages.
 * The offscreen peek observes the same cache without starting requests. */
export function usePlaylistMembershipMetadata({
  playlistUuids,
  knownPlaylists = EMPTY_PLAYLISTS,
  enabled,
}: MembershipMetadataArgs): Map<string, Playlist> {
  const missingUuids = useMemo(
    () => [...new Set(playlistUuids)].filter((uuid) => !knownPlaylists.has(uuid)),
    [playlistUuids, knownPlaylists],
  );
  const combine = useCallback(
    (results: UseQueryResult<Playlist | null>[]) => {
      const resolved = new Map(knownPlaylists);
      for (const result of results) {
        if (!result.data) continue;
        resolved.set(result.data.uuid, result.data);
        resolved.set(result.data.id, result.data);
      }
      return resolved;
    },
    [knownPlaylists],
  );
  return useQueries({
    queries: missingUuids.map((uuid) => ({
      // Shared with the playlist detail screen and mutation invalidations.
      queryKey: ['playlist', uuid],
      queryFn: async () => {
        const response = await getHttpClient().request<GetPlaylistQueryResponse>(GET_PLAYLIST, {
          playlistId: uuid,
        });
        return response.playlist;
      },
      enabled,
      staleTime: 30 * 1000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    })),
    combine,
  });
}
