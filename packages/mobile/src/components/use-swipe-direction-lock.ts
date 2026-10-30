import { useMemo } from 'react';
import { Gesture } from 'react-native-gesture-handler';
import { useSharedValue } from 'react-native-reanimated';
import { SWIPE_DIRECTION_LOCK } from './swipe-action-model';

/** A gesture the row's swipe must wait on (`requireExternalGestureToFail`).
 * ReanimatedSwipeable's pan has no vertical bail: on a long scroll the thumb's
 * sideways drift adds up past the activation offset, the pan activates, steals
 * the touch from the list (the scroll stops dead) and slides the row open.
 *
 * This guard decides the touch's direction once. Sideways first: it fails and
 * the swipe runs as before. Vertical first: it stays undecided until the finger
 * lifts and then ends, which cancels the waiting swipe. It never activates, so
 * it never takes the touch from the list. */
export function useSwipeDirectionLock() {
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const scrolling = useSharedValue(false);
  return useMemo(
    () =>
      Gesture.Manual()
        .onTouchesDown((event) => {
          const touch = event.allTouches[0];
          if (!touch) return;
          startX.value = touch.absoluteX;
          startY.value = touch.absoluteY;
          scrolling.value = false;
        })
        .onTouchesMove((event, manager) => {
          const touch = event.allTouches[0];
          if (!touch || scrolling.value) return;
          const travelX = Math.abs(touch.absoluteX - startX.value);
          const travelY = Math.abs(touch.absoluteY - startY.value);
          if (travelY >= SWIPE_DIRECTION_LOCK && travelY >= travelX) {
            scrolling.value = true;
          } else if (travelX >= SWIPE_DIRECTION_LOCK && travelX > travelY) {
            manager.fail();
          }
        })
        .onTouchesUp((_event, manager) => {
          manager.end();
        })
        .onTouchesCancelled((_event, manager) => {
          manager.end();
        }),
    [startX, startY, scrolling],
  );
}
