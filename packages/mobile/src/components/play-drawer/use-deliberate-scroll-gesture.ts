import { useCallback, useEffect, useMemo, useRef, type ComponentType, type RefObject } from 'react';
import { Gesture, type GestureType } from 'react-native-gesture-handler';
import { runOnJS, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { DIRECTION_THRESHOLD, VERTICAL_LOCK_RATIO } from '@boardsesh/play-view';

/** Initial travel before each native vertical scroll can take the touch. */
const SCROLL_ACTIVATION_DISTANCE = 24;

type UseDeliberateScrollGestureOptions = {
  scrollRef: RefObject<ComponentType | undefined | null>;
  scrollYSV: SharedValue<number>;
  isPane: boolean;
  /** Mount below-fold content even when there is not yet enough to scroll. */
  onScrollIntent?: () => void;
};

// This Pan never activates. The native ScrollView waits for it to fail, which
// happens once the user has made a deliberate vertical drag. Failing releases
// the existing native scroll recognizer, preserving its scrolling and momentum.
export function useDeliberateScrollGesture({
  scrollRef,
  scrollYSV,
  isPane,
  onScrollIntent,
}: UseDeliberateScrollGestureOptions): GestureType {
  const isPaneSV = useSharedValue(isPane);
  useEffect(() => {
    isPaneSV.value = isPane;
  }, [isPane, isPaneSV]);

  const startTouchX = useSharedValue(0);
  const startTouchY = useSharedValue(0);
  const startedAtTop = useSharedValue(false);
  const verticalLocked = useSharedValue(false);
  const hasReportedScrollIntent = useSharedValue(false);
  const onScrollIntentRef = useRef(onScrollIntent);
  onScrollIntentRef.current = onScrollIntent;
  const reportScrollIntent = useCallback(() => {
    onScrollIntentRef.current?.();
  }, []);

  return useMemo(
    () =>
      Gesture.Pan()
        .manualActivation(true)
        .maxPointers(1)
        .blocksExternalGesture(scrollRef)
        .onTouchesDown((event, state) => {
          'worklet';
          verticalLocked.value = false;
          hasReportedScrollIntent.value = false;
          if (event.allTouches.length !== 1) {
            state.fail();
            return;
          }
          const touch = event.allTouches[0];
          startTouchX.value = touch.absoluteX;
          startTouchY.value = touch.absoluteY;
          startedAtTop.value = scrollYSV.value <= 0;
        })
        .onTouchesMove((event, state) => {
          'worklet';
          if (event.allTouches.length !== 1) {
            state.fail();
            return;
          }
          const touch = event.allTouches[0];
          const deltaX = Math.abs(touch.absoluteX - startTouchX.value);
          const deltaY = touch.absoluteY - startTouchY.value;
          const absoluteDeltaY = Math.abs(deltaY);
          if (!verticalLocked.value) {
            if (deltaX <= DIRECTION_THRESHOLD && absoluteDeltaY <= DIRECTION_THRESHOLD) return;
            if (absoluteDeltaY < deltaX * VERTICAL_LOCK_RATIO) {
              state.fail();
              return;
            }
            // Route dismissal keeps its existing activation distance. A pane
            // has no downward dismissal, so it retains the scroll threshold.
            if (!isPaneSV.value && startedAtTop.value && deltaY > 0) {
              state.fail();
              return;
            }
            verticalLocked.value = true;
          }
          if (absoluteDeltaY >= SCROLL_ACTIVATION_DISTANCE) {
            if (!hasReportedScrollIntent.value) {
              hasReportedScrollIntent.value = true;
              runOnJS(reportScrollIntent)();
            }
            state.fail();
          }
        })
        .onTouchesUp((_event, state) => {
          'worklet';
          state.fail();
        })
        .onTouchesCancelled((_event, state) => {
          'worklet';
          state.fail();
        })
        .onFinalize(() => {
          'worklet';
          verticalLocked.value = false;
          hasReportedScrollIntent.value = false;
          startedAtTop.value = false;
          startTouchX.value = 0;
          startTouchY.value = 0;
        }),
    [
      isPaneSV,
      scrollRef,
      scrollYSV,
      startTouchX,
      startTouchY,
      startedAtTop,
      verticalLocked,
      hasReportedScrollIntent,
      reportScrollIntent,
    ],
  );
}
