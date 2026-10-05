// Whether the signed-in climber has at least one liked climb on a board type.
//
// The Climbs "saved climbs" card (#6002) is gated on this instead of
// `useSmartPlaylistCounts`: that count is across every board, so a climber with
// three hearts on a Tension would be offered "saved climbs" while standing at a
// Kilter. This asks for the first row of the liked smart playlist scoped to
// one board type, which is all the card needs to know.
//
// Its own query key, on purpose. `useSmartPlaylist` keys on
// `['smartPlaylist', type, userId, boardUuid ?? 'all']` and the liked list
// screen reads the unscoped 'all' entry, so reusing that key with a board
// filter would hand the screen a one-row page.

import { useQuery } from '@tanstack/react-query';
import {
  GET_SMART_PLAYLIST,
  type GetSmartPlaylistInput,
  type GetSmartPlaylistQueryResponse,
} from '@boardsesh/graphql/operations/playlists';
import { getHttpClient } from '../graphql/client';

/** Prefix for every "has saved climbs" read, so a heart can invalidate them all. */
export const HAS_SAVED_CLIMBS_QUERY_KEY = ['hasSavedClimbsOnBoard'] as const;

type UseHasSavedClimbsOnBoardOptions = {
  /** The signed-in account, or null while it is unknown. */
  userId: string | null;
  /** The active board's type (`kilter`, `tension`, ...), or null with no board. */
  boardType: string | null;
};

/**
 * True once the server has answered "at least one". False while loading, on an
 * error and offline: the card is an invitation, so not knowing means not
 * showing.
 */
export function useHasSavedClimbsOnBoard({ userId, boardType }: UseHasSavedClimbsOnBoardOptions): boolean {
  const { data: hasSavedClimbs } = useQuery({
    queryKey: [...HAS_SAVED_CLIMBS_QUERY_KEY, userId, boardType],
    queryFn: async ({ signal }) => {
      // Unreachable while `enabled` below holds; it narrows the two for the input.
      if (!userId || !boardType) return false;
      const input: GetSmartPlaylistInput = {
        type: 'LIKED_CLIMBS',
        userId,
        boardName: boardType,
        page: 0,
        pageSize: 1,
      };
      const response = await getHttpClient().request<GetSmartPlaylistQueryResponse, { input: GetSmartPlaylistInput }>({
        document: GET_SMART_PLAYLIST,
        variables: { input },
        signal,
      });
      return response.smartPlaylist.climbs.length > 0;
    },
    enabled: !!userId && !!boardType,
    staleTime: 5 * 60 * 1000,
  });
  return hasSavedClimbs === true;
}
