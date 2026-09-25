// Live sessions for Home's "Climbing now" rail and the board sheet's "Climbing
// here now" block.
//
// Own module (not the `hooks` barrel) so it can be unit-tested: the barrel
// statically reaches react-native's Flow source under Vitest.

import { useCallback, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useIsFocused } from 'expo-router';
import {
  BOARD_LIVE_SESSIONS,
  FOLLOWED_LIVE_SESSIONS,
  type BoardLiveSessionsResponse,
  type BoardLiveSessionsVariables,
  type FollowedLiveSessionsResponse,
  type FollowedLiveSessionsVariables,
} from '@boardsesh/graphql/operations/live-sessions';
import type { LiveSession } from '@boardsesh/shared-schema';
import { getHttpClient } from '../client';
import { boardLiveSessionsQueryKey, followedLiveSessionsQueryKey } from '../query-keys';
import { useIsOffline } from '../../../hooks/use-is-offline';
import {
  orderLiveCards,
  toLiveCardModel,
  type LiveCardModel,
} from '../../../components/live-sessions/live-session-model';

export const LIVE_SESSIONS_STALE_TIME_MS = 30 * 1000;
export const LIVE_SESSIONS_REFETCH_INTERVAL_MS = 60 * 1000;
/** A rail, not a directory: past a dozen cards nobody is swiping. */
export const FOLLOWED_LIVE_SESSIONS_LIMIT = 12;

/**
 * Poll only while someone can see the result. Tabs stay mounted, so without the
 * focus gate a Home the climber left an hour ago would keep polling; offline, a
 * paused query would just queue retries.
 */
export function liveSessionsRefetchInterval(visible: boolean, isOffline: boolean): number | false {
  return visible && !isOffline ? LIVE_SESSIONS_REFETCH_INTERVAL_MS : false;
}

/**
 * Map rows to primitive card models in stable order. The order ref lives with
 * the hook instance; React Query's structural sharing then hands back the same
 * card objects for unchanged sessions, so memoised cards skip the re-render.
 */
function useStableCardSelect() {
  const orderRef = useRef<readonly string[]>([]);
  return useCallback((sessions: LiveSession[]): LiveCardModel[] => {
    const ordered = orderLiveCards(orderRef.current, sessions.map(toLiveCardModel));
    orderRef.current = ordered.map((card) => card.sessionId);
    return ordered;
  }, []);
}

/**
 * Sessions from people and boards the viewer follows. `boardUuid` adds the
 * Home-selected board (gym mode only; crew mode passes null). Requires auth.
 */
export function useFollowedLiveSessions(boardUuid: string | null, enabled: boolean) {
  const isFocused = useIsFocused();
  const isOffline = useIsOffline();
  const selectCards = useStableCardSelect();
  const select = useCallback(
    (response: FollowedLiveSessionsResponse) => selectCards(response.followedLiveSessions),
    [selectCards],
  );

  return useQuery({
    queryKey: followedLiveSessionsQueryKey(boardUuid),
    queryFn: () =>
      getHttpClient().request<FollowedLiveSessionsResponse, FollowedLiveSessionsVariables>(FOLLOWED_LIVE_SESSIONS, {
        boardUuid,
        limit: FOLLOWED_LIVE_SESSIONS_LIMIT,
      }),
    select,
    // Focus is part of `enabled`, not just the poll: tabs stay mounted, and a
    // refetchInterval flipping false→60s on refocus waits a full minute before
    // its first fetch, so ended sessions would still read "Live". Re-enabling a
    // query with stale data refetches at once, and the cached cards stay on
    // screen meanwhile.
    enabled: enabled && isFocused,
    staleTime: LIVE_SESSIONS_STALE_TIME_MS,
    refetchInterval: liveSessionsRefetchInterval(isFocused, isOffline),
  });
}

/**
 * Sessions on one board, for the board sheet. The sheet lives outside the tab
 * navigator (no focus to read), but it unmounts its content when dismissed, so
 * "mounted and enabled" is already "visible".
 */
export function useBoardLiveSessions(boardId: number | null, enabled: boolean) {
  const isOffline = useIsOffline();
  const selectCards = useStableCardSelect();
  const select = useCallback(
    (response: BoardLiveSessionsResponse) => selectCards(response.boardLiveSessions),
    [selectCards],
  );
  const active = enabled && boardId != null;

  return useQuery({
    queryKey: boardLiveSessionsQueryKey(boardId),
    queryFn: () => {
      if (boardId == null) throw new Error('Cannot load live sessions without a board id.');
      return getHttpClient().request<BoardLiveSessionsResponse, BoardLiveSessionsVariables>(BOARD_LIVE_SESSIONS, {
        boardId,
      });
    },
    select,
    enabled: active,
    staleTime: LIVE_SESSIONS_STALE_TIME_MS,
    refetchInterval: liveSessionsRefetchInterval(active, isOffline),
  });
}
