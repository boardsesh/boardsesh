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
import { useSetting } from '../../settings/hooks';
import { getSwipeNavigationTarget } from '../play-drawer/play-drawer-navigation';
import { useTrackPaging } from '../play-drawer/use-track-paging';

export type MiniPlayerNavigation = {
  canPrevious: boolean;
  canNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
};

// The MiniPlayer never holds a preview of its own: the track it pages is the committed one.
const keepPreviewSource: Dispatch<SetStateAction<PlaylistSuggestionSource | null>> = () => {};

/**
 * ⏮ and ⏭ on the MiniPlayer (#6940), with the player closed.
 *
 * They move the way a swipe in the player would from the climb on the wall:
 * - Solo, with Light on swipe on: the queue's own `previousClimb` / `nextClimb`,
 *   the walk the player, the rest timer and the workout runner all make (Up next
 *   first, then the list). The board lights the new climb.
 * - In a crew, or with Light on swipe off: the player opens on that climb as a
 *   preview, so one tap never moves anybody's wall (`getSwipeNavigationTarget`).
 *
 * Where there is nothing to move to (the first climb, the end of the list, a
 * page still loading) the button reads disabled and keeps its slot. A long list
 * keeps paging with the player closed, as the rest timer's does (#6664).
 */
export function useMiniPlayerNavigation(): MiniPlayerNavigation {
  const { nextClimb, previousClimb, getQueueSnapshot, refreshPlaylistSuggestionSource } = useQueueActions();
  const { queue, currentClimbQueueItem, historyCount } = useQueueData();
  const playlistSuggestionSource = usePlaylistSuggestionSource();
  const inSharedSession = useIsSharedSession();
  const [lightOnSwipe] = useSetting('lightOnSwipe');
  const { openPlayDrawer } = useDrawerHost();
  const { data: activeBoard } = useActiveBoard();
  const reachableBoardKeys = useReachableBoardKeys(activeBoard);

  const getCommittedSuggestionSource = useCallback(
    () => getQueueSnapshot().playlistSuggestionSource,
    [getQueueSnapshot],
  );
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

  // The same targets the player's ⏮ ⏭ would offer from the climb on the wall.
  const { prevItem, nextItem } = useMemo(() => {
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
  const onNext = useCallback(() => move(nextItem, nextClimb), [move, nextItem, nextClimb]);

  return { canPrevious: prevItem !== null, canNext: nextItem !== null, onPrevious, onNext };
}
