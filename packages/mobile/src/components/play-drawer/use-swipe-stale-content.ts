import {
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type AnimatedStyle,
} from 'react-native-reanimated';
import type { ViewStyle } from 'react-native';
import { timing } from '../../theme/animations';
import type { SwipePager } from './use-swipe-pager';

/** What the pager says about the swipe, for the content below the board. */
export type StaleContentInput = {
  translateX: number;
  slideWidth: number;
  flingDirection: number;
  processedStep: number;
  uiSteps: number;
};

/**
 * How much of the content under the board to show (`opacity`), and whether it
 * follows the finger frame by frame (`follows`) or fades to its new value.
 *
 * That content (the Logbook line's "1 send · sent at 35°") belongs to the climb
 * the JS thread last rendered. The header changes climb halfway through a
 * swipe; the content cannot change before the JS thread renders the step, which
 * on an iPhone 17 Pro came up to 167 ms after the board had changed. So:
 *
 * - while the board moves, it fades with the outgoing header: out over the first
 *   half of the swipe, and back as a cancelled swipe returns;
 * - once a committed swipe has landed, it stays hidden until the JS thread has
 *   rendered that step: what it says is about the climb that left;
 * - once rendered, it fades back in, already about the climb on the header.
 */
export function staleContentFrame({
  translateX,
  slideWidth,
  flingDirection,
  processedStep,
  uiSteps,
}: StaleContentInput): { opacity: number; follows: boolean } {
  'worklet';
  const rendered = processedStep === uiSteps;
  if (rendered && flingDirection !== 0) return { opacity: 1, follows: false };
  if (!rendered && flingDirection === 0) return { opacity: 0, follows: false };
  const progress = slideWidth > 0 ? Math.min(1, Math.abs(translateX) / slideWidth) : 0;
  return { opacity: 1 - Math.min(1, progress * 2), follows: true };
}

/** The opacity `staleContentFrame` asks for, as an animated style on the UI thread. */
export function useSwipeStaleContentStyle(pager: SwipePager): AnimatedStyle<ViewStyle> {
  const { translateX, slideWidth, flingDirection, jsState, uiSteps } = pager;
  const opacity = useSharedValue(1);
  // When the fade under way ends (`Date.now()` on the UI thread); 0 for none.
  const fadeEndsAt = useSharedValue(0);
  useAnimatedReaction(
    () =>
      staleContentFrame({
        translateX: translateX.value,
        slideWidth: slideWidth.value,
        flingDirection: flingDirection.value,
        processedStep: jsState.value.processedStep,
        uiSteps: uiSteps.value,
      }),
    (frame, previous) => {
      if (previous === null) {
        opacity.value = frame.opacity;
        return;
      }
      const now = Date.now();
      // A new target from a gate (the step landed, or rendered): fade to it.
      // Only a change of target starts one: a fling moves every frame, and
      // restarting the fade on each one would never let it finish.
      if ((!frame.follows || !previous.follows) && frame.opacity !== previous.opacity) {
        fadeEndsAt.value = now + timing.fast;
        opacity.value = withTiming(frame.opacity, { duration: timing.fast });
        return;
      }
      if (!frame.follows) return;
      // Following the board. A fade still under way carries on to where the
      // board now puts it, in the time it had left, rather than jumping there.
      const left = fadeEndsAt.value - now;
      opacity.value = left > 0 ? withTiming(frame.opacity, { duration: left }) : frame.opacity;
    },
  );
  return useAnimatedStyle(() => ({ opacity: opacity.value }));
}
