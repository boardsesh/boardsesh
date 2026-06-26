import { useEffect, useMemo, useRef, type ComponentType, type RefObject } from 'react';
import { Gesture, type GestureType } from 'react-native-gesture-handler';
import { useSharedValue, withTiming, withSpring, runOnJS, type SharedValue } from 'react-native-reanimated';
import {
  SWIPE_THRESHOLD,
  DIRECTION_THRESHOLD,
  VERTICAL_LOCK_RATIO,
  EXIT_DURATION,
  SWIPE_OFFSCREEN_PAD,
} from '@boardsesh/play-view';
import { springs } from '../../theme/animations';
import { hapticMedium } from '../../lib/haptics';

type UseCarouselGestureOptions = {
  onSwipeNext: () => void;
  onSwipePrevious: () => void;
  canSwipeNext: boolean;
  canSwipePrevious: boolean;
  /** Width the slide-off is measured in (the contained board width). */
  boardWidth: number;
  /** Full screen width — the card flings to ±(screenWidth + pad) so it fully
   *  clears the viewport on release, past its letterbox margins. */
  screenWidth: number;
  enabled?: boolean;
  isZoomedSV?: SharedValue<boolean>;
  /** RNGH ref to the surrounding scroll. Declares the swipe Pan simultaneous with
   *  it so vertical drags reach the scroll while horizontal ones drive the
   *  carousel. Typed as RNGH's GestureRef shape so the method call needs no cast;
   *  at runtime it holds the RN ScrollView instance. */
  scrollRef?: RefObject<ComponentType | undefined | null>;
  /** Optional external translateX. Pass one so a sibling rendered OUTSIDE this
   *  carousel (the play-drawer header) can swipe off the exact same value as the
   *  board. Falls back to an internal shared value. */
  externalTranslateX?: SharedValue<number>;
  /** Optional external isAnimating flag. When provided, the gesture does NOT reset
   *  translateX/isAnimating after the fling — the host owns that, resetting once
   *  the new climb has actually rendered (so the incoming peek covers the swap and
   *  there's no flash). Falls back to an internal flag + self-reset when absent. */
  externalIsAnimating?: SharedValue<boolean>;
  /** When true (Reduce Motion), commit the swap instantly with no slide-off /
   *  spring snap-back. The gesture still works; only the animation is dropped. */
  reduceMotion?: boolean;
};

type UseCarouselGestureReturn = {
  gesture: GestureType;
  translateX: SharedValue<number>;
  isAnimating: SharedValue<boolean>;
};

// Delay-navigation: matches web — swap climb at CLIP_EXIT_DURATION while the
// outgoing card finishes its EXIT_DURATION slide-off behind the peek board.
export function useCarouselGesture({
  onSwipeNext,
  onSwipePrevious,
  canSwipeNext,
  canSwipePrevious,
  boardWidth,
  screenWidth,
  enabled = true,
  isZoomedSV,
  scrollRef,
  externalTranslateX,
  externalIsAnimating,
  reduceMotion = false,
}: UseCarouselGestureOptions): UseCarouselGestureReturn {
  // Use the caller's shared values when provided so the header can ride the same
  // swipe and the host can own the post-render reset; otherwise own them.
  // useSharedValue must run unconditionally.
  const internalTranslateX = useSharedValue(0);
  const translateX = externalTranslateX ?? internalTranslateX;
  const internalIsAnimating = useSharedValue(false);
  const isAnimating = externalIsAnimating ?? internalIsAnimating;
  const hostDrivesReset = externalIsAnimating != null;
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

  // Mirror the slide-off distance (board width) into a shared value so the
  // post-layout change from screenWidth to the contained board width doesn't
  // rebuild the gesture mid-session.
  const boardWidthSV = useSharedValue(boardWidth);
  useEffect(() => {
    boardWidthSV.value = boardWidth;
  }, [boardWidth, boardWidthSV]);

  // Fling distance rides the FULL screen width (+ pad) so the card fully clears
  // the viewport, while the spring snap-back still uses board width. Mirrored for
  // the same reason as boardWidth — a layout change must not rebuild the gesture.
  const screenWidthSV = useSharedValue(screenWidth);
  useEffect(() => {
    screenWidthSV.value = screenWidth;
  }, [screenWidth, screenWidthSV]);

  // Mirror swipe availability into shared values for the same reason — these
  // flip at queue boundaries (and on queue mutations during the commit window),
  // and recomposing the gesture then would hit the same iOS RNGH wedge.
  const canSwipeNextSV = useSharedValue(canSwipeNext);
  useEffect(() => {
    canSwipeNextSV.value = canSwipeNext;
  }, [canSwipeNext, canSwipeNextSV]);
  const canSwipePreviousSV = useSharedValue(canSwipePrevious);
  useEffect(() => {
    canSwipePreviousSV.value = canSwipePrevious;
  }, [canSwipePrevious, canSwipePreviousSV]);

  const callbacksRef = useRef({ onSwipeNext, onSwipePrevious });
  callbacksRef.current = { onSwipeNext, onSwipePrevious };

  // The JS callbacks below are captured ONCE by the gesture memo (it composes a
  // single time per mount) — they must only close over refs and shared values.
  // Route any new render-scoped value through callbacksRef.
  const triggerHaptic = () => {
    hapticMedium();
  };

  // Reduce Motion: the worklet already snapped translateX to 0, so just fire the
  // navigation callback with no slide-off.
  const commitImmediate = (direction: 'next' | 'previous') => {
    if (direction === 'next') {
      callbacksRef.current.onSwipeNext();
    } else {
      callbacksRef.current.onSwipePrevious();
    }
  };

  // Fired from the fling's withTiming completion — i.e. once the outgoing card is
  // fully OFF-SCREEN and the incoming peek board has slid to centre. We commit the
  // navigation here, but DON'T reset translateX yet when a host is wired up: the
  // host keeps the (frozen) peek covering centre and resets translateX only after
  // the new climb has actually rendered, so the swap is invisible. Resetting here
  // (the standalone fallback) hides the peek a frame before the new content lands,
  // which flickers the old climb back at centre.
  const commitAtEnd = (direction: 'next' | 'previous') => {
    if (direction === 'next') {
      callbacksRef.current.onSwipeNext();
    } else {
      callbacksRef.current.onSwipePrevious();
    }
    if (!hostDrivesReset) {
      translateX.value = 0;
      isAnimating.value = false;
    }
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

  const gesture = useMemo(() => {
    const pan = Gesture.Pan()
      .manualActivation(true)
      .onTouchesDown((event) => {
        'worklet';
        directionLock.value = 0;
        const touch = event.allTouches[0];
        if (touch) {
          startTouchX.value = touch.absoluteX;
          startTouchY.value = touch.absoluteY;
        }
      })
      .onTouchesMove((event, state) => {
        'worklet';
        if (!enabledSV.value || isZoomedSV?.value) {
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
      .onStart(() => {
        'worklet';
        hasTriggeredHaptic.value = false;
      })
      .onUpdate((event) => {
        'worklet';
        if (isAnimating.value) return;

        let offset = event.translationX;

        if (offset < 0 && !canSwipeNextSV.value) offset = 0;
        if (offset > 0 && !canSwipePreviousSV.value) offset = 0;

        translateX.value = offset;

        if (Math.abs(offset) >= SWIPE_THRESHOLD && !hasTriggeredHaptic.value) {
          hasTriggeredHaptic.value = true;
          runOnJS(triggerHaptic)();
        }
      })
      .onEnd(() => {
        'worklet';
        if (isAnimating.value) return;

        const offset = translateX.value;
        const skipAnimation = reduceMotionSV.value;

        if (offset < -SWIPE_THRESHOLD && canSwipeNextSV.value) {
          if (skipAnimation) {
            translateX.value = 0;
            runOnJS(commitImmediate)('next');
          } else {
            isAnimating.value = true;
            // Fling fully off-screen (Tinder throw) — past the screen edge so the
            // tilt/letterbox clears. Commit on COMPLETION (card off-screen, peek at
            // centre) so the translateX reset is an invisible hand-off, not a snap.
            translateX.value = withTiming(
              -(screenWidthSV.value + SWIPE_OFFSCREEN_PAD),
              { duration: EXIT_DURATION },
              (finished) => {
                'worklet';
                if (finished) runOnJS(commitAtEnd)('next');
              },
            );
          }
        } else if (offset > SWIPE_THRESHOLD && canSwipePreviousSV.value) {
          if (skipAnimation) {
            translateX.value = 0;
            runOnJS(commitImmediate)('previous');
          } else {
            isAnimating.value = true;
            translateX.value = withTiming(
              screenWidthSV.value + SWIPE_OFFSCREEN_PAD,
              { duration: EXIT_DURATION },
              (finished) => {
                'worklet';
                if (finished) runOnJS(commitAtEnd)('previous');
              },
            );
          }
        } else {
          translateX.value = skipAnimation ? 0 : withSpring(0, springs.interactive);
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
    // Declare the swipe Pan simultaneous with the surrounding RNGH ScrollView so a
    // horizontal swipe runs without the scroll cancelling it, while a vertical drag
    // (the Pan fails on its direction-lock) still reaches the scroll. The plain RN
    // ScrollView the play route briefly used after the gorhom removal wasn't in
    // RNGH's tree, so this Pan had no peer to negotiate with and went dead.
    return scrollRef ? pan.simultaneousWithExternalGesture(scrollRef) : pan;
  }, [
    canSwipeNextSV,
    canSwipePreviousSV,
    boardWidthSV,
    screenWidthSV,
    translateX,
    isAnimating,
    hasTriggeredHaptic,
    isZoomedSV,
    enabledSV,
    reduceMotionSV,
    directionLock,
    startTouchX,
    startTouchY,
    scrollRef,
  ]);

  return { gesture, translateX, isAnimating };
}
