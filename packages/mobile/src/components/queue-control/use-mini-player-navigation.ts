import { useCallback, useMemo, type Dispatch, type SetStateAction } from 'react';
import {
  computeNavigationTargetsWithSuggestions,
  resolveNavigationSuggestionSource,
  resolvePreviewStepSource,
  resolveStepTrack,
  resolveTrackListClimbUuid,
  resolveTrackPosition,
  stepCrossesIntoList,
} from '@boardsesh/play-view';
import { toBoardName } from '@boardsesh/board-config';
import {
  isClimbOnReachableBoard,
  type ClimbQueueItem,
  type PlaylistSuggestionSource,
  type PlaylistTrackResume,
} from '@boardsesh/queue';
import type { Climb } from '@boardsesh/shared-schema';
import type { QueueNavigationDirection, QueueNavigationWalk } from '@boardsesh/analytics';
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
import { trackQueueNavigation } from '../../lib/queue-navigation-analytics';
import { canLoadMoreOfTrack } from '../../lib/playlists/track-pager';
import { useSetting } from '../../settings/hooks';
import { getSwipeNavigationTarget, getViewOnlyPreviewNavigationTarget } from '../play-drawer/play-drawer-navigation';
import { useDrivingWall } from '../play-drawer/use-climb-change-lights';
import { drivingAtPick } from '../play-drawer/drive-mode-store';
import { useTrackPaging } from '../play-drawer/use-track-paging';
import { resolvePreviewStepCommit } from '../play-drawer/preview-step-commit';
import { countUpNext } from '../play-drawer/track-end';
import { resolvePickBoard } from './pick-board';
import { barOpenOptions, useBarClimb } from './use-bar-climb';
import { miniPlayerStepWalk, type MiniPlayerStepWalk } from './mini-player-step-label';

export type MiniPlayerNavigation = {
  canPrevious: boolean;
  canNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  previousWalk: MiniPlayerStepWalk;
  nextWalk: MiniPlayerStepWalk;
};

/**
 * ⏮ and ⏭ on the MiniPlayer (#6940), with the player closed.
 *
 * They move the way a swipe in the player would from the climb on the wall:
 * - Driving the wall (#7113: a swipe, Put on board, or Always drive the wall):
 *   the queue's own `previousClimb` / `nextClimb`, the walk the player, the
 *   rest timer and the workout runner all make (Up next first, then the list).
 *   The board lights the new climb, in a crew too.
 * - Outside a drive, solo or in a crew, or after a press on "You are driving
 *   the wall" stopped it: the player opens on that climb as a preview, so one
 *   tap never moves anybody's wall (`useDrivingWall`, the player's own rule).
 *   The preview carries the list the climb on the wall is on, with the step's
 *   place in Up next (#7227), so the player's swipes go on from there.
 * - At the end of a list, Next opens the player on the climb, where Next opens
 *   the list's end card ("Keep going with your queue"): that choice needs the
 *   card, which the bar has no room for.
 *
 * Where there is nothing to move to (the first climb, a page still loading) the
 * button reads disabled and keeps its slot.
 *
 * While the bar shows the climber's last pick (owner decision A) they step
 * from the PICK, along its own list, by the player's swipe rules for a preview
 * (`getSwipeNavigationTarget`): a step that stays a look opens the player on
 * the neighbour as a preview with the pick's list and its place in Up next; a
 * step that lights puts the neighbour up the way the player's swipe does
 * (`resolvePreviewStepCommit`), and the queue's new current takes the bar. At
 * the end of the pick's loaded list, Next opens the pick in the player, which
 * pages the list or shows its end card.
 *
 * Each step that moves the wall or opens a preview fires `Queue Navigation`
 * with `surface: 'mini_player'`, and which walk it took. The end-of-list open
 * does not: it changes no climb. {@link MiniPlayerTrackPager} keeps
 * a long list paging while the player is closed.
 *
 * Each button also says, to a screen reader only, which walk it takes
 * (`previousWalk` / `nextWalk`, worded by `describeMiniPlayerStep`).
 */
export function useMiniPlayerNavigation(): MiniPlayerNavigation {
  const { nextClimb, previousClimb, setCurrentClimb } = useQueueActions();
  const { queue, currentClimbQueueItem, historyCount } = useQueueData();
  const playlistSuggestionSource = usePlaylistSuggestionSource();
  // The climber's last pick on the bar, or null while it shows the queue's current.
  const { pick } = useBarClimb();
  // For Queue Navigation: the session, and Always drive the wall.
  const inSharedSession = useIsSharedSession();
  const [alwaysDrive] = useSetting('alwaysDrive');
  // Driving the wall (#7113): every step lights it, in a crew too.
  const driving = useDrivingWall();
  const { openPlayDrawer, boardConfig } = useDrawerHost();
  const { data: activeBoard } = useActiveBoard();
  const reachableBoardKeys = useReachableBoardKeys(activeBoard);

  // The walk starts from the pick, along its list, as the player's walk from a
  // preview does; otherwise from the climb on the wall, along the committed list.
  const stepFrom = pick ? pick.item : currentClimbQueueItem;
  // The entry a step leaves: a step from Up next back onto the list records it
  // on the detour, for Previous to retrace from (#7227).
  const stepFromUuid = stepFrom?.uuid;
  const stepSource = useMemo(
    () =>
      pick
        ? resolveNavigationSuggestionSource({
            previewItem: pick.item,
            previewSource: pick.suggestionSource,
            committedItem: currentClimbQueueItem,
            committedSource: playlistSuggestionSource,
          })
        : playlistSuggestionSource,
    [pick, currentClimbQueueItem, playlistSuggestionSource],
  );
  // A pick on another board: driving leaves its steps previews, as in the
  // player (`previewOnOtherBoard`), the board it was opened on included.
  const pickOnOtherBoard = useMemo(() => {
    if (!pick) return false;
    const { boardMismatch, climbBoardMismatch } = resolvePickBoard(pick, boardConfig);
    return boardMismatch || climbBoardMismatch;
  }, [pick, boardConfig]);

  // The same targets the player's ⏮ ⏭ would offer from the climb it shows.
  const { prevItem, nextItem, atTrackEnd, prevTrackResume, nextTrackResume } = useMemo(() => {
    const boardName = activeBoard ? toBoardName(activeBoard.boardType) : null;
    const activeConfig = activeBoard && boardName ? { boardName, layoutId: activeBoard.layoutId } : undefined;
    const isReachable =
      reachableBoardKeys.size === 0
        ? undefined
        : (climb: { boardType?: string | null; layoutId?: number | null }) =>
            isClimbOnReachableBoard(climb, reachableBoardKeys);
    return computeNavigationTargetsWithSuggestions(
      queue,
      stepFrom,
      stepSource,
      activeConfig,
      isReachable,
      undefined,
      historyCount,
    );
  }, [queue, stepFrom, stepSource, activeBoard, reachableBoardKeys, historyCount]);
  // The list is done, not still loading: the player's end card takes it from
  // here. A pick's list is paged only by the player, so its loaded end hands
  // over too: the player loads the rest, or shows the end card.
  const listEnded = nextItem === null && atTrackEnd && (pick !== null || !canLoadMoreOfTrack(stepSource));

  // Which walk each step takes, read off the step's own place on the list, as
  // the player's signposts read it.
  const stepPosition = useMemo(() => resolveTrackPosition(queue, stepFrom, stepSource), [queue, stepFrom, stepSource]);
  const nextTrack = resolveStepTrack(stepPosition, nextTrackResume);
  const previousTrack = resolveStepTrack(stepPosition, prevTrackResume);
  const nextCrosses = stepCrossesIntoList(stepPosition, nextTrackResume);
  const previousCrosses = stepCrossesIntoList(stepPosition, prevTrackResume);
  const listName = stepSource?.label;
  const nextWalk = useMemo(
    () => (nextItem === null ? null : miniPlayerStepWalk(nextTrack, listName)),
    [nextItem, nextTrack, listName],
  );
  const previousWalk = useMemo(
    () => (prevItem === null ? null : miniPlayerStepWalk(previousTrack, listName)),
    [prevItem, previousTrack, listName],
  );
  // Up next as the player counts it, for the event's bucket: after the queue's
  // Now, or from the History line with nothing current.
  const currentUuid = currentClimbQueueItem?.uuid;
  const upNextCount = useMemo(
    () => countUpNext(queue, currentUuid ? queue.findIndex(({ uuid }) => uuid === currentUuid) : -1, historyCount),
    [queue, currentUuid, historyCount],
  );
  const from = pick ? 'preview' : 'current';

  const boardType = activeBoard?.boardType;
  const layoutId = activeBoard?.layoutId;
  const move = useCallback(
    (
      targetItem: ClimbQueueItem | null,
      trackResume: PlaylistTrackResume | null | undefined,
      navigateQueue: () => void,
      direction: QueueNavigationDirection,
      walk: QueueNavigationWalk,
    ) => {
      if (!targetItem) return;
      hapticSelection();
      // A keep-lighting window past its end lights nothing, even before the
      // watcher has tidied it (#7038).
      const lights = drivingAtPick(driving);
      // From a pick: the player's own rule for a swipe off a preview.
      const target = pick
        ? getSwipeNavigationTarget({
            previewItem: pick.item,
            previewSuggestionSource: pick.suggestionSource,
            targetItem,
            driving: lights,
            previewOnOtherBoard: pickOnOtherBoard,
          })
        : getViewOnlyPreviewNavigationTarget({
            previewItem: null,
            previewSuggestionSource: null,
            targetItem,
            forceViewOnly: !lights,
          });
      const trackStep = (outcome: 'moved' | 'preview') =>
        trackQueueNavigation({
          direction,
          method: 'button',
          surface: 'mini_player',
          outcome,
          inSharedSession,
          alwaysDrive,
          driving: lights,
          boardType,
          layoutId,
          walk,
        });
      if (target.viewOnly) {
        if (!target.targetItem) return;
        openPlayDrawer(target.targetItem.climb as Climb, {
          previewQueueItem: target.targetItem,
          // The step keeps the list it walked (the pick's own, or the one the
          // climb on the wall is on) with its place in Up next, as the player's
          // view-only swipe does (#7227), so the player's swipes go on through
          // Up next and down the list. A step off the climb on the wall starts
          // a look, and its list says so (`offWall`); a pick's list stays as
          // the pick left it. A pick keeps the board it was drawn on.
          playlistSuggestionSource: resolvePreviewStepSource(
            pick ? pick.suggestionSource : playlistSuggestionSource,
            trackResume,
            { steppedOffQueueItemUuid: stepFromUuid, offWall: !pick },
          ),
          ...(pick?.boardConfig ? { boardConfig: pick.boardConfig } : {}),
        });
        trackStep('preview');
        return;
      }
      if (pick) {
        // The neighbour goes up as the player's swipe off the preview puts it
        // up, with the pick's list and the step's place in Up next (#7227): a
        // pick a look left on the list's climb steps into Up next, and without
        // that place the list would go dormant.
        const { item, options } = resolvePreviewStepCommit({
          previewSuggestionSource: resolvePreviewStepSource(pick.suggestionSource, trackResume, {
            steppedOffQueueItemUuid: stepFromUuid,
          }),
          targetItem,
          direction,
        });
        setCurrentClimb(item, options);
        trackStep('moved');
        return;
      }
      navigateQueue();
      trackStep('moved');
    },
    [
      alwaysDrive,
      driving,
      inSharedSession,
      openPlayDrawer,
      playlistSuggestionSource,
      boardType,
      layoutId,
      pick,
      pickOnOtherBoard,
      setCurrentClimb,
      stepFromUuid,
    ],
  );
  const onPrevious = useCallback(
    () =>
      move(prevItem, prevTrackResume, previousClimb, 'previous', {
        track: previousTrack,
        from,
        upNextCount,
        crossed: previousCrosses,
      }),
    [move, prevItem, prevTrackResume, previousClimb, previousTrack, from, upNextCount, previousCrosses],
  );
  const onNext = useCallback(() => {
    if (nextItem === null && listEnded && stepFrom) {
      hapticSelection();
      // A reopen, as the bar's own tap: a #4979 hold stays, and a pick
      // reopens as its preview, with its list.
      openPlayDrawer(stepFrom.climb as Climb, barOpenOptions(pick));
      return;
    }
    move(nextItem, nextTrackResume, nextClimb, 'next', { track: nextTrack, from, upNextCount, crossed: nextCrosses });
  }, [
    nextItem,
    nextTrackResume,
    listEnded,
    stepFrom,
    pick,
    openPlayDrawer,
    move,
    nextClimb,
    nextTrack,
    from,
    upNextCount,
    nextCrosses,
  ]);

  return {
    canPrevious: prevItem !== null,
    canNext: nextItem !== null || listEnded,
    onPrevious,
    onNext,
    previousWalk,
    nextWalk,
  };
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
