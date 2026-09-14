// The climb most recently lit on a board, for the board switcher's thumbnails.
//
// Own module rather than the hooks barrel for the same reason `use-gym-boards`
// is: that barrel can't be imported under Vitest (it statically reaches react
// native's Flow source).
//
// `boardRecentClimbs` is a plain QUERY. The live feed for a board is a
// subscription (`boardNowPlaying`), and opening one of those per row — for rows
// the climber may never look at — costs a socket each to answer a question a
// thumbnail asks once. The switcher is a disclosure, so this fires only when
// someone opens it, and only for the rows on screen.

import { useQuery } from '@tanstack/react-query';
import { BOARD_RECENT_CLIMBS } from '@boardsesh/graphql/operations/board-presence';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { getHttpClient } from '../client';

type BoardRecentClimbsResponse = { boardRecentClimbs: BoardPresenceClimb[] };

/**
 * Fresh for a minute. What is on a board changes when someone lights something,
 * which is often — but a thumbnail one climb behind is a thumbnail, not a lie,
 * and this shares the board-presence rate budget with the sheet's own content.
 */
const RECENT_CLIMB_STALE_TIME_MS = 60 * 1000;
const RECENT_CLIMB_GC_TIME_MS = 10 * 60 * 1000;

/**
 * The newest climb lit on `boardId`, or null when the board has no history (or
 * no board id — a board nobody has ever connected to has no presence row).
 */
export function useBoardRecentClimb(boardId: number | null | undefined) {
  const { data } = useQuery({
    queryKey: ['boardRecentClimb', boardId ?? null] as const,
    queryFn: () =>
      getHttpClient().request<BoardRecentClimbsResponse>(BOARD_RECENT_CLIMBS, { boardId: boardId as number }),
    select: (response) => response.boardRecentClimbs[0] ?? null,
    enabled: boardId != null,
    staleTime: RECENT_CLIMB_STALE_TIME_MS,
    gcTime: RECENT_CLIMB_GC_TIME_MS,
  });
  return data ?? null;
}
