import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  GET_PLAYLISTS_FOR_CLIMB,
  type GetPlaylistsForClimbQueryResponse,
} from '@boardsesh/graphql/operations/playlists';
import { getHttpClient } from '../lib/graphql/client';

type UseClimbPlaylistMembershipQueryArgs = {
  climbUuid: string;
  boardName: string;
  layoutId: number;
  /** Fetch gate. Cached data is still returned when false — the caller just
   *  doesn't trigger a request of its own (see the play drawer's peek header). */
  enabled: boolean;
};

type ClimbPlaylistMembershipQueryResult = {
  /** React Query key for this climb's membership. Exported so callers can write
   *  optimistic updates (`setQueryData`) / cancel in-flight fetches against the
   *  same entry every other surface reads. */
  membershipKey: readonly ['playlistsForClimb', string, number, string];
  /** The playlist UUIDs this climb belongs to, or undefined before the first
   *  response (and while disabled with nothing cached). */
  memberUuids: string[] | undefined;
};

/**
 * One climb's playlist membership, fetched directly rather than read from the
 * shared `playlistMembershipStore`.
 *
 * The store is fed by exactly one hook (`useClimbListPlaylistMemberships`) called
 * from the Climbs tab, so any surface a climber can reach another way — the play
 * drawer opened from the queue, from a playlist, or from a deep link — has no
 * membership at all. Those surfaces need their own per-climb fetch.
 *
 * Every caller shares one query key, so the add-to-playlist picker's optimistic
 * writes land on the same cache entry the play-drawer chips read: toggle a
 * playlist in the sheet and the header updates with no refetch.
 *
 * `staleTime` 30s with focus/reconnect refetching off, matching the picker's
 * original settings: optimistic toggle writes are the source of truth while a
 * climber is working, and a late refetch must not land a stale set over them.
 */
export function useClimbPlaylistMembershipQuery({
  climbUuid,
  boardName,
  layoutId,
  enabled,
}: UseClimbPlaylistMembershipQueryArgs): ClimbPlaylistMembershipQueryResult {
  const membershipKey = useMemo(
    () => ['playlistsForClimb', boardName, layoutId, climbUuid] as const,
    [boardName, layoutId, climbUuid],
  );

  const { data: memberUuids } = useQuery({
    queryKey: membershipKey,
    queryFn: async (): Promise<string[]> => {
      const response = await getHttpClient().request<GetPlaylistsForClimbQueryResponse>(GET_PLAYLISTS_FOR_CLIMB, {
        input: { boardType: boardName, layoutId, climbUuid },
      });
      return response.playlistsForClimb;
    },
    enabled,
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  return { membershipKey, memberUuids };
}
