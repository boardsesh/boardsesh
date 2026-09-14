// Every board linked to one gym, for the board switcher.
//
// Lives in its own module rather than in the `hooks` barrel because it needs a
// unit test and that barrel can't be imported under Vitest (it statically
// reaches react-native's Flow source; see the note above `fetchAllMyBoards`,
// which was split out for the same reason). Re-exported from the barrel so
// callers keep one import path.

import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GET_GYM_BOARDS_FOR_SWITCHER,
  type GetGymBoardsForSwitcherQueryResponse,
} from '@boardsesh/graphql/operations/gyms';
import { getHttpClient } from '../client';
import type { GetMyBoardsQueryResponse } from '../operations';
import { gymBoardsQueryKey, myBoardsQueryKey } from '../query-keys';

/**
 * A gym's board roster only changes when an admin links or unlinks a wall, which
 * is close to never. Refetching on every sheet open would spend the resolver's
 * budget on an answer that hasn't moved.
 */
const GYM_BOARDS_STALE_TIME_MS = 5 * 60 * 1000;

/**
 * Keep the list for a day after the last reader leaves. `gymBoards` is rate
 * limited to 30 requests/minute and shares that bucket with the board-presence
 * family (`boardNowPlaying`/`boardPresenceStats`/`boardConnection`) the same
 * screens poll — an evicted roster re-fetched on every switcher open would
 * starve the presence reads the switcher's own rows render.
 */
const GYM_BOARDS_GC_TIME_MS = 24 * 60 * 60 * 1000;

/**
 * The gym's boards from the roster the user already has cached, so a switcher
 * opened offline paints the walls the app knows about instead of a spinner that
 * never resolves.
 *
 * Deliberately `undefined` rather than an empty list when nothing matches: an
 * empty placeholder renders "no boards at this gym", which is a claim about the
 * gym, not about the cache. It also stays `placeholderData` rather than
 * `initialData` — this is one user's own boards, never the gym's full roster, so
 * it must never be written to the cache as if the server had answered it.
 */
function boardsAtGymFromRoster(
  roster: GetMyBoardsQueryResponse | undefined,
  gymUuid: string | null,
): GetGymBoardsForSwitcherQueryResponse | undefined {
  if (!roster || gymUuid == null) return undefined;
  const boardsAtGym = roster.myBoards.boards.filter((board) => board.gymUuid === gymUuid);
  return boardsAtGym.length > 0 ? { gymBoards: boardsAtGym } : undefined;
}

/**
 * The boards a gym has linked, ordered by the server (name, then age, then
 * uuid — a stable order so a row can't move between refetches under a tapping
 * finger). Disabled until a gym uuid resolves, so the switcher can render while
 * the active board's gym is still loading.
 *
 * The plain HTTP client, not `offlineAwareRequest`: that router is a closed
 * registry of climb and grade documents backed by local SQLite tables, and a
 * gym's boards have no such table. The cached-roster placeholder above is this
 * query's offline story instead.
 */
export function useGymBoards(gymUuid: string | null) {
  const queryClient = useQueryClient();
  // Read rather than subscribe: the roster only matters for the first paint, and
  // `useMyBoards` already re-renders the surfaces that care when it changes.
  const cachedRoster = queryClient.getQueryData<GetMyBoardsQueryResponse>(myBoardsQueryKey());
  // Memoised so the placeholder keeps one identity across renders — a fresh
  // object each time reads as new data to React Query and re-runs `select`.
  const placeholderBoards = useMemo(() => boardsAtGymFromRoster(cachedRoster, gymUuid), [cachedRoster, gymUuid]);

  return useQuery({
    queryKey: gymBoardsQueryKey(gymUuid),
    queryFn: () =>
      getHttpClient().request<GetGymBoardsForSwitcherQueryResponse>(GET_GYM_BOARDS_FOR_SWITCHER, { gymUuid }),
    select: (data) => data.gymBoards,
    enabled: gymUuid != null,
    staleTime: GYM_BOARDS_STALE_TIME_MS,
    gcTime: GYM_BOARDS_GC_TIME_MS,
    placeholderData: placeholderBoards,
  });
}
