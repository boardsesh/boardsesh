import { useCallback, useMemo, type Dispatch, type SetStateAction } from 'react';
import {
  computeNavigationTargetsWithSuggestions,
  resolveTrackListClimbUuid,
  resolveTrackPosition,
} from '@boardsesh/play-view';
import { toBoardName } from '@boardsesh/board-config';
import { isClimbOnReachableBoard, type ClimbQueueItem, type PlaylistSuggestionSource } from '@boardsesh/queue';
import type { Climb } from '@boardsesh/shared-schema';
import {
  useIsSharedSession,
  usePlaylistSuggestionSource,
  useQueueActions,
  useQueueData,
} from '../../providers/queue-provider';
import { useReachableBoardKeys } from '../../providers/queue/use-reachable-board-keys';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { hapticSelection } from '../../lib/haptics';
import { canLoadMoreOfTrack } from '../../lib/playlists/track-pager';
import { useSetting } from '../../settings/hooks';
import { getSwipeNavigationTarget } from '../play-drawer/play-drawer-navigation';
import { useTrackPaging } from '../play-drawer/use-track-paging';

export type MiniPlayerNavigation = {
  canPrevious: boolean;
  canNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
};

/**
 * ⏮ and ⏭ on the MiniPlayer (#6940), with the player closed.
 *
 * They move the way a swipe in the player would from the climb on the wall:
 * - Solo, with Light on swipe on: the queue's own `previousClimb` / `nextClimb`,
 *   the walk the player, the rest timer and the workout runner all make (Up next
 *   first, then the list). The board lights the new climb.
 * - In a crew, or with Light on swipe off: the player opens on that climb as a
 *   preview, so one tap never moves anybody's wall (`getSwipeNavigationTarget`).
 * - At the end of a list, Next opens the player on the climb, where Next opens
 *   the list's end card ("Keep going with your queue"): that choice needs the
 *   card, which the bar has no room for.
 *
 * Where there is nothing to move to (the first climb, a page still loading) the
 * button reads disabled and keeps its slot. {@link MiniPlayerTrackPager} keeps
 * a long list paging while the player is closed.
 */
export function useMiniPlayerNavigation(): MiniPlayerNavigation {
  const { nextClimb, previousClimb } = useQueueActions();
  const { queue, currentClimbQueueItem, historyCount } = useQueueData();
  const playlistSuggestionSource = usePlaylistSuggestionSource();
  const inSharedSession = useIsSharedSession();
  const [lightOnSwipe] = useSetting('lightOnSwipe');
  const { openPlayDrawer } = useDrawerHost();
  const { data: activeBoard } = useActiveBoard();
  const reachableBoardKeys = useReachableBoardKeys(activeBoard);

  // The same targets the player's ⏮ ⏭ would offer from the climb on the wall.
  const { prevItem, nextItem, atTrackEnd } = useMemo(() => {
    const boardName = activeBoard ? toBoardName(activeBoard.boardType) : null;
    const activeConfig = activeBoard && boardName ? { boardName, layoutId: activeBoard.layoutId } : undefined;
    const isReachable =
      reachableBoardKeys.size === 0
        ? undefined
        : (climb: { boardType?: string | null; layoutId?: number | null }) =>
            isClimbOnReachableBoard(climb, reachableBoardKeys);
    return computeNavigationTargetsWithSuggestions(
      queue,
      currentClimbQueueItem,
      playlistSuggestionSource,
      activeConfig,
      isReachable,
      undefined,
      historyCount,
    );
  }, [queue, currentClimbQueueItem, playlistSuggestionSource, activeBoard, reachableBoardKeys, historyCount]);
  // The list is done, not still loading: the player's end card takes it from here.
  const listEnded = nextItem === null && atTrackEnd && !canLoadMoreOfTrack(playlistSuggestionSource);

  const move = useCallback(
    (targetItem: ClimbQueueItem | null, navigateQueue: () => void) => {
      if (!targetItem) return;
      hapticSelection();
      const target = getSwipeNavigationTarget({
        previewItem: null,
        previewSuggestionSource: null,
        targetItem,
        lightOnSwipe,
        inSharedSession,
      });
      if (target.viewOnly) {
        if (!target.targetItem) return;
        openPlayDrawer(target.targetItem.climb as Climb, {
          previewQueueItem: target.targetItem,
          playlistSuggestionSource,
        });
        return;
      }
      navigateQueue();
    },
    [lightOnSwipe, inSharedSession, openPlayDrawer, playlistSuggestionSource],
  );
  const onPrevious = useCallback(() => move(prevItem, previousClimb), [move, prevItem, previousClimb]);
  const onNext = useCallback(() => {
    if (nextItem === null && listEnded && currentClimbQueueItem) {
      hapticSelection();
      // A reopen, as the bar's own tap: a #4979 hold stays.
      openPlayDrawer(currentClimbQueueItem.climb as Climb, { reopensCurrent: true });
      return;
    }
    move(nextItem, nextClimb);
  }, [nextItem, listEnded, currentClimbQueueItem, openPlayDrawer, move, nextClimb]);

  return { canPrevious: prevItem !== null, canNext: nextItem !== null || listEnded, onPrevious, onNext };
}

// The bar never holds a preview of its own: the track it pages is the committed one.
const keepPreviewSource: Dispatch<SetStateAction<PlaylistSuggestionSource | null>> = () => {};

/**
 * Pages the committed list as the climb on the wall nears the end of what is
 * loaded, so the bar's Next keeps going on a long list with the player closed,
 * as the rest timer's beat does (#6664). Mount it only while the player is
 * closed: the player pages its own track, and a second pager there would unpin
 * the loader of a preview the player is walking (`pinTrackLoader`).
 */
export function MiniPlayerTrackPager(): null {
  const { getQueueSnapshot, refreshPlaylistSuggestionSource } = useQueueActions();
  const { queue, currentClimbQueueItem } = useQueueData();
  const playlistSuggestionSource = usePlaylistSuggestionSource();
  const getCommittedSuggestionSource = useCallback(
    () => getQueueSnapshot().playlistSuggestionSource,
    [getQueueSnapshot],
  );
  // Measured from the list climb the walk is at, so a list keeps paging while a
  // queued climb plays Up next in the middle of it (#6777).
  const trackListClimbUuid = useMemo(
    () =>
      resolveTrackListClimbUuid(
        resolveTrackPosition(queue, currentClimbQueueItem, playlistSuggestionSource),
        playlistSuggestionSource,
      ),
    [queue, currentClimbQueueItem, playlistSuggestionSource],
  );
  useTrackPaging({
    source: playlistSuggestionSource,
    listClimbUuid: trackListClimbUuid,
    previewTrack: false,
    setPreviewSource: keepPreviewSource,
    getCommittedSource: getCommittedSuggestionSource,
    refreshCommittedSource: refreshPlaylistSuggestionSource,
  });
  return null;
}
