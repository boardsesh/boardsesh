import { useEffect, useMemo, useRef, type ComponentType, type RefObject } from 'react';
import { Gesture, type GestureType } from 'react-native-gesture-handler';
import { useAnimatedReaction, useSharedValue, withSpring, runOnJS, type SharedValue } from 'react-native-reanimated';
import { SWIPE_THRESHOLD, DIRECTION_THRESHOLD, VERTICAL_LOCK_RATIO, SWIPE_OFFSCREEN_PAD } from '@boardsesh/play-view';
import { carouselCommitDirection } from './carousel-commit';
import type { SwipePager } from './use-swipe-pager';
import { springs } from '../../theme/animations';
import { hapticMedium } from '../../lib/haptics';

type UseCarouselGestureOptions = {
  /** Which page is in the middle, and the offset every swiping surface rides. See use-swipe-pager. */
  pager: SwipePager;
  onSwipeNext: () => void;
  onSwipePrevious: () => void;
  /** Width the incoming board enters by (the contained board width). */
  boardWidth: number;
  /** Full screen width — the card flings to ±(screenWidth + pad) so it fully
   *  clears the viewport on release, past its letterbox margins. */
  screenWidth: number;
  enabled?: boolean;
  isZoomedSV?: SharedValue<boolean>;
  /** RNGH ref to the surrounding scroll. Simultaneous recognition lets native
   *  vertical scrolling start immediately while horizontal swipes still drive
   *  the carousel. */
  scrollRef?: RefObject<ComponentType | undefined | null>;
  /** When true (Reduce Motion), commit the swap instantly with no slide-off /
   *  spring snap-back. The gesture still works; only the animation is dropped. */
  reduceMotion?: boolean;
};

type UseCarouselGestureReturn = {
  gesture: GestureType;
};

/**
 * The horizontal swipe between climbs.
 *
 * Everything the climber sees is settled on the UI thread: a committing release
 * flings the board off, and the frame it is gone the pager's anchor moves to the
 * neighbour's page and the offset returns to 0, so the next swipe can start at
 * once. A swipe that starts before the fling has landed takes over from it; see
 * `landFling`.
 *
 * The JS thread is told once the incoming board has stopped in the middle, which
 * is about two thirds of the way through the fling. Changing the climb costs the
 * UI thread a frame now and then (the new neighbour's board is mounted, the rest
 * of the drawer updates), and it should not be a frame in which a board is
 * moving. Told at finger-up it was: 5 to 7 frames in 2,500 on an iPhone 13 Pro,
 * all of them mid-fling. Told only when the fling has landed, the next swipe has
 * to wait 50 ms longer for its page. In between, the picture is already still
 * and the JS thread has most of the fling as a head start.
 */
export function useCarouselGesture({
  pager,
  onSwipeNext,
  onSwipePrevious,
  boardWidth,
  screenWidth,
  enabled = true,
  isZoomedSV,
  scrollRef,
  reduceMotion = false,
}: UseCarouselGestureOptions): UseCarouselGestureReturn {
  const { translateX, isAnimating, anchorPage, flingDirection, uiSteps, jsState, resetGeneration } = pager;
  const hasTriggeredHaptic = useSharedValue(false);

  // Mirror enabled into a shared value so the gesture useMemo doesn't rebuild
  // when it flips — recomposing mid-session left RNGH stuck on iOS.
  const enabledSV = useSharedValue(enabled);
  useEffect(() => {
    enabledSV.value = enabled;
  }, [enabled, enabledSV]);

  // Mirror Reduce Motion into a shared value for the same reason — flipping it
  // shouldn't rebuild the gesture.
  const reduceMotionSV = useSharedValue(reduceMotion);
  useEffect(() => {
    reduceMotionSV.value = reduceMotion;
  }, [reduceMotion, reduceMotionSV]);

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

  const callbacksRef = useRef({ onSwipeNext, onSwipePrevious, requestStep: pager.requestStep });
  callbacksRef.current = { onSwipeNext, onSwipePrevious, requestStep: pager.requestStep };

  // The JS callbacks below are captured ONCE by the gesture memo (it composes a
  // single time per mount) — they must only close over refs and shared values.
  // Route any new render-scoped value through callbacksRef.
  const triggerHaptic = () => {
    hapticMedium();
  };

  // Fired while the fling is still running (see `tellJsThread`): the JS thread
  // changes the climb under an animation that no longer needs it. The pager runs the
  // navigation callback when its turn comes, which is at once unless an earlier
  // step is still being rendered; the callback is looked up then, not now, so it
  // is the one from the render that step produced.
  const commitStep = (direction: 1 | -1, step: number) => {
    callbacksRef.current.requestStep(direction, step, () => {
      if (direction === 1) {
        callbacksRef.current.onSwipeNext();
      } else {
        callbacksRef.current.onSwipePrevious();
      }
    });
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
  // The step a fling is carrying that the JS thread has not been told about
  // yet; 0 when there is none.
  const untoldStep = useSharedValue(0);

  const tellJsThread = () => {
    'worklet';
    const step = untoldStep.value;
    if (step === 0) return;
    untoldStep.value = 0;
    runOnJS(commitStep)(flingDirection.value > 0 ? 1 : -1, step);
  };
  // The incoming board stops in the middle when the outgoing one has travelled
  // its own width; from there on the fling is only the outgoing board's tail
  // leaving a picture that is otherwise still.
  useAnimatedReaction(
    () => flingDirection.value !== 0 && Math.abs(translateX.value) >= boardWidthSV.value,
    (incomingBoardHasStopped, before) => {
      if (incomingBoardHasStopped && !before) tellJsThread();
    },
    [flingDirection, translateX, boardWidthSV, untoldStep],
  );

  const gesture = useMemo(() => {
    /** Whether the page one step that way is mounted. The JS thread mounts one each side of ITS middle page. */
    const canStep = (direction: 1 | -1) => {
      'worklet';
      const state = jsState.value;
      const target = anchorPage.value + direction;
      return target >= state.center - (state.hasPrevious ? 1 : 0) && target <= state.center + (state.hasNext ? 1 : 0);
    };

    /**
     * End the fling now: the neighbour's page becomes the anchor.
     *
     * At the fling's own end the offset simply returns to 0, on the same frame,
     * so nothing moves. When a new swipe cuts the fling short, `carry` keeps
     * both boards where they are: the incoming board has not reached the middle
     * yet, so in the new anchor's terms it is still that far off centre.
     */
    const landFling = (carry: boolean) => {
      'worklet';
      const direction = flingDirection.value;
      if (direction === 0) return;
      // A swipe that cut the fling short got here before the incoming board did.
      tellJsThread();
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

    const pan = Gesture.Pan()
      .manualActivation(true)
      .maxPointers(1)
      .onTouchesDown((event, state) => {
        'worklet';
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

        if (offset < 0 && !canStep(1)) offset = 0;
        if (offset > 0 && !canStep(-1)) offset = 0;

        translateX.value = offset;

        if (Math.abs(travel) >= SWIPE_THRESHOLD && !hasTriggeredHaptic.value && canStep(travel < 0 ? 1 : -1)) {
          hasTriggeredHaptic.value = true;
          runOnJS(triggerHaptic)();
        }
      })
      .onEnd((event) => {
        'worklet';
        const offset = translateX.value;
        const skipAnimation = reduceMotionSV.value;
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
          uiSteps.value += 1;
          if (skipAnimation) {
            runOnJS(commitStep)(direction, uiSteps.value);
            anchorPage.value += direction;
            translateX.value = 0;
            return;
          }
          untoldStep.value = uiSteps.value;
          isAnimating.value = true;
          flingDirection.value = direction;
          // Fling fully off-screen (Tinder throw) — past the screen edge so the
          // letterbox clears. The anchor moves on COMPLETION (card off-screen,
          // incoming board in the middle), in the same frame the offset resets.
          translateX.value = withSpring(
            -direction * (screenWidthSV.value + SWIPE_OFFSCREEN_PAD),
            { ...springs.interactive, velocity, overshootClamping: true },
            (finished) => {
              'worklet';
              if (finished) landFling(false);
            },
          );
          return;
        }
        if (offset !== 0) {
          translateX.value = skipAnimation ? 0 : withSpring(0, { ...springs.interactive, velocity });
        }
      })
      // manualActivation hands the touch lifecycle to these worklets, so a touch
      // cancelled mid-swipe (a sheet/route presents over the board, the OS steals
      // the touch) must explicitly fail — otherwise the activated Pan stays latched
      // holding the responder, and every Pressable tap dies app-wide while the
      // simultaneous scroll still works (the "frozen, scroll-but-no-tap" bug).
      .onTouchesCancelled((_event, stateManager) => {
        'worklet';
        stateManager.fail();
      })
      // Catch-all terminal reset: on any end/fail/cancel, clear the direction lock
      // so a finalized gesture never leaves stale manual state behind.
      .onFinalize(() => {
        'worklet';
        directionLock.value = 0;
      });
    return scrollRef ? pan.simultaneousWithExternalGesture(scrollRef) : pan;
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
    enabledSV,
    reduceMotionSV,
    directionLock,
    startTouchX,
    startTouchY,
    dragBase,
    dragOrigin,
    dragGeneration,
    untoldStep,
    scrollRef,
  ]);

  return { gesture };
}
