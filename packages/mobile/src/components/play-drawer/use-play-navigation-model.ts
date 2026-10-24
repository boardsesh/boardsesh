import { useMemo } from 'react';
import type { Climb } from '@boardsesh/shared-schema';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import {
  computeNavigationTargetsWithSuggestions,
  countRemainingQueueItemsWithSuggestions,
  prepareQueueNavigation,
  findUpcomingQueueItemsWithSuggestions,
  resolveNavigationSuggestionSource,
  resolveTrackLabel,
  selectNextQueueItemWithSuggestions,
  type ReachableClimbPredicate,
} from '@boardsesh/play-view';
import { toBoardName } from '@boardsesh/board-config';
import { resolveClimbRenderBoard, sameRenderBoard } from '../../lib/boards/climb-render-board';
import { canLoadMoreOfTrack, trackForCounting } from '../../lib/playlists/track-pager';
import type { BoardConfig } from './play-drawer-types';
import { countUpNext, resolveListWalkUpNextBadge, resolveTrackEndCard } from './track-end';

/**
 * The frames a swipe peek may draw, or null when the neighbouring climb belongs
 * to a different board than the one currently on screen. Board art is one
 * picture: a peek is drawn over it, so a climb whose holds live on another wall
 * has nothing to show there.
 */
function peekFramesOnBoard(
  peek: Climb | null | undefined,
  activeBoardConfig: BoardConfig,
  renderBoardConfig: BoardConfig,
): string | null {
  if (!peek) return null;
  const resolved = resolveClimbRenderBoard(peek, activeBoardConfig);
  return sameRenderBoard(resolved?.boardConfig ?? activeBoardConfig, renderBoardConfig) ? peek.frames : null;
}

/**
 * How many climbs ahead of the displayed one get their board render warmed
 * while the drawer is open. Three covers a normal run of swipes without piling
 * up work: these renders only ever run when the renderer is idle, but each one
 * still costs a cached PNG on disk and a slot in the overlay index.
 */
const PREFETCH_AHEAD = 3;

/** Content-keyed to keep renderer warming stable across queue broadcasts. */
const PREFETCH_FRAMES_SEPARATOR = '\n';
const NO_PREFETCH_FRAMES: string[] = [];

type PlayNavigationInputs = {
  queue: ClimbQueueItem[];
  displayedQueueItem: ClimbQueueItem | null;
  displayedClimb: Climb | null | undefined;
  drawerPreviewItem: ClimbQueueItem | null;
  drawerPreviewSuggestionSource: PlaylistSuggestionSource | null;
  currentClimbQueueItem: ClimbQueueItem | null;
  playlistSuggestionSource: PlaylistSuggestionSource | null;
  activeBoardForNavigation: { boardType: string; layoutId: number } | null | undefined;
  boardConfig: BoardConfig;
  renderBoardConfig: BoardConfig;
  isReachableClimb: ReachableClimbPredicate | undefined;
  enhancementsReady: boolean;
};

/** Pure render-time derivations: provider reads and pager lifetimes stay in Core. */
export function usePlayNavigationModel({
  queue,
  displayedQueueItem,
  displayedClimb,
  drawerPreviewItem,
  drawerPreviewSuggestionSource,
  currentClimbQueueItem,
  playlistSuggestionSource,
  activeBoardForNavigation,
  boardConfig,
  renderBoardConfig,
  isReachableClimb,
  enhancementsReady,
}: PlayNavigationInputs) {
  const navigationSuggestionSource = useMemo(
    () =>
      resolveNavigationSuggestionSource({
        previewItem: drawerPreviewItem,
        previewSource: drawerPreviewSuggestionSource,
        committedItem: currentClimbQueueItem,
        committedSource: playlistSuggestionSource,
      }),
    [drawerPreviewItem, drawerPreviewSuggestionSource, currentClimbQueueItem, playlistSuggestionSource],
  );
  // Forward navigation skips queued climbs the wall can't draw (issue #5099), so
  // canNext, the header peek and "N left" agree with where a swipe actually lands.
  //
  // Read off the ACTIVE board, and never off `boardConfig` (or any render-board
  // config derived from the displayed climb). Two reasons, both load-bearing:
  //
  //  1. `boardConfig` is `boardConfigOverride ?? storedActiveBoardConfig`, so
  //     opening a Kilter climb from the board sheet while standing at a Tension
  //     board would scan the Tension queue against Kilter, mark every remaining
  //     climb incompatible and kill `canNext` — a dead swipe under an action bar
  //     still reading "N left".
  //  2. `nextClimb` in the queue provider filters against the active board. Any
  //     other board here makes the peek disagree with the landing.
  //
  // Whatever the drawer is DRAWING, the skip question is always "can the board
  // the climber is standing at light this?".
  const navigationBoardConfig = useMemo(() => {
    if (!activeBoardForNavigation) return undefined;
    const resolvedBoardName = toBoardName(activeBoardForNavigation.boardType);
    return resolvedBoardName
      ? { boardName: resolvedBoardName, layoutId: activeBoardForNavigation.layoutId }
      : undefined;
  }, [activeBoardForNavigation]);
  const preparedQueue = useMemo(() => prepareQueueNavigation(queue), [queue]);
  const navigationTargets = useMemo(
    () =>
      computeNavigationTargetsWithSuggestions(
        queue,
        displayedQueueItem,
        navigationSuggestionSource,
        navigationBoardConfig,
        isReachableClimb,
        preparedQueue,
      ),
    [queue, displayedQueueItem, navigationSuggestionSource, navigationBoardConfig, isReachableClimb, preparedQueue],
  );
  const remainingCount = useMemo(
    () =>
      enhancementsReady
        ? countRemainingQueueItemsWithSuggestions(
            queue,
            displayedQueueItem,
            navigationSuggestionSource,
            navigationBoardConfig,
            isReachableClimb,
            preparedQueue,
          )
        : 0,
    [
      enhancementsReady,
      queue,
      displayedQueueItem,
      navigationSuggestionSource,
      navigationBoardConfig,
      isReachableClimb,
      preparedQueue,
    ],
  );
  const navigationState = useMemo(
    () => ({ ...navigationTargets, remainingCount }),
    [navigationTargets, remainingCount],
  );

  // The neighbours' headers stay mounted beside the current one, like their
  // boards, so the title and grade being swiped towards are already there.
  const nextHeaderClimb = navigationState.canNext ? (navigationState.nextItem?.climb ?? null) : null;
  const previousHeaderClimb = navigationState.canPrevious ? (navigationState.prevItem?.climb ?? null) : null;

  // "Projects · 4 of 23" (issue #6664): the list the player is walking, read
  // off the RESOLVED track, so the name goes the moment swipes stop following
  // it. It sits in the top bar, which doesn't swipe, so the count changes on
  // landing and the neighbours need no label of their own.
  const displayedClimbUuid = displayedClimb?.uuid;
  // A track that can't load the rest of its list ends early, so it shows no count.
  const labelSource = useMemo(() => trackForCounting(navigationSuggestionSource), [navigationSuggestionSource]);
  const currentTrackLabel = useMemo(
    () => resolveTrackLabel(labelSource, displayedClimbUuid),
    [labelSource, displayedClimbUuid],
  );

  // Where the queue's Now sits: one Map read off the prepared queue, never a scan.
  const currentClimbQueueItemUuid = currentClimbQueueItem?.uuid;
  const committedQueueIndex = useMemo(
    () => (currentClimbQueueItemUuid ? (preparedQueue.firstIndexByUuid.get(currentClimbQueueItemUuid) ?? -1) : -1),
    [preparedQueue, currentClimbQueueItemUuid],
  );
  // The queue button's Up next count while a list is walked (#6238): the same
  // count the end card offers, so Up next stays in sight before the list ends.
  // Null when no list is walked.
  const listWalkUpNextCount = resolveListWalkUpNextBadge(
    currentTrackLabel,
    countUpNext(queue.length, committedQueueIndex),
  );

  // Past the list's last climb: the end card, and where "Keep going with your
  // queue" goes. Only worked out at the end of a list; everywhere else it is null
  // and costs nothing. Withheld while more of the list is on its way.
  const atTrackEnd = navigationState.atTrackEnd;
  // A preview goes back to Now only when there is one to go back to.
  const previewOverNow = drawerPreviewItem != null && currentClimbQueueItem != null;
  const trackEndCard = useMemo(() => {
    if (!atTrackEnd) return null;
    // From Now, or from the top of the queue without one. A Now that is not
    // in the queue walks nothing, and the card falls back to the first climb.
    const queueSuccessor = selectNextQueueItemWithSuggestions(
      queue,
      currentClimbQueueItem,
      null,
      navigationBoardConfig,
      isReachableClimb,
      preparedQueue,
    ).item;
    return resolveTrackEndCard({
      navigationState: { atTrackEnd },
      moreToLoad: canLoadMoreOfTrack(navigationSuggestionSource),
      trackLabel: currentTrackLabel,
      queue,
      committedQueueIndex,
      queueSuccessor,
      previewOverNow,
    });
  }, [
    atTrackEnd,
    committedQueueIndex,
    currentClimbQueueItem,
    preparedQueue,
    queue,
    navigationBoardConfig,
    isReachableClimb,
    navigationSuggestionSource,
    currentTrackLabel,
    previewOverNow,
  ]);
  const nextHeaderBoard = useMemo(
    () => resolveClimbRenderBoard(nextHeaderClimb, boardConfig)?.boardConfig ?? renderBoardConfig,
    [nextHeaderClimb, boardConfig, renderBoardConfig],
  );
  const previousHeaderBoard = useMemo(
    () => resolveClimbRenderBoard(previousHeaderClimb, boardConfig)?.boardConfig ?? renderBoardConfig,
    [previousHeaderClimb, boardConfig, renderBoardConfig],
  );
  // The swipe peeks paint the neighbouring climbs' holds under the CURRENT
  // board art. A neighbour from another board has no holds there, so it would
  // peek as an empty wall (or, worse, light unrelated holds that happen to share
  // ids). Withhold its frames and let the board swap on commit instead (#5099).
  const nextPeekFrames = useMemo(
    () => peekFramesOnBoard(navigationState.nextItem?.climb, boardConfig, renderBoardConfig),
    [navigationState.nextItem, boardConfig, renderBoardConfig],
  );
  const prevPeekFrames = useMemo(
    () => peekFramesOnBoard(navigationState.prevItem?.climb, boardConfig, renderBoardConfig),
    [navigationState.prevItem, boardConfig, renderBoardConfig],
  );

  // The climbs a few swipes ahead, warmed while the renderer is idle so getting
  // to them is a cache hit (#5187). Same board filter as the peeks: a climb on
  // another wall has nothing to draw here, and would warm a render the carousel
  // never asks for. The displayed climb is dropped (it is already on screen) and
  // duplicate frames collapse, since one render serves every climb that lights
  // the same holds.
  const displayedClimbFrames = displayedClimb?.frames;
  const upcomingPrefetchFramesKey = useMemo(() => {
    if (!enhancementsReady) return '';
    const upcomingItems = findUpcomingQueueItemsWithSuggestions(
      queue,
      displayedQueueItem,
      navigationSuggestionSource,
      PREFETCH_AHEAD,
      navigationBoardConfig,
      isReachableClimb,
      preparedQueue,
    );
    const framesToWarm = new Set<string>();
    for (const item of upcomingItems) {
      const frames = peekFramesOnBoard(item.climb, boardConfig, renderBoardConfig);
      if (!frames || frames === displayedClimbFrames || framesToWarm.has(frames)) continue;
      // A multi-frame route plays back frame by frame once it is current
      // (`playback.currentFrameString`), and its first accumulated frame is a
      // different cache key from the flattened union the catalog string would
      // warm. Nothing worth warming there; boulders are the 99.9% case anyway.
      if (frames.includes(',')) continue;
      framesToWarm.add(frames);
    }
    return [...framesToWarm].join(PREFETCH_FRAMES_SEPARATOR);
  }, [
    enhancementsReady,
    preparedQueue,
    isReachableClimb,
    queue,
    displayedQueueItem,
    navigationSuggestionSource,
    navigationBoardConfig,
    boardConfig,
    renderBoardConfig,
    displayedClimbFrames,
  ]);
  // Split back out of the joined key rather than memoized on the walk's inputs:
  // the queue gets a fresh array identity on every broadcast, and a new array
  // here would remount every warmed render for a list that hasn't changed.
  const upcomingPrefetchFrames = useMemo(
    () => (upcomingPrefetchFramesKey ? upcomingPrefetchFramesKey.split(PREFETCH_FRAMES_SEPARATOR) : NO_PREFETCH_FRAMES),
    [upcomingPrefetchFramesKey],
  );

  return {
    navigationSuggestionSource,
    navigationState,
    currentTrackLabel,
    trackEndCard,
    listWalkUpNextCount,
    nextHeaderClimb,
    previousHeaderClimb,
    nextHeaderBoard,
    previousHeaderBoard,
    nextPeekFrames,
    prevPeekFrames,
    upcomingPrefetchFrames,
  };
}
