import { useCallback, useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { Climb } from '@boardsesh/shared-schema';
import {
  createPlaylistSuggestionSource,
  reanchorPlaylistSuggestionSource,
  type ClimbQueueItem,
  type PlaylistSuggestionSource,
} from '@boardsesh/queue';
import type { ActiveSubDrawer, NavigationState } from '@boardsesh/play-view';
import type {
  QueueNavigationArtWait,
  QueueNavigationDirection,
  QueueNavigationMethod,
  QueueNavigationOutcome,
} from '@boardsesh/analytics';
import type { QueueActionsContextValue } from '../../providers/queue/queue-contexts';
import { climbToQueueItem, resolveCommittableQueueItem } from '../../lib/climb-to-queue-item';
import { toQueueClimb, toQueueClimbs } from '../../lib/climb-types';
import { getSimilarClimbTapMode, getSwipeNavigationTarget } from './play-drawer-navigation';
import { drivingAtPick } from './drive-mode-store';
import { shouldArmBusyWallConfirm, type WallLatchExit } from './wall-state';
import type { PlayDrawerOpenOptions, PlayDrawerOpenTarget, PlayDrawerProps } from './play-drawer-types';
import { resolvePreviewStepCommit } from './preview-step-commit';

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
  /** Put a preview's mirror flip back: the MiniPlayer reopening the last pick (`previewMirrored`). */
  restoreMirror: (climbUuid: string, mirrored: boolean) => void;
  setIsTickBarActive: Dispatch<SetStateAction<boolean>>;
  setActiveSubDrawer: Dispatch<SetStateAction<ActiveSubDrawer>>;
};
type SelectionNavigation = {
  navigationState: Pick<NavigationState, 'prevItem' | 'nextItem'>;
  /**
   * The list a step to `nextItem` or `prevItem` that only looks keeps walking
   * (`resolvePreviewStepSource`, #7227): the track navigation walks, with the
   * step's place in Up next, marked as a look's (`lookOffWall`) when the step
   * leaves the climb on the wall. Null when the walk has no list.
   */
  nextPreviewSource: PlaylistSuggestionSource | null;
  previousPreviewSource: PlaylistSuggestionSource | null;
  browseByDefault: boolean;
  /**
   * Driving the wall (#7113): a live drive on this phone's link (a swipe on the
   * wall button, Put on board, or Always drive the wall). Every change of climb
   * commits and lights, in a crew too, and the busy-wall question never asks
   * this climber. Outside a drive every change of climb is a preview.
   */
  driving: boolean;
  /** The preview on screen is a climb from another board: driving leaves it a preview. */
  previewOnOtherBoard: boolean;
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
/**
 * An open the player applied, as the last pick (`use-last-pick-writer.ts`)
 * and the bar's Put on board need it. `replay` is a pane that mounted later
 * showing a target another pane already applied: a look, never a new pick.
 */
export type AppliedPlayerOpen = {
  previewItem: ClimbQueueItem | null;
  suggestionSource: PlaylistSuggestionSource | null;
  commitOptions: PlayDrawerOpenOptions['previewCommitOptions'];
  mirrored: boolean;
  replay: boolean;
  /** The reopened pick's busy-wall snapshot (`previewLatchStart`), when it carried one. */
  latchStart: PlayDrawerOpenOptions['previewLatchStart'];
  /** The MiniPlayer's bulb asked for Put on board once this preview lands (never on a replay). */
  putOnBoard: boolean;
};

/** One step the climber took, for `Queue Navigation`; the caller adds the surface and the board. */
export type PlayNavigationStep = {
  direction: QueueNavigationDirection;
  method: QueueNavigationMethod;
  outcome: QueueNavigationOutcome;
  /** Only on a swipe that went before the climb's board had painted. */
  artWait?: QueueNavigationArtWait;
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
  /** Reports each Next / Previous that moved the wall or opened a preview. */
  onNavigationStep: (step: PlayNavigationStep) => void;
  /** Each open the player applied, for the last pick and the bar's Put on board. */
  onOpenApplied?: (applied: AppliedPlayerOpen) => void;
};

type SwipeSelectionInputs = PreviewSelection &
  Omit<SelectionNavigation, 'navigationState' | 'nextPreviewSource' | 'previousPreviewSource' | 'browseByDefault'> & {
    targetItem: ClimbQueueItem | null;
    /** The list the preview keeps walking when the step only looks. */
    previewSource: PlaylistSuggestionSource | null;
    navigateQueue: () => void;
    setCurrentClimb: PlaySelectionInputs['queue']['setCurrentClimb'];
    clearMirror: () => void;
    clearPreviewCommitOptions: () => void;
    direction: QueueNavigationDirection;
    onNavigationStep: (step: PlayNavigationStep) => void;
  };

type PreviewCommit = {
  queueItemUuid: string;
  options: NonNullable<PlayDrawerOpenOptions['previewCommitOptions']>;
};

/** The deferred commit an open carries for the slot it previews, or null. */
function previewCommitFor(
  previewItem: ClimbQueueItem | null | undefined,
  options: PlayDrawerOpenOptions | undefined,
): PreviewCommit | null {
  return previewItem && options?.previewCommitOptions
    ? { queueItemUuid: previewItem.uuid, options: options.previewCommitOptions }
    : null;
}

/**
 * One swipe intent, with independent callback identities for next and previous.
 * `method` says whether a button or a swipe asked for it, and `artWait` whether
 * a swipe went before its board had painted, for the analytics.
 */
function useSwipeSelection({
  drawerPreviewItem,
  drawerPreviewSuggestionSource,
  setDrawerPreviewItem,
  setDrawerPreviewSuggestionSource,
  setDrawerPreviewIsWallClimb,
  setSharedBrowseLatched,
  driving,
  previewOnOtherBoard,
  targetItem,
  previewSource,
  navigateQueue,
  setCurrentClimb,
  clearMirror,
  clearPreviewCommitOptions,
  direction,
  onNavigationStep,
}: SwipeSelectionInputs) {
  return useCallback(
    (method: QueueNavigationMethod, artWait?: QueueNavigationArtWait) => {
      const previewTarget = getSwipeNavigationTarget({
        previewItem: drawerPreviewItem,
        previewSuggestionSource: drawerPreviewSuggestionSource,
        targetItem,
        // A keep-lighting window past its end lights nothing (#7038).
        driving: drivingAtPick(driving),
        previewOnOtherBoard,
      });
      if (previewTarget.viewOnly) {
        if (!previewTarget.targetItem) return;
        clearPreviewCommitOptions();
        setDrawerPreviewItem(previewTarget.targetItem);
        // The look keeps the list this walk is on, with its place in Up next
        // (#7227). A step off the climb on the wall used to leave it with no
        // list, so it walked only the queue and stopped at its end, or one
        // climb past the wall's with Up next empty. A preview's own list stays
        // its own, and a preview opened without one gets none (#5403).
        setDrawerPreviewSuggestionSource(previewSource);
        // The displayed climb moved; the wall did not.
        setDrawerPreviewIsWallClimb(false);
        clearMirror();
        onNavigationStep({ direction, method, outcome: 'preview', artWait });
        return;
      }
      // Driving the wall from a preview that walks a list (#7113): the climb
      // that walk steps to goes up (the list's next climb, or, for a look off
      // the climb on the wall, an Up next climb on the way, #7227), with the
      // list as its track and the step's place in Up next. That place is on the
      // step's own source (`previewSource`), not the preview's: committing where
      // the look stands would drop it on a step into Up next, and the list would
      // go dormant. The queue's own next would leave the list. It is a step,
      // placed as `nextClimb` places one: a fresh copy at the Now slot, never a
      // climb pulled out of History.
      if (drawerPreviewItem && drawerPreviewSuggestionSource) {
        if (!targetItem) return;
        clearPreviewCommitOptions();
        const { item, options } = resolvePreviewStepCommit({
          previewSuggestionSource: previewSource ?? drawerPreviewSuggestionSource,
          targetItem,
          direction,
        });
        setCurrentClimb(item, options);
        setSharedBrowseLatched(false);
        setDrawerPreviewItem(null);
        setDrawerPreviewSuggestionSource(null);
        setDrawerPreviewIsWallClimb(false);
        clearMirror();
        onNavigationStep({ direction, method, outcome: 'moved', artWait });
        return;
      }
      // A trackless preview with a neighbour of its own: a queue slot (a
      // queue-sheet row, Replay from here) or a look walked along the queue.
      // The peek shows that neighbour, so it goes up, the way Put on board
      // commits a look; the queue's own next would step from the climb on the
      // wall instead. The slot's deferred commit options never follow a swipe.
      if (drawerPreviewItem && targetItem) {
        clearPreviewCommitOptions();
        const { item, options } = resolvePreviewStepCommit({ previewSuggestionSource: null, targetItem, direction });
        setCurrentClimb(item, options);
        setSharedBrowseLatched(false);
        setDrawerPreviewItem(null);
        setDrawerPreviewIsWallClimb(false);
        clearMirror();
        onNavigationStep({ direction, method, outcome: 'moved', artWait });
        return;
      }
      setDrawerPreviewItem(null);
      clearPreviewCommitOptions();
      setDrawerPreviewIsWallClimb(false);
      navigateQueue();
      clearMirror();
      // No target means the controls read disabled: nothing to count.
      if (targetItem) onNavigationStep({ direction, method, outcome: 'moved', artWait });
    },
    [
      drawerPreviewSuggestionSource,
      drawerPreviewItem,
      targetItem,
      previewSource,
      navigateQueue,
      setCurrentClimb,
      driving,
      previewOnOtherBoard,
      setDrawerPreviewItem,
      setDrawerPreviewSuggestionSource,
      setDrawerPreviewIsWallClimb,
      setSharedBrowseLatched,
      clearMirror,
      clearPreviewCommitOptions,
      direction,
      onNavigationStep,
    ],
  );
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
  navigation: {
    navigationState,
    nextPreviewSource,
    previousPreviewSource,
    browseByDefault,
    driving,
    previewOnOtherBoard,
  },
  chrome: { clearMirror, restoreMirror, setIsTickBarActive, setActiveSubDrawer },
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
  onNavigationStep,
  onOpenApplied,
}: PlaySelectionInputs) {
  // A queue/history pick can defer its exact commit behavior until the board
  // button is pressed. It belongs to this slot only and never follows a swipe.
  const previewCommitRef = useRef<PreviewCommit | null>(
    previewCommitFor(openTarget?.options?.previewQueueItem, openTarget?.options),
  );
  const previewCommitTargetRef = useRef(openTarget);
  if (previewCommitTargetRef.current !== openTarget) {
    previewCommitTargetRef.current = openTarget;
    previewCommitRef.current = previewCommitFor(openTarget?.options?.previewQueueItem, openTarget?.options);
  }
  const clearPreviewCommitOptions = useCallback(() => {
    previewCommitRef.current = null;
  }, []);
  const previewQueueItemUuid = drawerPreviewItem?.uuid;
  // The deferred options, for the slot on screen only.
  const getPreviewCommitOptions = useCallback(() => {
    const commit = previewCommitRef.current;
    return commit && commit.queueItemUuid === previewQueueItemUuid ? commit.options : undefined;
  }, [previewQueueItemUuid]);
  const openDrawer = useCallback(
    // `replay`: a pane that mounts later applying a target another pane already
    // applied (see the target effect below). A look, not a pick.
    (selectedClimb: Climb, options?: PlayDrawerOpenOptions, { replay = false }: { replay?: boolean } = {}) => {
      const previewItem = options?.previewQueueItem ?? null;
      const playlistSuggestionSource = options?.playlistSuggestionSource ?? null;
      // Fresh active open (a notification, a deep link with activation intent,
      // the accessory bar's own current climb): the climb becomes current unless
      // it already is, so re-opening the current climb doesn't re-append it.
      // Lists don't come through here: since #6665 they play through the
      // activation hook, which commits (committedExternally) or previews. A fresh-uuid item on a genuinely new selection is
      // intentional (re-tapping starts a fresh pass — see queue setCurrentClimb).
      // A reopen of the current climb (the mini player, the workout card's
      // current-climb row) shows the committed slot, so it never opens as a
      // browse preview. A replay is not one: it keeps the target's own options,
      // so a pane mounting later shows the same browse preview the first did.
      const isFreshActiveOpen = !previewItem && !options?.committedExternally && !options?.reopensCurrent;
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
      //
      // Solo too, outside a drive: a change of climb lights the wall only while
      // this phone drives it (#7113: a swipe, Put on board or Light
      // automatically), in a crew too, so then the open puts the climb up.
      const opensAsBrowse =
        isFreshActiveOpen && (viewer === 'anonymous' || showBoardMismatch || !drivingAtPick(driving));
      // A view-only preview is shown without committing; the browse chrome keys
      // off this. Commit paths (committedExternally) and solo fresh active opens
      // leave it null so the drawer renders the real currentClimbQueueItem.
      const pinnedItem = previewItem ?? (opensAsBrowse ? climbToQueueItem(selectedClimb) : null);
      previewCommitRef.current = previewCommitFor(pinnedItem, options);
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
      // The MiniPlayer reopening the last pick puts the preview's flip back.
      const restoredMirror = pinnedItem ? options?.previewMirrored : undefined;
      if (pinnedItem && restoredMirror !== undefined && restoredMirror !== (pinnedItem.climb.mirrored === true)) {
        restoreMirror(pinnedItem.climb.uuid, restoredMirror);
      }
      onOpenApplied?.({
        previewItem: pinnedItem,
        suggestionSource: pinnedItem ? playlistSuggestionSource : null,
        commitOptions: previewCommitRef.current?.options,
        mirrored: restoredMirror ?? pinnedItem?.climb.mirrored === true,
        replay,
        latchStart: pinnedItem ? options?.previewLatchStart : undefined,
        putOnBoard: pinnedItem !== null && options?.putOnBoard === true && !replay,
      });
      setIsTickBarActive(false);
      setActiveSubDrawer('none');
      if (isFreshActiveOpen && !isAlreadyCurrent && !opensAsBrowse && !replay) {
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
        !pinnedItem &&
        !options?.committedExternally &&
        !options?.reopensCurrent &&
        !replay &&
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
      driving,
      setDrawerPreviewItem,
      setDrawerPreviewSuggestionSource,
      viewer,
      showBoardMismatch,
      heldQueueItemUuid,
      putHeldClimbOnWall,
      clearMirror,
      restoreMirror,
      onOpenApplied,
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
  // climb the #4979 hold kept dark hours after the tap, nor put the climb up a
  // second time. It still reads the target's own options, so a tap that opened
  // as a browse preview shows that preview in the later pane too.
  useEffect(() => {
    if (!openTarget) return;
    const replay = openTarget.claimFirstApply ? !openTarget.claimFirstApply() : false;
    openDrawerRef.current(openTarget.climb, openTarget.options, { replay });
  }, [openTarget]);

  const handlePrev = useSwipeSelection({
    drawerPreviewItem,
    drawerPreviewSuggestionSource,
    setDrawerPreviewItem,
    setDrawerPreviewSuggestionSource,
    setDrawerPreviewIsWallClimb,
    setSharedBrowseLatched,
    driving,
    previewOnOtherBoard,
    targetItem: navigationState.prevItem,
    previewSource: previousPreviewSource,
    navigateQueue: previousClimb,
    setCurrentClimb,
    clearMirror,
    clearPreviewCommitOptions,
    direction: 'previous',
    onNavigationStep,
  });
  const handleNext = useSwipeSelection({
    drawerPreviewItem,
    drawerPreviewSuggestionSource,
    setDrawerPreviewItem,
    setDrawerPreviewSuggestionSource,
    setDrawerPreviewIsWallClimb,
    setSharedBrowseLatched,
    driving,
    previewOnOtherBoard,
    targetItem: navigationState.nextItem,
    previewSource: nextPreviewSource,
    navigateQueue: nextClimb,
    setCurrentClimb,
    clearMirror,
    clearPreviewCommitOptions,
    direction: 'next',
    onNavigationStep,
  });

  // Whether the climb went up: false when there was nothing to commit or the
  // tap only armed the busy-wall question. Put on the wall with no board
  // connected (#6939) connects only after a real commit.
  //
  // `skipBusyWall`: the swipe that starts driving the wall (#7113) commits the
  // climb on screen without asking. The climber who drives never sees the
  // question; their crewmates still do.
  const handleSetActive = useCallback(
    ({ skipBusyWall = false }: { skipBusyWall?: boolean } = {}): boolean => {
      if (!drawerPreviewItem) return false;
      // First tap on a wall someone else moved mid-browse: ask instead of taking
      // it. Only under the browse latch — that is what makes
      // `wallUuidAtLatchStartRef` mean "the wall as it was when you started
      // looking around"; without one there is no before-and-after to compare. And
      // only with a crew (`browseByDefault`: one is here, or was when the latch
      // armed): "Someone just lit X" needs a someone. A solo climber who isn't
      // driving is latched too, and the one way THEIR wall moves under a
      // preview is their own lightbulb tap — asking them to confirm over their
      // own climb would be the question asked of nobody.
      if (
        !skipBusyWall &&
        !driving &&
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
        // The question speaks for itself when it appears (useBusyWallQuestion).
        return false;
      }
      markLatchExit('commit');
      setBusyWallConfirmArmed(false);
      // Launder the item first. Browsing a suggestion track walks onto transient
      // `playlist-peek:<uuid>` items, and `toQueueItemWireInput` sends `item.uuid`
      // verbatim — committing one straight would put a uuid on the wire that no
      // peer can reconcile against their queue. Same helper `nextClimb()` uses.
      const { item, converted } = resolveCommittableQueueItem(drawerPreviewItem);
      const deferredOptions = getPreviewCommitOptions();
      // Re-anchor the track on the climb actually going up. Browsing moves
      // `drawerPreviewItem` swipe by swipe and keeps the source's place in Up
      // next, but never re-anchors it, so after a walk from A to Z the source
      // still says the pass began at A — and committing that verbatim would aim
      // next/previous and the remaining count at A's neighbours, several swipes
      // behind where the climber is standing.
      //
      // No guard here for a climb the source does not contain. `drawerPreviewItem`
      // is by construction on this preview's own track, and the lineage rule lives
      // in `resolveNavigationSuggestionSource` — don't re-add a call-site check.
      //
      // A look off the climb on the wall carries the list the walk is on, with
      // its place in Up next (#7227), so it goes up with that list, as Next would
      // leave it. A look with no list of its own (a queue slot walked along the
      // queue, or a crew browse open of a list climb: a peer's tick, a logbook
      // row, a deep link, the Home new-climb card) is handed to the provider
      // (`keepWalkedTrack`, #6777), which keeps the committed list and where it
      // picks up when the climb is Up next on it, and clears it otherwise. A
      // fresh item never borrows the track (#5403); only a peek of the list's
      // next climb (`walkedPeek`, #7113 QA) keeps it.
      //
      // Either way a peek is a list climb the walk reached, minted fresh here.
      // It goes up as Next places a list step: a fresh copy at the Now slot,
      // never an older entry pulled out of History. A look that carries a list
      // goes up as Next would, leaving the queue as it is (`keepQueue`, #7227):
      // solo, a commit with a list otherwise drops the suggested climbs after
      // it, a workout's among them. The provider keeps the queue for a look
      // off the climb on the wall (its list's `lookOffWall`, forward through
      // Up next or back up the list), for a queued climb (Up next), and for a
      // walk that went through Up next (its list holds a `resume` or a
      // `detour`). A list tap's climb, or a peek along a list opened that way,
      // still prunes as before.
      const keepWalkedTrack = !drawerPreviewSuggestionSource;
      const listStep = converted ? { historyCopy: 'fresh' as const } : {};
      setCurrentClimb(item, {
        ...(deferredOptions ??
          (keepWalkedTrack
            ? { keepWalkedTrack, ...(converted ? { walkedPeek: true } : {}), ...listStep }
            : {
                playlistSuggestionSource: reanchorPlaylistSuggestionSource(
                  drawerPreviewSuggestionSource,
                  item.climb?.uuid,
                ),
                keepQueue: true,
                ...listStep,
              })),
        // Put on the wall: the deliberate commit at the end of a browse, told apart
        // from a plain list or queue pick so the crew ramp can be measured.
        trigger: 'put_on_wall',
      });
      setSharedBrowseLatched(false);
      clearPreviewCommitOptions();
      setDrawerPreviewItem(null);
      setDrawerPreviewSuggestionSource(null);
      setDrawerPreviewIsWallClimb(false);
      // Mirroring is drawer-local per displayed climb and every other navigation
      // resets it (see `handleBackToLive`). The commit has to as well: the
      // auto-sender lights the committed item's own `climb.mirrored`, so a mirror
      // toggled while previewing would leave the drawer showing the climb flipped
      // and the wall showing it straight.
      clearMirror();
      return true;
    },
    [
      drawerPreviewItem,
      drawerPreviewSuggestionSource,
      setDrawerPreviewItem,
      setDrawerPreviewSuggestionSource,
      setCurrentClimb,
      markLatchExit,
      busyWallConfirmArmed,
      browseLatchActive,
      browseByDefault,
      driving,
      wallClimbUuid,
      displayedClimbUuid,
      clearPreviewCommitOptions,
      getPreviewCommitOptions,
    ],
  );

  const commitDisplayedToWall = useCallback(() => {
    if (!drawerPreviewItem || showBoardMismatch) return;
    handleSetActive();
  }, [drawerPreviewItem, showBoardMismatch, handleSetActive]);

  /**
   * The end card's "Keep going with your queue" from a committed climb (#6664):
   * leave the list for the climb queued after the current one.
   *
   * It goes the way Next went before the list took over the swipe, so it is
   * bound by the same rules as a swipe: outside a drive it opens the queued
   * climb as a preview and the wall stays put. Only where a swipe would commit
   * (driving) does it take the wall, exactly as a queue-sheet tap does. Either way the list's track is left behind, so Next and Previous
   * walk the queue from there.
   */
  const continueIntoQueue = useCallback(
    (target: ClimbQueueItem) => {
      clearPreviewCommitOptions();
      const landing = getSwipeNavigationTarget({
        previewItem: drawerPreviewItem,
        previewSuggestionSource: drawerPreviewSuggestionSource,
        targetItem: target,
        driving: drivingAtPick(driving),
        previewOnOtherBoard,
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
      driving,
      previewOnOtherBoard,
      setDrawerPreviewItem,
      setDrawerPreviewSuggestionSource,
      setDrawerPreviewIsWallClimb,
      setCurrentClimb,
      clearMirror,
      clearPreviewCommitOptions,
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
   * - nobody drives the wall from this phone (#7113: a swipe, Put on board or
   *   Always drive the wall), or a press on the frosted button stopped it;
   * - the player is showing a climb from another board, whose similar climbs
   *   are on that board too and can't go up on this one. That used to be the
   *   queue add's cross-board prompt; there is no add any more.
   * Otherwise (driving) the climb goes up, inserted after the current one and
   * flagged `suggested` like every list play. Driving overrides the crew, never
   * the other board.
   *
   * The displayed climb is read from a ref at tap time, not listed as a dep:
   * it changes on every player move, and a fresh handler each time would
   * rebuild every memoized similar-climb row's press handler with it.
   */
  const displayedClimbUuidRef = useRef(displayedClimbUuid);
  displayedClimbUuidRef.current = displayedClimbUuid;
  const handleSimilarClimbPress = useCallback(
    (similarClimb: Climb, similarClimbs: Climb[] = []) => {
      clearPreviewCommitOptions();
      const drivingNow = drivingAtPick(driving);
      const previewOnly =
        getSimilarClimbTapMode(viewer, { inSharedSession: browseByDefault, driving: drivingNow }) === 'preview' ||
        showBoardMismatch ||
        !drivingNow;
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
      driving,
      showBoardMismatch,
      similarTrack,
      setDrawerPreviewItem,
      setDrawerPreviewSuggestionSource,
      setDrawerPreviewIsWallClimb,
      clearMirror,
      setIsTickBarActive,
      clearPreviewCommitOptions,
    ],
  );

  return {
    handlePrev,
    handleNext,
    handleSetActive,
    handleSimilarClimbPress,
    commitDisplayedToWall,
    continueIntoQueue,
    getPreviewCommitOptions,
  };
}
