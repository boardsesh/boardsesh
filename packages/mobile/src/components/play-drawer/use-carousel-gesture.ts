import { useEffect, useMemo, type ComponentType, type RefObject } from 'react';
import { Gesture, type GestureType } from 'react-native-gesture-handler';
import {
  cancelAnimation,
  runOnJS,
  runOnUI,
  useAnimatedReaction,
  useSharedValue,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated';
import { SWIPE_THRESHOLD, DIRECTION_THRESHOLD, VERTICAL_LOCK_RATIO, SWIPE_OFFSCREEN_PAD } from '@boardsesh/play-view';
import { carouselCommitDirection } from './carousel-commit';
import type { SwipePager } from './use-swipe-pager';
import { springs } from '../../theme/animations';
import { hapticMedium } from '../../lib/haptics';
import type { BoardArtReadiness } from '../../lib/board-render/ready-board-art';

/**
 * How much of the finger's travel the board follows past the list's last climb
 * (issue #6664): enough to feel the end give, not so much that it reads as a
 * swipe that went somewhere.
 */
const TRACK_END_DRAG_RESISTANCE = 0.3;

type UseCarouselGestureOptions = {
  /**
   * Which page is in the middle, the offset every swiping surface rides, and
   * the way a step reaches the JS thread. See use-swipe-pager.
   */
  pager: SwipePager;
  /** Width the incoming board enters by (the contained board width). */
  boardWidth: number;
  /** Full screen width — the card flings to ±(screenWidth + pad) so it fully
   *  clears the viewport on release, past its letterbox margins. */
  screenWidth: number;
  enabled?: boolean;
  isZoomedSV?: SharedValue<boolean>;
  /** Mounted pages whose backgrounds and holds have actually displayed. */
  pageArt?: SharedValue<Readonly<Record<number, BoardArtReadiness>>>;
  /** RNGH ref to the surrounding scroll. Simultaneous recognition lets native
   *  vertical scrolling start immediately while horizontal swipes still drive
   *  the carousel. */
  scrollRef?: RefObject<ComponentType | undefined | null>;
};

type UseCarouselGestureReturn = {
  gesture: GestureType;
};

type PendingSwipeRelease = {
  direction: 1 | -1;
  velocity: number;
  anchor: number;
  step: number;
  generation: number;
};

/**
 * The horizontal swipe between climbs.
 *
 * A committing release flings the board off, and the frame it is gone the
 * pager's anchor moves to the neighbour's page and the offset returns to 0, so
 * the next swipe can start at once. A swipe that starts before the fling has
 * landed takes over from it; see `landFling`. None of that asks the JS thread
 * anything. The pager tells it while the fling runs (`tellUntoldStep`), and it
 * follows.
 *
 * Under the system's Reduce Motion setting Reanimated ends a spring the moment
 * it is assigned, so a release changes the climb with no slide and a let-go
 * drag is back in the middle at once. Nothing here has to ask for that.
 * Reanimated reads the setting once, when the app starts: switched on while
 * the app is running, it takes effect here at the next launch.
 */
export function useCarouselGesture({
  pager,
  boardWidth,
  screenWidth,
  enabled = true,
  isZoomedSV,
  pageArt,
  scrollRef,
}: UseCarouselGestureOptions): UseCarouselGestureReturn {
  const {
    translateX,
    isAnimating,
    anchorPage,
    flingDirection,
    uiSteps,
    jsState,
    resetGeneration,
    untoldStep,
    tellUntoldStep,
    trackEndAvailable,
    reachTrackEnd,
  } = pager;
  const hasTriggeredHaptic = useSharedValue(false);
  // Only a released swipe waits here. A drag still needs a mounted neighbour
  // before moving the board; catching up must never expose an empty page.
  const pendingRelease = useSharedValue<PendingSwipeRelease | null>(null);
  const touchCancelled = useSharedValue(false);

  // Mirror enabled into a shared value so the gesture useMemo doesn't rebuild
  // when it flips — recomposing mid-session left RNGH stuck on iOS.
  const enabledSV = useSharedValue(enabled);
  useEffect(() => {
    enabledSV.value = enabled;
  }, [enabled, enabledSV]);

  // The incoming board's travel (board width) lives in a shared value so the
  // post-layout change from screenWidth to the contained board width doesn't
  // rebuild the gesture mid-session. It is the pager's, because the header
  // scales its own travel by it.
  const boardWidthSV = pager.slideWidth;
  useEffect(() => {
    boardWidthSV.value = boardWidth;
  }, [boardWidth, boardWidthSV]);

  // Fling distance rides the FULL screen width (+ pad) so the card fully clears
  // the viewport. Mirrored for the same reason as boardWidth — a layout change
  // must not rebuild the gesture.
  const screenWidthSV = useSharedValue(screenWidth);
  useEffect(() => {
    screenWidthSV.value = screenWidth;
  }, [screenWidth, screenWidthSV]);

  // A carousel taken down under a finger gets no `onEnd`. The offset is the
  // pager's and outlives it: left where the drag was, the header would sit off
  // centre and the drawer's pull-down would stand aside for a swipe that is no
  // longer happening. A fling is left alone; it lands by itself.
  useEffect(
    () => () => {
      runOnUI(() => {
        'worklet';
        pendingRelease.value = null;
        if (flingDirection.value !== 0) return;
        cancelAnimation(translateX);
        translateX.value = 0;
      })();
    },
    [flingDirection, pendingRelease, translateX],
  );

  // Captured ONCE by the gesture memo (it composes a single time per mount):
  // it must only close over refs and shared values.
  const triggerHaptic = () => {
    hapticMedium();
  };

  // Lock direction on first significant move. Once locked horizontal, the gesture
  // stays committed even if the user drifts vertically. failOffsetY would
  // otherwise kill a horizontal swipe the moment Y drift crossed 10px, making
  // carousel swipes finicky. Vertical-locked gestures fail so the touch falls
  // through to the scroll. The decision is biased toward horizontal
  // (VERTICAL_LOCK_RATIO) so a horizontal-intended swipe that drifts slightly down
  // still locks horizontal — otherwise it read as vertical and the drawer's
  // pull-to-dismiss grabbed it. Web stays symmetric; only the play drawer biases.
  const directionLock = useSharedValue<0 | 1 | -1>(0); // 0=undecided, 1=horizontal, -1=vertical
  const startTouchX = useSharedValue(0);
  const startTouchY = useSharedValue(0);
  // Where the drag's offset started, and the finger travel already spent when it
  // did. Both 0 for a swipe from rest; a swipe that takes over a fling starts
  // from where that fling had got to.
  const dragBase = useSharedValue(0);
  const dragOrigin = useSharedValue(0);
  // The pager's reset count when this drag last took its bearings. When the
  // pager abandons the page under a drag to follow the JS thread, the drag
  // starts over from the finger's position rather than add to an offset that
  // belonged to the old page.
  const dragGeneration = useSharedValue(0);

  const { gesture, startFling } = useMemo(() => {
    /** Whether the page one step that way is mounted. The JS thread mounts one each side of ITS middle page. */
    const hasMountedPage = (direction: 1 | -1) => {
      'worklet';
      const state = jsState.value;
      const target = anchorPage.value + direction;
      return target >= state.center - (state.hasPrevious ? 1 : 0) && target <= state.center + (state.hasNext ? 1 : 0);
    };
    const canStep = (direction: 1 | -1) => {
      'worklet';
      return (
        hasMountedPage(direction) && (pageArt === undefined || pageArt.value[anchorPage.value + direction] === 'ready')
      );
    };

    /**
     * End the fling now: the neighbour's page becomes the anchor.
     *
     * At the fling's own end the offset simply returns to 0, on the same frame,
     * so nothing moves. When a new swipe cuts the fling short, `carry` keeps the
     * incoming board where it is: if it has not reached the middle yet, then in
     * the new anchor's terms it is still that far off centre, and the outgoing
     * board beside it stays put too.
     *
     * Two cases are not carried exactly. Once the incoming board has stopped,
     * the outgoing one is dropped a few frames before it would have left; that
     * shows only beside a letterboxed board, whose margins it was still
     * crossing. And a fling cut short before it has crossed the middle, which
     * takes a touch that activates within a frame or two of the last release,
     * puts the board it was leaving in the middle.
     */
    const landFling = (carry: boolean) => {
      'worklet';
      const direction = flingDirection.value;
      if (direction === 0) return;
      // A swipe that cut the fling short got here before the incoming board did.
      tellUntoldStep();
      const remaining =
        direction > 0
          ? Math.max(0, boardWidthSV.value + translateX.value)
          : Math.min(0, -boardWidthSV.value + translateX.value);
      flingDirection.value = 0;
      isAnimating.value = false;
      anchorPage.value += direction;
      // Assigning cancels the spring; its callback then reports unfinished and does nothing.
      translateX.value = carry ? remaining : 0;
    };

    const takeOverFling = (translationX: number) => {
      'worklet';
      landFling(true);
      dragBase.value = translateX.value;
      dragOrigin.value = translationX;
    };

    const startFling = (direction: 1 | -1, velocity: number) => {
      'worklet';
      uiSteps.value += 1;
      untoldStep.value = uiSteps.value;
      isAnimating.value = true;
      flingDirection.value = direction;
      // Clear the full viewport, including the board's letterbox margins.
      translateX.value = withSpring(
        -direction * (screenWidthSV.value + SWIPE_OFFSCREEN_PAD),
        { ...springs.interactive, velocity, overshootClamping: true },
        (finished) => {
          'worklet';
          if (finished) landFling(false);
        },
      );
    };

    const pan = Gesture.Pan()
      .manualActivation(true)
      .maxPointers(1)
      .onTouchesDown((event, state) => {
        'worklet';
        pendingRelease.value = null;
        touchCancelled.value = false;
        directionLock.value = 0;
        if (event.allTouches.length > 1) {
          state.fail();
          return;
        }
        const touch = event.allTouches[0];
        if (touch) {
          startTouchX.value = touch.absoluteX;
          startTouchY.value = touch.absoluteY;
        }
      })
      .onTouchesMove((event, state) => {
        'worklet';
        if (event.allTouches.length > 1 || !enabledSV.value || isZoomedSV?.value) {
          state.fail();
          return;
        }
        if (directionLock.value === 1) {
          state.activate();
          return;
        }
        if (directionLock.value === -1) {
          state.fail();
          return;
        }
        const touch = event.allTouches[0];
        if (!touch) return;
        const dx = touch.absoluteX - startTouchX.value;
        const dy = touch.absoluteY - startTouchY.value;
        const absX = Math.abs(dx);
        const absY = Math.abs(dy);
        if (absX <= DIRECTION_THRESHOLD && absY <= DIRECTION_THRESHOLD) return;
        // Bias toward horizontal: lock vertical only when the motion is clearly
        // vertical (absY ≥ absX × VERTICAL_LOCK_RATIO). Keeps near-vertical
        // scroll/dismiss working while protecting slightly-diagonal climb swipes.
        // This mirrors decideSwipeDirection(dx, dy, threshold, VERTICAL_LOCK_RATIO)
        // in @boardsesh/play-view (the canonical spec + web's path) — inlined here
        // because the worklet can't call it; keep the two in sync if either changes.
        if (absY >= absX * VERTICAL_LOCK_RATIO) {
          directionLock.value = -1;
          state.fail();
        } else {
          directionLock.value = 1;
          state.activate();
        }
      })
      .onStart((event) => {
        'worklet';
        pendingRelease.value = null;
        touchCancelled.value = false;
        hasTriggeredHaptic.value = false;
        dragGeneration.value = resetGeneration.value;
        if (isAnimating.value) {
          takeOverFling(event.translationX);
        } else {
          dragBase.value = 0;
          dragOrigin.value = 0;
        }
      })
      .onUpdate((event) => {
        'worklet';
        if (dragGeneration.value !== resetGeneration.value) {
          dragGeneration.value = resetGeneration.value;
          dragBase.value = 0;
          dragOrigin.value = event.translationX;
        }
        // What the finger has done in THIS swipe, and where that puts the page.
        // They differ for a swipe that took over a fling: it starts with the
        // offset still on the far side of 0.
        const travel = event.translationX - dragOrigin.value;
        let offset = dragBase.value + travel;

        // Past the list's last climb the board gives a little toward the end
        // card; anywhere else with nowhere to go, it stays put.
        const atTrackEnd =
          offset < 0 &&
          !hasMountedPage(1) &&
          trackEndAvailable.value &&
          jsState.value.processedStep === uiSteps.value &&
          jsState.value.center === anchorPage.value;
        if (offset < 0 && !canStep(1)) offset = atTrackEnd ? offset * TRACK_END_DRAG_RESISTANCE : 0;
        if (offset > 0 && !canStep(-1)) offset = 0;

        translateX.value = offset;

        if (
          Math.abs(travel) >= SWIPE_THRESHOLD &&
          !hasTriggeredHaptic.value &&
          (canStep(travel < 0 ? 1 : -1) || (travel < 0 && atTrackEnd))
        ) {
          hasTriggeredHaptic.value = true;
          runOnJS(triggerHaptic)();
        }
      })
      .onEnd((event) => {
        'worklet';
        // A navigation reset can arrive after the final update. That finger
        // travel belongs to the page the pager has already abandoned.
        if (dragGeneration.value !== resetGeneration.value) return;
        const offset = translateX.value;
        const velocity = event.velocityX ?? 0;
        // Judged on the finger's own travel, like the haptic: a hard flick must
        // count however little of a taken-over offset it had undone by
        // finger-up.
        //
        // The handler's `success` argument is deliberately not consulted, as it
        // never was. It is false for a touch the system cancelled, and a swipe
        // that was far enough along still changes the climb then. Gating on it
        // was tried and is wrong for a second reason: strokes sent back to back
        // by the UI test driver end unsuccessfully, all but the last, and nine
        // of ten scripted swipes sprang back.
        const travel = event.translationX - dragOrigin.value;
        const commitDirection = carouselCommitDirection(travel, velocity, SWIPE_THRESHOLD);
        const direction = commitDirection === 'next' ? 1 : commitDirection === 'previous' ? -1 : 0;

        if (direction !== 0 && canStep(direction)) {
          startFling(direction, velocity);
          return;
        }
        // A fast second release can beat the render that mounts its neighbour.
        // Keep its intent, but take no step until that render confirms the page.
        if (
          direction !== 0 &&
          !touchCancelled.value &&
          enabledSV.value &&
          !isZoomedSV?.value &&
          (jsState.value.processedStep !== uiSteps.value || hasMountedPage(direction))
        ) {
          pendingRelease.value = {
            direction,
            velocity,
            anchor: anchorPage.value,
            step: uiSteps.value,
            generation: resetGeneration.value,
          };
          // A forward swipe past the list's last climb shows the end card only
          // once React has confirmed that this really is the end of the track.
        } else if (
          direction === 1 &&
          !hasMountedPage(1) &&
          trackEndAvailable.value &&
          jsState.value.center === anchorPage.value
        ) {
          runOnJS(reachTrackEnd)();
        }
        if (offset !== 0) {
          translateX.value = withSpring(0, { ...springs.interactive, velocity });
        }
      })
      // manualActivation hands the touch lifecycle to these worklets, so a touch
      // cancelled mid-swipe (a sheet/route presents over the board, the OS steals
      // the touch) must explicitly fail — otherwise the activated Pan stays latched
      // holding the responder, and every Pressable tap dies app-wide while the
      // simultaneous scroll still works (the "frozen, scroll-but-no-tap" bug).
      .onTouchesCancelled((_event, stateManager) => {
        'worklet';
        pendingRelease.value = null;
        touchCancelled.value = true;
        stateManager.fail();
      })
      // Catch-all terminal reset: on any end/fail/cancel, clear the direction lock
      // so a finalized gesture never leaves stale manual state behind.
      .onFinalize(() => {
        'worklet';
        directionLock.value = 0;
      });
    return { gesture: scrollRef ? pan.simultaneousWithExternalGesture(scrollRef) : pan, startFling };
  }, [
    boardWidthSV,
    screenWidthSV,
    translateX,
    isAnimating,
    anchorPage,
    flingDirection,
    uiSteps,
    jsState,
    resetGeneration,
    hasTriggeredHaptic,
    isZoomedSV,
    pageArt,
    enabledSV,
    directionLock,
    startTouchX,
    startTouchY,
    dragBase,
    dragOrigin,
    dragGeneration,
    untoldStep,
    tellUntoldStep,
    trackEndAvailable,
    reachTrackEnd,
    pendingRelease,
    touchCancelled,
    scrollRef,
  ]);

  useAnimatedReaction(
    () => {
      const pending = pendingRelease.value;
      if (pending === null) return null;
      return {
        pending,
        state: jsState.value,
        anchor: anchorPage.value,
        step: uiSteps.value,
        generation: resetGeneration.value,
        enabled: enabledSV.value,
        zoomed: isZoomedSV?.value ?? false,
        pageArt: pageArt?.value,
        trackEndAvailable: trackEndAvailable.value,
      };
    },
    (snapshot) => {
      if (snapshot === null) return;
      const { pending, state } = snapshot;
      if (
        !snapshot.enabled ||
        snapshot.zoomed ||
        snapshot.anchor !== pending.anchor ||
        snapshot.step !== pending.step ||
        snapshot.generation !== pending.generation
      ) {
        pendingRelease.value = null;
        return;
      }
      // Failure cancels intent even before React acknowledges the previous
      // swipe. A repaired image must not revive an already cancelled release.
      const targetArt = snapshot.pageArt?.[pending.anchor + pending.direction];
      if (targetArt === 'failed') {
        pendingRelease.value = null;
        return;
      }
      if (state.processedStep !== pending.step) return;
      // A queue change or refused step may have put a different page in the
      // middle. A real queue boundary must still reject the retained release.
      if (state.center !== pending.anchor) {
        pendingRelease.value = null;
        return;
      }
      if (!(pending.direction > 0 ? state.hasNext : state.hasPrevious)) {
        pendingRelease.value = null;
        if (pending.direction > 0 && snapshot.trackEndAvailable) runOnJS(reachTrackEnd)();
        return;
      }
      if (snapshot.pageArt && targetArt !== 'ready') return;
      pendingRelease.value = null;
      startFling(pending.direction, pending.velocity);
    },
    [
      pendingRelease,
      jsState,
      anchorPage,
      uiSteps,
      resetGeneration,
      enabledSV,
      isZoomedSV,
      pageArt,
      trackEndAvailable,
      reachTrackEnd,
      startFling,
    ],
  );

  return { gesture };
}
