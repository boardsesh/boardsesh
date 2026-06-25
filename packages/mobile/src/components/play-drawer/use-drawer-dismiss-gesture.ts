import { useMemo, useRef, type ComponentType, type RefObject } from 'react';
import { Gesture, type GestureType } from 'react-native-gesture-handler';
import { useSharedValue, withSpring, runOnJS, type SharedValue } from 'react-native-reanimated';
import { springs } from '../../theme/animations';

// Pull-down-to-dismiss for the full-screen player route. The route is a native
// `transparentModal`; its built-in interactive dismiss lives OUTSIDE RNGH, so it
// could never negotiate with the board's swipe/pinch or the scroll — it only
// fired in the bare grabber region ("only works using the drag handle"). This
// RNGH Pan lives in the same gesture tree as the scroll + board, so it can yield
// to them and drive a dismiss from the WHOLE surface. The route sets
// `gestureEnabled: false`; dismissal is `router.dismiss()` past the threshold.
//
// Key wiring: the Pan is an ANCESTOR of the RNGH ScrollView, so it MUST declare
// `.simultaneousWithExternalGesture(scrollRef)` — otherwise the native scroll
// wins the gesture by default and the dismiss only fires in the gaps (the
// "can't dismiss easily" bug). It activates on a downward drag (`activeOffsetY`)
// and bails on a horizontal one (`failOffsetX`) so the carousel keeps L/R
// swipes. To avoid a jump when a scroll-to-top rolls into a dismiss, it only
// engages when the gesture BEGAN at the top of the scroll. `failOffsetX` alone
// isn't enough during fast climb-swapping — the carousel goes inert while a fling
// settles, so a fresh downward touch reaches this Pan; we also hard-block it
// whenever the carousel's swipe offset is non-zero or a fling is in progress.

/** Downward travel (px) before the dismiss activates. */
const DISMISS_ACTIVATE_OFFSET = 14;
/** Horizontal travel (px) that bails to the carousel instead. */
const DISMISS_FAIL_OFFSET_X = 24;
/** Drag distance (px) that commits a dismiss on release. */
const DISMISS_DISTANCE_THRESHOLD = 110;
/** Downward fling velocity (px/s) that commits a dismiss even on a short drag. */
const DISMISS_VELOCITY_THRESHOLD = 600;

type UseDrawerDismissGestureOptions = {
  /** Dismiss the route (e.g. `router.dismiss`). */
  onDismiss: () => void;
  /** Live scroll offset of the drawer's ScrollView. The dismiss only engages when
   *  the gesture starts at the very top (<= 0); anywhere else it's a scroll. */
  scrollYSV: SharedValue<number>;
  /** RNGH ref to that ScrollView so this ancestor Pan runs simultaneously with it
   *  (without it the native scroll wins by default and the dismiss barely fires).
   *  Typed as RNGH's GestureRef shape so the method call needs no cast. */
  scrollRef?: RefObject<ComponentType | undefined | null>;
  /** The carousel's horizontal swipe offset. Non-zero while a L/R swipe is dragging
   *  or mid-fling — we block the vertical dismiss for that whole window so a downward
   *  drift during fast climb-swapping can't accidentally pull the drawer down. */
  swipeTranslateX?: SharedValue<number>;
  /** The carousel's fling-in-progress flag. True while a thrown swipe is still
   *  settling (the carousel is inert then, so a fresh downward touch would otherwise
   *  reach this dismiss) — block the dismiss until it clears. */
  swipeIsAnimating?: SharedValue<boolean>;
};

type UseDrawerDismissGestureReturn = {
  gesture: GestureType;
  /** Drawer translateY to apply for the rubber-band drag. */
  translateY: SharedValue<number>;
};

export function useDrawerDismissGesture({
  onDismiss,
  scrollYSV,
  scrollRef,
  swipeTranslateX,
  swipeIsAnimating,
}: UseDrawerDismissGestureOptions): UseDrawerDismissGestureReturn {
  const translateY = useSharedValue(0);
  const isDismissing = useSharedValue(false);
  // Captured at touch-down: only a gesture that STARTS at the top can dismiss, so
  // a scroll-up that reaches the top doesn't suddenly yank the drawer down.
  const startedAtTop = useSharedValue(false);

  // Captured ONCE by the gesture memo — must only close over the ref so a later
  // render's onDismiss is still reached (mirrors use-carousel-gesture).
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const commitDismiss = () => {
    onDismissRef.current();
  };

  const gesture = useMemo(() => {
    const pan = Gesture.Pan()
      // A 2-finger pinch must never read as a dismiss — fail the moment a second
      // finger lands so zoom stays with the board's pinch gesture.
      .maxPointers(1)
      // Activate on a downward drag; bail on a horizontal one so the carousel
      // keeps L/R swipes.
      .activeOffsetY([-DISMISS_ACTIVATE_OFFSET, DISMISS_ACTIVATE_OFFSET])
      .failOffsetX([-DISMISS_FAIL_OFFSET_X, DISMISS_FAIL_OFFSET_X])
      .onBegin(() => {
        'worklet';
        startedAtTop.value = scrollYSV.value <= 0;
      })
      .onUpdate((event) => {
        'worklet';
        if (isDismissing.value) return;
        // Once the carousel owns the gesture as a horizontal swipe (offset non-zero)
        // or is still settling a fling, block the vertical dismiss entirely — a
        // downward drift while quickly swapping climbs must not pull the drawer down.
        // Guard via `?? 0` so an absent shared value reads as "no swipe", not as a
        // permanent block (`undefined !== 0` is true).
        if ((swipeTranslateX?.value ?? 0) !== 0 || swipeIsAnimating?.value === true) {
          translateY.value = 0;
          return;
        }
        // Follow the finger only when the gesture began at the top and is heading
        // down; otherwise it's a scroll (the ScrollView, running simultaneously,
        // handles it) and the drawer stays put.
        translateY.value = startedAtTop.value && event.translationY > 0 ? event.translationY : 0;
      })
      .onEnd((event) => {
        'worklet';
        // Same guard as onUpdate, and it must run BEFORE the velocity check: a fast
        // horizontal flick carries vertical velocity, so without this an accidental
        // down-component could satisfy velocityY > threshold and commit a dismiss
        // even though translateY was pinned at 0.
        if ((swipeTranslateX?.value ?? 0) !== 0 || swipeIsAnimating?.value === true) {
          translateY.value = withSpring(0, springs.interactive);
          return;
        }
        const committed =
          startedAtTop.value &&
          (translateY.value > DISMISS_DISTANCE_THRESHOLD || event.velocityY > DISMISS_VELOCITY_THRESHOLD);
        if (committed) {
          // Hand off to the native route's slide-out; leave translateY where it is
          // so the dismiss continues from the dragged position.
          isDismissing.value = true;
          runOnJS(commitDismiss)();
        } else {
          translateY.value = withSpring(0, springs.interactive);
        }
      })
      // The route normally unmounts after a committed dismiss, but a
      // dismiss/re-navigate race on this live-behind `transparentModal` could
      // leave the gesture alive with `isDismissing` stuck true — `onUpdate` would
      // then early-return forever and the drawer could never be dragged again.
      // Reset on finalize so the next drag always starts clean. (translateY is
      // left as-is so a committed dismiss keeps sliding from the dragged offset.)
      .onFinalize(() => {
        'worklet';
        isDismissing.value = false;
      });
    return scrollRef ? pan.simultaneousWithExternalGesture(scrollRef) : pan;
  }, [translateY, isDismissing, startedAtTop, scrollYSV, scrollRef, swipeTranslateX, swipeIsAnimating]);

  return { gesture, translateY };
}
