import { useCallback, useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { Climb } from '@boardsesh/shared-schema';
import {
  createPlaylistSuggestionSource,
  reanchorPlaylistSuggestionSource,
  type ClimbQueueItem,
  type PlaylistSuggestionSource,
} from '@boardsesh/queue';
import type { ActiveSubDrawer, NavigationState } from '@boardsesh/play-view';
import type { QueueActionsContextValue } from '../../providers/queue/queue-contexts';
import { climbToQueueItem, resolveCommittableQueueItem } from '../../lib/climb-to-queue-item';
import { toQueueClimb, toQueueClimbs } from '../../lib/climb-types';
import { getSetting } from '../../settings/hooks';
import { getSimilarClimbTapMode, getSwipeNavigationTarget } from './play-drawer-navigation';
import { shouldArmBusyWallConfirm, type WallLatchExit } from './wall-state';
import type { PlayDrawerOpenOptions, PlayDrawerOpenTarget, PlayDrawerProps } from './play-drawer-types';

type PreviewSelection = {
  drawerPreviewItem: ClimbQueueItem | null;
  drawerPreviewSuggestionSource: PlaylistSuggestionSource | null;
  setDrawerPreviewItem: Dispatch<SetStateAction<ClimbQueueItem | null>>;
  setDrawerPreviewSuggestionSource: Dispatch<SetStateAction<PlaylistSuggestionSource | null>>;
  setDrawerPreviewIsWallClimb: Dispatch<SetStateAction<boolean>>;
  setSharedBrowseLatched: Dispatch<SetStateAction<boolean>>;
};
type SelectionChrome = {
  clearMirror: () => void;
  resetFavoriteOverride: () => void;
  setIsTickBarActive: Dispatch<SetStateAction<boolean>>;
  setActiveSubDrawer: Dispatch<SetStateAction<ActiveSubDrawer>>;
};
type SelectionNavigation = {
  navigationState: Pick<NavigationState, 'prevItem' | 'nextItem'>;
  lightOnSwipe: boolean;
  browseByDefault: boolean;
};
type CommitConfirmation = {
  busyWallConfirmArmed: boolean;
  browseLatchActive: boolean;
  wallClimbUuid: string | null;
  displayedClimbUuid: string | undefined;
  wallUuidAtLatchStartRef: RefObject<string | null>;
  setBusyWallConfirmArmed: Dispatch<SetStateAction<boolean>>;
  markLatchExit: (exit: WallLatchExit) => void;
};
/** The similar-climbs strip as a track: the boards it is keyed to, and its name. */
type SimilarClimbsTrack = {
  /** The board the shown climb is drawn on. A preview walks the strip on this board. */
  boardKey: string;
  /**
   * The climber's stored active board. A committed tap keys the track here,
   * the board the queue checks a track against: an upsized climb, or a tick
   * from another size of the layout, is drawn on a board that is not the
   * active one, and a track keyed to that board would go dormant at once.
   * The queue drops strip climbs that do not fit the active board.
   */
  committedBoardKey: string;
  label: string;
};
/**
 * The #4979 hold (docs/current-climb-outside-queue.md, section 6), as the
 * selection controller needs it: which queue item the hold keeps dark, and the
 * held climb's Put on the wall.
 */
type HeldClimbSelection = {
  /** The queue item the hold keeps dark, or null while nothing is held. */
  heldQueueItemUuid: string | null;
  /** Put on the wall for the held climb: releases the hold and lights the board. */
  putHeldClimbOnWall: () => void;
};
type PlaySelectionInputs = {
  openTarget: PlayDrawerOpenTarget | null;
  viewer: NonNullable<PlayDrawerProps['viewer']>;
  showBoardMismatch: boolean;
  preview: PreviewSelection;
  queue: Pick<QueueActionsContextValue, 'setCurrentClimb' | 'previousClimb' | 'nextClimb'> & {
    currentClimbQueueItem: ClimbQueueItem | null;
  };
  similarTrack: SimilarClimbsTrack;
  navigation: SelectionNavigation;
  chrome: SelectionChrome;
  confirmation: CommitConfirmation;
  hold: HeldClimbSelection;
};

type SwipeSelectionInputs = Pick<
  PreviewSelection,
  'drawerPreviewItem' | 'drawerPreviewSuggestionSource' | 'setDrawerPreviewItem' | 'setDrawerPreviewIsWallClimb'
> &
  Pick<SelectionNavigation, 'lightOnSwipe' | 'browseByDefault'> & {
    targetItem: ClimbQueueItem | null;
    navigateQueue: () => void;
    clearMirror: () => void;
  };

/** One swipe intent, with independent callback identities for next and previous. */
function useSwipeSelection({
  drawerPreviewItem,
  drawerPreviewSuggestionSource,
  setDrawerPreviewItem,
  setDrawerPreviewIsWallClimb,
  lightOnSwipe,
  browseByDefault,
  targetItem,
  navigateQueue,
  clearMirror,
}: SwipeSelectionInputs) {
  return useCallback(() => {
    const previewTarget = getSwipeNavigationTarget({
      previewItem: drawerPreviewItem,
      previewSuggestionSource: drawerPreviewSuggestionSource,
      targetItem,
      lightOnSwipe,
      inSharedSession: browseByDefault,
    });
    if (previewTarget.viewOnly) {
      if (!previewTarget.targetItem) return;
      setDrawerPreviewItem(previewTarget.targetItem);
      // The displayed climb moved; the wall did not.
      setDrawerPreviewIsWallClimb(false);
      clearMirror();
      return;
    }
    setDrawerPreviewItem(null);
    setDrawerPreviewIsWallClimb(false);
    navigateQueue();
    clearMirror();
  }, [
    drawerPreviewSuggestionSource,
    drawerPreviewItem,
    targetItem,
    navigateQueue,
    lightOnSwipe,
    browseByDefault,
    setDrawerPreviewItem,
  ]);
}

/**
 * Selection intents share one preview/commit authority. Core owns the latch,
 * angle lifecycle, mirror sync and relay installation; this hook adds only the
 * host-target application effect at its original place in that lifecycle.
 */
export function usePlaySelectionController({
  openTarget,
  viewer,
  showBoardMismatch,
  preview: {
    drawerPreviewItem,
    drawerPreviewSuggestionSource,
    setDrawerPreviewItem,
    setDrawerPreviewSuggestionSource,
    setDrawerPreviewIsWallClimb,
    setSharedBrowseLatched,
  },
  queue: { currentClimbQueueItem, setCurrentClimb, previousClimb, nextClimb },
  similarTrack,
  navigation: { navigationState, lightOnSwipe, browseByDefault },
  chrome: { clearMirror, resetFavoriteOverride, setIsTickBarActive, setActiveSubDrawer },
  confirmation: {
    busyWallConfirmArmed,
    browseLatchActive,
    wallClimbUuid,
    displayedClimbUuid,
    wallUuidAtLatchStartRef,
    setBusyWallConfirmArmed,
    markLatchExit,
  },
  hold: { heldQueueItemUuid, putHeldClimbOnWall },
}: PlaySelectionInputs) {
  const openDrawer = useCallback(
    (selectedClimb: Climb, options?: PlayDrawerOpenOptions) => {
      const previewItem = options?.previewQueueItem ?? null;
      const playlistSuggestionSource = options?.playlistSuggestionSource ?? null;
      // Fresh active open (a notification, a deep link with activation intent,
      // the accessory bar's own current climb): the climb becomes current unless
      // it already is, so re-opening the current climb doesn't re-append it.
      // Lists don't come through here: since #6665 they play through the
      // activation hook, which commits (committedExternally) or previews. A fresh-uuid item on a genuinely new selection is
      // intentional (re-tapping starts a fresh pass — see queue setCurrentClimb).
      const isFreshActiveOpen = !previewItem && !options?.committedExternally;
      const isAlreadyCurrent = currentClimbQueueItem?.climb.uuid === selectedClimb.uuid;
      // ...except in a crew, where the same taps are a LOOK. Tapping a peer's
      // tick in the session feed, or a row in your own logbook, must not move the
      // shared queue and blank the climb someone is mid-attempt on — the deep-link
      // opener already reasons this way and passes `preview: true`. Gated here
      // rather than at each opener because the openers are many (notifications,
      // the climb route's hand-off, beta and moderation links) and every one of
      // them is the same gesture: show me this climb.
      //
      // Reads the LATCH, like every other gesture gate in this file, not the live
      // roster: a peer's phone dropping off the wifi for a moment must not turn
      // the tap the climber is already making into a queue write.
      const opensAsBrowse = isFreshActiveOpen && !isAlreadyCurrent && browseByDefault;
      // A view-only preview is shown without committing; the browse chrome keys
      // off this. Commit paths (committedExternally) and solo fresh active opens
      // leave it null so the drawer renders the real currentClimbQueueItem.
      const pinnedItem = previewItem ?? (opensAsBrowse ? climbToQueueItem(selectedClimb) : null);
      setDrawerPreviewItem(pinnedItem);
      setDrawerPreviewSuggestionSource(pinnedItem ? playlistSuggestionSource : null);
      setDrawerPreviewIsWallClimb(pinnedItem ? (options?.previewIsWallClimb ?? false) : false);
      // Opening a COMMITTED climb is the third latch exit: the queue-sheet tap,
      // a playlist activation and the accessory-of-current open all deliberately
      // put a climb up, so they land the drawer live rather than mid-browse. A
      // preview open leaves the latch alone — the arm effect picks it up if a
      // crew is present.
      if (!pinnedItem) setSharedBrowseLatched(false);
      clearMirror();
      // Drop any stale optimistic heart so the opened climb shows its real
      // (server) favorite status rather than a leftover from the last climb.
      resetFavoriteOverride();
      setIsTickBarActive(false);
      setActiveSubDrawer('none');
      if (isFreshActiveOpen && !isAlreadyCurrent && !opensAsBrowse) {
        setCurrentClimb(climbToQueueItem(selectedClimb), { playlistSuggestionSource: null });
      }
      // #4979 (section 6, decision A): the hold only keeps the automatic send on
      // connect dark. Picking the held climb again from a list (a search row, a
      // playlist, the logbook) is the climber asking for it, so it lights the
      // board the way the held climb's Put on the wall does. Those opens never
      // reach `setCurrentClimb` for a climb that is already current, so nothing
      // else would restart its clock. A `committedExternally` opener (the queue
      // sheet, the board sheet) already called `setCurrentClimb`, which restarts
      // the clock for the held uuid and lights it (`reopen`), so a second
      // write here would only send the climb twice. The accessory bar and the
      // mini player reopening the current climb (`reopensCurrent`) are not a
      // pick: the drawer shows the climb as it is, with Put on the wall and the
      // "Last on the wall" line. Previews never light the wall, held climb or not.
      if (
        !previewItem &&
        !options?.committedExternally &&
        !options?.reopensCurrent &&
        viewer !== 'anonymous' &&
        !showBoardMismatch &&
        heldQueueItemUuid !== null &&
        currentClimbQueueItem?.uuid === heldQueueItemUuid &&
        currentClimbQueueItem.climb.uuid === selectedClimb.uuid
      ) {
        putHeldClimbOnWall();
      }
    },
    [
      currentClimbQueueItem,
      setCurrentClimb,
      browseByDefault,
      setDrawerPreviewItem,
      setDrawerPreviewSuggestionSource,
      viewer,
      showBoardMismatch,
      heldQueueItemUuid,
      putHeldClimbOnWall,
    ],
  );

  // Apply the host's open target. A new target is a fresh object with a bumped
  // nonce, so its identity changes on every open request — this fires on mount
  // (first open) AND when the user re-taps a climb while the route is already up
  // (where `router.navigate('/play')` is a no-op). Defined AFTER the `[activeAngle]`
  // preview-clear effect so that on a board-override open (angle + target both
  // change) the preview this sets wins over that effect's clear. The ref keeps
  // the latest `openDrawer` without making it a dep (we key only on the target).
  const openDrawerRef = useRef(openDrawer);
  openDrawerRef.current = openDrawer;
  //
  // The host keeps the iPad pane's target after it lands, and every tab mounts
  // its own pane, so a pane that mounts later replays a target another pane
  // already applied. That replay is a look, not a pick: it must not light a
  // climb the #4979 hold kept dark hours after the tap, so it opens as
  // `reopensCurrent`.
  useEffect(() => {
    if (!openTarget) return;
    const replay = openTarget.claimFirstApply ? !openTarget.claimFirstApply() : false;
    openDrawerRef.current(
      openTarget.climb,
      replay ? { ...openTarget.options, reopensCurrent: true } : openTarget.options,
    );
  }, [openTarget]);

  const handlePrev = useSwipeSelection({
    drawerPreviewItem,
    drawerPreviewSuggestionSource,
    setDrawerPreviewItem,
    setDrawerPreviewIsWallClimb,
    lightOnSwipe,
    browseByDefault,
    targetItem: navigationState.prevItem,
    navigateQueue: previousClimb,
    clearMirror,
  });
  const handleNext = useSwipeSelection({
    drawerPreviewItem,
    drawerPreviewSuggestionSource,
    setDrawerPreviewItem,
    setDrawerPreviewIsWallClimb,
    lightOnSwipe,
    browseByDefault,
    targetItem: navigationState.nextItem,
    navigateQueue: nextClimb,
    clearMirror,
  });

  const handleSetActive = useCallback(() => {
    if (!drawerPreviewItem) return;
    // First tap on a wall someone else moved mid-browse: ask instead of taking
    // it. Only under the browse latch — that is what makes
    // `wallUuidAtLatchStartRef` mean "the wall as it was when you started
    // looking around"; without one there is no before-and-after to compare. And
    // only with a crew (`browseByDefault`: one is here, or was when the latch
    // armed): "Someone just lit X" needs a someone. A solo climber with
    // `lightOnSwipe` off is latched too, and the one way THEIR wall moves under
    // a preview is their own lightbulb tap — asking them to confirm over their
    // own climb would be the question asked of nobody.
    if (
      !busyWallConfirmArmed &&
      browseLatchActive &&
      browseByDefault &&
      shouldArmBusyWallConfirm({
        wallClimbUuid,
        wallUuidAtLatchStart: wallUuidAtLatchStartRef.current,
        displayedClimbUuid: displayedClimbUuid ?? null,
      })
    ) {
      setBusyWallConfirmArmed(true);
      // The question row speaks for itself when it mounts (PlayDrawerCommitBar).
      return;
    }
    markLatchExit('commit');
    setBusyWallConfirmArmed(false);
    // Launder the item first. Browsing a suggestion track walks onto transient
    // `playlist-peek:<uuid>` items, and `toQueueItemWireInput` sends `item.uuid`
    // verbatim — committing one straight would put a uuid on the wire that no
    // peer can reconcile against their queue. Same helper `nextClimb()` uses.
    const { item, converted } = resolveCommittableQueueItem(drawerPreviewItem);
    // Re-anchor the track on the climb actually going up. Browsing moves
    // `drawerPreviewItem` swipe by swipe but never touches the source, so after a
    // walk from A to Z the source still says the pass began at A — and committing
    // that verbatim would aim next/previous and the remaining count at A's
    // neighbours, several swipes behind where the climber is standing.
    //
    // No guard here for a climb the source does not contain. `drawerPreviewItem`
    // is by construction on this preview's own track, and the lineage rule lives
    // in `resolveNavigationSuggestionSource` — don't re-add a call-site check.
    //
    // A trackless look at a queued climb (a swipe off the committed climb with
    // Light on swipe off, or in a crew, walks the queue) is Next stepping into
    // Up next once it goes up (#6777): the provider keeps the committed list and
    // where it picks up when the climb is Up next on it, and clears it as
    // before otherwise. The preview never borrows the track (#5403); only the
    // commit, read against the committed climb, decides.
    const keepTrackIfUpNext = !drawerPreviewSuggestionSource && !converted;
    setCurrentClimb(item, {
      ...(keepTrackIfUpNext
        ? { keepTrackIfUpNext }
        : {
            playlistSuggestionSource: reanchorPlaylistSuggestionSource(drawerPreviewSuggestionSource, item.climb?.uuid),
          }),
      // Put on the wall: the deliberate commit at the end of a browse, told apart
      // from a plain list or queue pick so the crew ramp can be measured.
      trigger: 'put_on_wall',
    });
    setSharedBrowseLatched(false);
    setDrawerPreviewItem(null);
    setDrawerPreviewSuggestionSource(null);
    setDrawerPreviewIsWallClimb(false);
    // Mirroring is drawer-local per displayed climb and every other navigation
    // resets it (see `handleBackToLive`). The commit has to as well: the
    // auto-sender lights the committed item's own `climb.mirrored`, so a mirror
    // toggled while previewing would leave the drawer showing the climb flipped
    // and the wall showing it straight.
    clearMirror();
  }, [
    drawerPreviewItem,
    drawerPreviewSuggestionSource,
    setDrawerPreviewItem,
    setDrawerPreviewSuggestionSource,
    setCurrentClimb,
    markLatchExit,
    busyWallConfirmArmed,
    browseLatchActive,
    browseByDefault,
    wallClimbUuid,
    displayedClimbUuid,
  ]);

  const commitDisplayedToWall = useCallback(() => {
    if (!drawerPreviewItem || showBoardMismatch) return;
    handleSetActive();
  }, [drawerPreviewItem, showBoardMismatch, handleSetActive]);

  /**
   * The end card's "Keep going with your queue" from a committed climb (#6664):
   * leave the list for the climb queued after the current one.
   *
   * It goes the way Next went before the list took over the swipe, so it is
   * bound by the same rules as a swipe: with Light on swipe off, or with a crew
   * here, it opens the queued climb as a preview and the wall stays put. Only
   * where a swipe would commit does it take the wall, exactly as a queue-sheet
   * tap does. Either way the list's track is left behind, so Next and Previous
   * walk the queue from there.
   */
  const continueIntoQueue = useCallback(
    (target: ClimbQueueItem) => {
      const landing = getSwipeNavigationTarget({
        previewItem: drawerPreviewItem,
        previewSuggestionSource: drawerPreviewSuggestionSource,
        targetItem: target,
        lightOnSwipe,
        inSharedSession: browseByDefault,
      });
      setDrawerPreviewSuggestionSource(null);
      setDrawerPreviewIsWallClimb(false);
      clearMirror();
      if (landing.viewOnly) {
        setDrawerPreviewItem(landing.targetItem);
        return;
      }
      setDrawerPreviewItem(null);
      setCurrentClimb(target, { playlistSuggestionSource: null });
    },
    [
      drawerPreviewItem,
      drawerPreviewSuggestionSource,
      lightOnSwipe,
      browseByDefault,
      setDrawerPreviewItem,
      setDrawerPreviewSuggestionSource,
      setDrawerPreviewIsWallClimb,
      setCurrentClimb,
      clearMirror,
    ],
  );

  /**
   * A tap on a similar climb plays from the similar-climbs strip (issue #6665),
   * like a row of any list: swipes walk the strip and stop at its end card.
   * It used to append the climb to the END of the queue and make it current,
   * which put everything Up next behind it as History.
   *
   * It is a preview, nothing written, when any of these hold:
   * - a signed-out reader (`getSimilarClimbTapMode`): there is no queue to
   *   write and `setCurrentClimb` would re-arm the BLE auto-sender;
   * - a crew is here (also `getSimilarClimbTapMode`): a look must not take
   *   their wall;
   * - the climber turned off Light the board when I tap a climb;
   * - the player is showing a climb from another board, whose similar climbs
   *   are on that board too and can't go up on this one. That used to be the
   *   queue add's cross-board prompt; there is no add any more.
   * Otherwise the climb goes up, inserted after the current one and flagged
   * `suggested` like every list play.
   *
   * The displayed climb is read from a ref at tap time, not listed as a dep:
   * it changes on every player move, and a fresh handler each time would
   * rebuild every memoized similar-climb row's press handler with it.
   */
  const displayedClimbUuidRef = useRef(displayedClimbUuid);
  displayedClimbUuidRef.current = displayedClimbUuid;
  const handleSimilarClimbPress = useCallback(
    (similarClimb: Climb, similarClimbs: Climb[] = []) => {
      const previewOnly =
        getSimilarClimbTapMode(viewer, { inSharedSession: browseByDefault }) === 'preview' ||
        showBoardMismatch ||
        !getSetting('lightOnClimbTap');
      const track = createPlaylistSuggestionSource({
        playlistUuid: `similar:${displayedClimbUuidRef.current ?? similarClimb.uuid}`,
        activatedClimb: toQueueClimb(similarClimb),
        climbs: toQueueClimbs(similarClimbs),
        boardKey: previewOnly ? similarTrack.boardKey : similarTrack.committedBoardKey,
        label: similarTrack.label,
      });
      clearMirror();
      setIsTickBarActive(false);
      if (previewOnly) {
        setDrawerPreviewItem(climbToQueueItem(similarClimb));
        setDrawerPreviewSuggestionSource(track);
        // A different climb is on screen now, so it is not the lit one.
        setDrawerPreviewIsWallClimb(false);
        return;
      }
      // Committed, so it's never a preview: clear any preview that was showing.
      // The favorite override is cleared by the climb-change effect.
      setDrawerPreviewItem(null);
      setDrawerPreviewSuggestionSource(null);
      setCurrentClimb(climbToQueueItem(similarClimb, { suggested: true }), { playlistSuggestionSource: track });
    },
    [
      setCurrentClimb,
      viewer,
      browseByDefault,
      showBoardMismatch,
      similarTrack,
      setDrawerPreviewItem,
      setDrawerPreviewSuggestionSource,
      setDrawerPreviewIsWallClimb,
      clearMirror,
      setIsTickBarActive,
    ],
  );

  return {
    handlePrev,
    handleNext,
    handleSetActive,
    handleSimilarClimbPress,
    commitDisplayedToWall,
    continueIntoQueue,
  };
}
