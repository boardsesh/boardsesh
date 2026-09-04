// The board-scoped "what to climb next" feed: page 0 of the active board's
// popular-by-ascents list.
//
// One feed, two readers. The queue sheet has shown it under the queue rows for
// a while (it is what tops the suggestion list up when no playlist is active),
// and since issue #5099 the queue provider re-anchors `next` onto it after a
// board switch, so a swipe keeps browsing the board the climber is standing at
// instead of walking the board they left. Both go through here so what `next`
// serves and what the sheet lists cannot drift apart — same input shape, same
// cache settings, therefore the same `['searchClimbs', input]` entry, so the
// second reader is free.
//
// `enabled` is load-bearing on both sides. The queue sheet stays mounted for its
// imperative present(), so an ungated feed would fetch for the whole session;
// the provider only ever arms it while a held suggestion source belongs to
// another board, which is a one-shot per board switch.

import { useMemo } from 'react';
import type { Climb } from '@boardsesh/queue';
import { toClimbSearchInput, DEFAULT_CLIMB_FILTER_STATE, type BoardSearchConfig } from '@boardsesh/climb-filters';
import { useSearchClimbs } from '../../lib/graphql/hooks';

/** How many climbs the continuation feed pulls. */
export const BOARD_CONTINUATION_PAGE_SIZE = 50;
// Keep the feed warm across sheet opens (and across a board switch and back) so
// reopening reuses the cached page instead of refiring a 50-item request.
const BOARD_CONTINUATION_STALE_MS = 5 * 60 * 1000;
const BOARD_CONTINUATION_GC_MS = 10 * 60 * 1000;

const NO_CLIMBS: Climb[] = [];

// Placeholder query input for a caller with no board yet. `enabled` is forced
// false in that case, so this is never fetched — it only keeps the query key
// well-typed without a conditional hook call.
const NO_BOARD_SEARCH_INPUT = toClimbSearchInput(
  DEFAULT_CLIMB_FILTER_STATE,
  { boardName: '', layoutId: 0, sizeId: 0, setIds: '', angle: 0 },
  { page: 0, pageSize: BOARD_CONTINUATION_PAGE_SIZE },
);

export type BoardContinuationFeed = {
  climbs: Climb[];
  /**
   * The query has come back — with climbs, with nothing, or with an error — so
   * an empty `climbs` can be read as "this board has no feed" rather than "not
   * yet". Callers that would otherwise announce a dead end need this, or they
   * announce it during the fetch and then contradict themselves. Trivially true
   * while disabled, since nothing is coming.
   */
  isSettled: boolean;
};

/**
 * Page 0 of `board`'s popular climbs, or an empty list while disabled / not yet
 * loaded. Pass `board: null` when no board is active.
 */
export function useBoardContinuationFeed(board: BoardSearchConfig | null, enabled: boolean): BoardContinuationFeed {
  // Keyed on the board's fields rather than the object so a caller that rebuilds
  // its board config every render doesn't churn the query input.
  const boardName = board?.boardName;
  const layoutId = board?.layoutId;
  const sizeId = board?.sizeId;
  const setIds = board?.setIds;
  const angle = board?.angle;
  const searchInput = useMemo(() => {
    if (boardName == null || layoutId == null || sizeId == null || setIds == null || angle == null) return null;
    return toClimbSearchInput(
      DEFAULT_CLIMB_FILTER_STATE,
      { boardName, layoutId, sizeId, setIds, angle },
      { page: 0, pageSize: BOARD_CONTINUATION_PAGE_SIZE },
    );
  }, [boardName, layoutId, sizeId, setIds, angle]);

  const isArmed = enabled && searchInput != null;
  const {
    data: searchResult,
    isSuccess,
    isError,
  } = useSearchClimbs(searchInput ?? NO_BOARD_SEARCH_INPUT, isArmed, {
    staleTime: BOARD_CONTINUATION_STALE_MS,
    gcTime: BOARD_CONTINUATION_GC_MS,
  });

  const isSettled = !isArmed || isSuccess || isError;
  return useMemo(() => ({ climbs: searchResult?.climbs ?? NO_CLIMBS, isSettled }), [searchResult, isSettled]);
}
